import { blobAt, type RedactSpan } from '../observability/spans.ts';
import { recordOf } from './boundaries.ts';
import { CREDENTIAL_RULES, GLOBAL_ALLOWLIST } from './credential-rules.ts';
import { type CredentialRule, credentialHit, credentialSpans } from './credential-scan.ts';
import {
  SENSITIVE_GROUPS,
  type SensitiveGroup,
  type SensitiveGroups,
  type SensitiveSelection,
} from './sensitive-groups.ts';

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_CONTEXTUAL = /(?:SSN|social\s*security(?:\s*number)?)[:\s]+\d(?:[-\s]*\d){8}/gi;
const ITIN = /\b9\d{2}-\d{2}-\d{4}\b/g;
const EIN = /\b\d{2}-\d{7}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{13,30}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
const HEX_GROUP = '[0-9a-f]{1,4}';
const DOTTED_QUAD =
  '(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)';
/** Every RFC 4291 text form: full, `::`-compressed, and with a dotted IPv4 tail. */
const IPV6_FORMS = [
  `(?:${HEX_GROUP}:){6}${DOTTED_QUAD}`,
  `(?:${HEX_GROUP}:){1,5}:${DOTTED_QUAD}`,
  `::(?:${HEX_GROUP}:){0,5}${DOTTED_QUAD}`,
  `(?:${HEX_GROUP}:){7}${HEX_GROUP}`,
  `(?:${HEX_GROUP}:){1,6}(?::${HEX_GROUP}){1,6}`,
  `(?:${HEX_GROUP}:){1,7}:`,
  `:(?::${HEX_GROUP}){1,7}`,
];
const IPV6 = new RegExp(`(?<![\\w:.])(?:${IPV6_FORMS.join('|')})(?![\\w:])`, 'gi');

/**
 * An email address, in ASCII: Unicode letters would grow the stream's automata past what the
 * bundle carries. Its match starts only where a run of local-part characters does, so a long run
 * with no `@` is read once, not once per character.
 */
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** A top-level domain starts with a letter: `typescript@4.4.4` is a package's version, not an address. */
const EMAIL_TLD = /\.[A-Za-z][\w-]*$/;

const PHONE_SEP = '[ .\\-]';
const PHONE_EXTENSION = '(?:\\s?(?:x|ext\\.?)\\s?\\d{1,5})?';
/** Phone numbers by shape: international with `+`, North American, national with a leading 0, and a short area code in brackets. */
const PHONE_SHAPES = [
  new RegExp(
    `(?<![\\w+])\\+\\s?[1-9]\\d{0,2}(?:\\s?\\(0\\))?(?:${PHONE_SEP}?\\(?\\d{1,4}\\)?){2,5}${PHONE_EXTENSION}(?!\\w)`,
    'g',
  ),
  new RegExp(
    `(?<![\\w.\\-+])(?:(?:00)?1${PHONE_SEP})?(?:\\(\\d{3}\\)\\s?|\\d{3}${PHONE_SEP})\\d{3}${PHONE_SEP}\\d{4}${PHONE_EXTENSION}(?![\\w\\-]|\\.\\d)`,
    'g',
  ),
  new RegExp(
    `(?<![\\w.\\-+]|\\d[ .\\-])0\\d{1,4}(?:${PHONE_SEP}\\d{2,4}){2,5}(?![\\w\\-]|\\.\\d)`,
    'g',
  ),
  new RegExp(
    `(?<![\\w)]|\\d[ .\\-])\\(0\\d{1,3}\\)${PHONE_SEP}?\\d{3,4}${PHONE_SEP}?\\d{4}(?![\\w\\-]|\\.\\d)`,
    'g',
  ),
];
/** A number of any shape after a phone label, in English, French, German, Spanish, Italian, or Portuguese. */
const PHONE_LABELLED =
  /(?<!\p{L})(?:phone|tel(?:ephone|efone|efono|éfono)?|téléphone|mobile|cell(?:ular)?|portable|handy|celular|whatsapp|fax)(?:[\s_]*(?:number|no\.?|nr\.?|#|numéro|número|numero|nummer))?[\s"'`*:=>]*(\+?\(?\d[\d ().-]{5,20}\d)/giu;
/** An SSN (3-2-4, 3-3-3) or a date (dd.mm.yyyy, yyyy-mm-dd): a phone's shape, not a phone. */
const NOT_PHONE =
  /^(?:\d{3}[- ]\d{2}[- ]\d{4}|\d{3} \d{3} \d{3}|\d{1,2}[.\-/ ]\d{1,2}[.\-/ ]\d{4}|\d{4}[.\-/ ]\d{1,2}[.\-/ ]\d{1,2})$/;
const PHONE_DIGITS_MIN = 7;
const PHONE_DIGITS_MAX = 15;

/** Whether `number` is a phone: not an SSN or a date, with as many digits as E.164 allows, its extension aside. */
function phoneHit(number: string): boolean {
  if (NOT_PHONE.test(number.trim())) return false;
  const digits = number.replace(/(?:x|ext\.?)\s?\d+$/i, '').replace(/\D/g, '').length;
  return digits >= PHONE_DIGITS_MIN && digits <= PHONE_DIGITS_MAX;
}

/** A label naming a bank account, or any account number, in English, German, Italian, Portuguese, French, Spanish, or Dutch. */
const ACCOUNT_LABEL = [
  'bank[\\s_\\-]{0,3}account(?:[\\s_]{0,3}(?:number|no\\.?|#|nr\\.?))?',
  'account[\\s_]{0,3}(?:number|no\\.?|#|nr\\.?)',
  'acct\\.?(?:[\\s_]{0,3}(?:number|no\\.?|#))?',
  'a\\/c(?:[\\s_]{0,3}no\\.?)?(?!\\p{L})',
  'bban',
  'routing[\\s_]{0,3}(?:number|no\\.?|#)?',
  'aba(?:[\\s_]{0,3}(?:number|routing))?',
  'sort[\\s_]{0,3}code',
  'kontonummer',
  'bankverbindung(?:snummer)?',
  'konto',
  'numero[\\s_]{0,3}di[\\s_]{0,3}conto(?:[\\s_]{0,3}corrente)?',
  'conto[\\s_]{0,3}corrente',
  'n[úu]mero[\\s_]{0,3}da[\\s_]{0,3}conta(?:[\\s_]{0,3}corrente)?',
  'conta[\\s_]{0,3}corrente',
  'num[ée]ro[\\s_]{0,3}de[\\s_]{0,3}compte(?:[\\s_]{0,3}bancaire)?',
  'compte[\\s_]{0,3}bancaire',
  'n[úu]mero[\\s_]{0,3}de[\\s_]{0,3}cuenta',
  'cuenta[\\s_]{0,3}bancaria',
  'rekeningnummer',
].join('|');
/** An account number after its label: a short aside, a parenthesis, or a field type may sit between. */
const BANK_ACCOUNT = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${ACCOUNT_LABEL})(?:\\s{1,4}type="\\w+")?(?:\\s{0,4}\\([^)\\n]{1,24}\\))?[\\s"'\x60:=>*#]{0,8}(?:[a-z\\s]{0,12}[:\\s])?\\s{0,4}([A-Z0-9][A-Z0-9\\-]{3,32}[A-Z0-9])`,
  'giu',
);
const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const ACCOUNT_DIGITS_MIN = 5;

/** The labelled value of a match of `pattern`. */
function labelled(pattern: RegExp, match: string): string | undefined {
  return new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(match)?.[1];
}

/** Whether a labelled account number is one: enough digits to be a number, and not an IBAN, which is `financial`'s. */
function accountHit(match: string): boolean {
  const value = labelled(BANK_ACCOUNT, match);
  return (
    value !== undefined &&
    !IBAN_SHAPE.test(value) &&
    (value.match(/\d/g) ?? []).length >= ACCOUNT_DIGITS_MIN
  );
}
/** Credentials gitleaks' rules miss: keys cut short or spaced out, a short private key, a bare bearer token, and vendor formats gitleaks has no rule for. */
const OWN_CREDENTIAL_RULES: readonly CredentialRule[] = [
  {
    id: 'openai-api-key-any',
    pattern: /\bsk-\s*[A-Za-z0-9]{20,}\b/,
    keywords: ['sk-'],
    allowlists: [],
  },
  {
    id: 'anthropic-api-key-any',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    keywords: ['sk-ant-'],
    allowlists: [],
  },
  {
    id: 'openrouter-api-key',
    pattern: /\bsk-or-[A-Za-z0-9_-]{20,}\b/,
    keywords: ['sk-or-'],
    allowlists: [],
  },
  {
    id: 'github-fine-grained-pat-any',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    keywords: ['github_pat_'],
    allowlists: [],
  },
  {
    id: 'slack-token-any',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    keywords: ['xox'],
    allowlists: [],
  },
  {
    id: 'private-key-any',
    pattern:
      /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,16384}?-----END (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----/,
    keywords: ['-----begin'],
    allowlists: [],
  },
  {
    id: 'bearer-token',
    pattern: /\bBearer[ \t]+([A-Za-z0-9._~+/-]{16,}=*)/i,
    entropy: 3,
    keywords: ['bearer'],
    allowlists: [],
  },
  {
    id: 'apify-api-token',
    pattern: /\bapify_api_[A-Za-z0-9]{36}\b/,
    keywords: ['apify_api_'],
    allowlists: [],
  },
  {
    id: 'fleetbase-api-key',
    pattern: /\bflb_live_[A-Za-z0-9]{20}\b/,
    keywords: ['flb_live_'],
    allowlists: [],
  },
  {
    id: 'nightfall-api-key',
    pattern: /\bNF-[A-Za-z0-9]{32}\b/,
    keywords: ['nf-'],
    allowlists: [],
  },
  {
    id: 'teamwork-api-token',
    pattern: /\btkn\.v1_[A-Za-z0-9]{71}=/,
    keywords: ['tkn.v1_'],
    allowlists: [],
  },
  {
    id: 'ubidots-api-token',
    pattern: /\bBBFF-[A-Za-z0-9]{30}\b/,
    keywords: ['bbff-'],
    allowlists: [],
  },
  {
    id: 'zapier-webhook-url',
    pattern: /https:\/\/hooks\.zapier\.com\/hooks\/catch\/\d+\/[A-Za-z0-9]+\/?/,
    keywords: ['hooks.zapier.com'],
    allowlists: [],
  },
];

/** Every credential rule: gitleaks', then Theorem's own. */
const CREDENTIALS: readonly CredentialRule[] = [...CREDENTIAL_RULES, ...OWN_CREDENTIAL_RULES];

const CARD_CANDIDATE = /\b(?:\d[\s.-]*?){13,19}\b/g;

interface SensitivePattern {
  group: SensitiveGroup;
  pattern: RegExp;
  /** Whether a match at `at` of `text` counts; `lower` is `text` in lower case. */
  hit?: (match: string, text: string, at: number, lower?: () => string) => boolean;
}

type PatternGroup = Exclude<SensitiveGroup, 'credentials'>;

/** The groups found by patterns of their own; credentials are found by `credentialSpans`. */
const PATTERN_GROUPS = SENSITIVE_GROUPS.filter(
  (group): group is PatternGroup => group !== 'credentials',
);

/** The patterns each group matches. Card numbers are financial too, found by `cardSpans`. */
const GROUP_PATTERNS: Readonly<Record<PatternGroup, readonly Omit<SensitivePattern, 'group'>[]>> = {
  ids: [SSN, SSN_CONTEXTUAL, ITIN, EIN].map((pattern) => ({ pattern })),
  financial: [{ pattern: IBAN }],
  network: [{ pattern: IPV4 }, { pattern: IPV6 }],
  email: [{ pattern: EMAIL, hit: (match: string) => EMAIL_TLD.test(match) }],
  phone: [
    ...PHONE_SHAPES.map((pattern) => ({ pattern, hit: phoneHit })),
    {
      pattern: PHONE_LABELLED,
      hit: (match: string) => phoneHit(labelled(PHONE_LABELLED, match) ?? ''),
    },
  ],
  bank_account: [{ pattern: BANK_ACCOUNT, hit: accountHit }],
};

/** Every pattern, with its group. */
const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  ...PATTERN_GROUPS.flatMap((group) => GROUP_PATTERNS[group].map((entry) => ({ group, ...entry }))),
  ...CREDENTIALS.map((rule) => ({
    group: 'credentials' as const,
    pattern: new RegExp(rule.pattern.source, `${rule.pattern.flags}g`),
    hit: (match: string, text: string, at: number, lower?: () => string) =>
      credentialHit(rule, GLOBAL_ALLOWLIST, match, text, at, lower?.()),
  })),
];

const ALL_GROUPS: SensitiveGroups = recordOf(SENSITIVE_GROUPS, () => true);

/** `selection` with the groups it leaves out taken from `defaults`. */
function resolveSensitive(
  selection: SensitiveSelection | undefined,
  defaults: SensitiveGroups = ALL_GROUPS,
): SensitiveGroups {
  if (selection === undefined) return defaults;
  if (typeof selection === 'boolean') {
    return recordOf(SENSITIVE_GROUPS, () => selection);
  }
  return { ...defaults, ...selection };
}

const LUHN_DOUBLE = 2;
const LUHN_NINE = 9;
const LUHN_TEN = 10;

function luhnOk(digits: string): boolean {
  let sum = 0;
  let doubleIt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const ch = digits[i];
    if (ch === undefined) {
      return false;
    }
    let n = Number(ch);
    if (doubleIt) {
      n *= LUHN_DOUBLE;
      if (n > LUHN_NINE) {
        n -= LUHN_NINE;
      }
    }
    sum += n;
    doubleIt = !doubleIt;
  }
  return sum % LUHN_TEN === 0;
}

/** The numbers a card network issues: the leading digits, each a low–high range, and the lengths. */
interface CardNetwork {
  leading: readonly (readonly [low: string, high: string])[];
  lengths: readonly number[];
}

const LENGTHS_16_TO_19 = [16, 17, 18, 19];

/** Visa, Mastercard, American Express, Diners Club, Discover, JCB, UnionPay, Maestro, Mir, and RuPay, in that order. */
const CARD_NETWORKS: readonly CardNetwork[] = [
  { leading: [['4', '4']], lengths: [13, 16, 19] },
  {
    leading: [
      ['51', '55'],
      ['2221', '2720'],
    ],
    lengths: [16],
  },
  {
    leading: [
      ['34', '34'],
      ['37', '37'],
    ],
    lengths: [15],
  },
  {
    leading: [
      ['300', '305'],
      ['3095', '3095'],
      ['36', '36'],
      ['38', '39'],
    ],
    lengths: [14, 15, ...LENGTHS_16_TO_19],
  },
  {
    leading: [
      ['6011', '6011'],
      ['644', '649'],
      ['65', '65'],
    ],
    lengths: LENGTHS_16_TO_19,
  },
  { leading: [['3528', '3589']], lengths: LENGTHS_16_TO_19 },
  { leading: [['62', '62']], lengths: LENGTHS_16_TO_19 },
  {
    leading: [
      ['5018', '5018'],
      ['5020', '5020'],
      ['5038', '5038'],
      ['5893', '5893'],
      ['6304', '6304'],
      ['6759', '6759'],
      ['6761', '6763'],
    ],
    lengths: [13, 14, 15, ...LENGTHS_16_TO_19],
  },
  { leading: [['2200', '2204']], lengths: LENGTHS_16_TO_19 },
  {
    leading: [
      ['60', '60'],
      ['81', '82'],
      ['508', '508'],
      ['353', '353'],
      ['356', '356'],
    ],
    lengths: [16],
  },
];

/** Whether some card network issues numbers that start and run as long as `digits`. */
function isIssued(digits: string): boolean {
  return CARD_NETWORKS.some(
    (network) =>
      network.lengths.includes(digits.length) &&
      network.leading.some(([low, high]) => {
        const start = digits.slice(0, low.length);
        return start >= low && start <= high;
      }),
  );
}

const URL_SCHEME = /https?:\/\//i;
const URL_LOOKBACK = 2048;

/** Whether `at` of `text` is inside a web address: the unbroken run of characters before it holds `http://` or `https://`. */
function isInUrl(text: string, at: number): boolean {
  const floor = Math.max(0, at - URL_LOOKBACK);
  let from = at;
  while (from > floor && !/\s/.test(text[from - 1] ?? ' ')) from -= 1;
  return URL_SCHEME.test(text.slice(from, at));
}

/**
 * A card-number candidate at `at` of `text` that is a card: digits a card
 * network issues, passing the Luhn check, outside a web address. A run of
 * digits in an address is the address's own identifier: one random 19-digit
 * identifier in a hundred passes the first two tests.
 */
function cardHit(blob: string, text: string, at: number): boolean {
  const digits = blob.replaceAll(/[^\d]/g, '');
  return isIssued(digits) && luhnOk(digits) && !isInUrl(text, at);
}

function cardSpans(text: string): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const found = blobAt(match);
    if (found && cardHit(found.blob, text, found.index)) {
      spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'sensitive' });
    }
  }
  return spans;
}

/** Sensitive-data spans in `text`, from the groups `selection` runs (every group by default). */
function sensitiveSpans(text: string, selection: SensitiveSelection = true): RedactSpan[] {
  const groups = resolveSensitive(selection);
  const spans: RedactSpan[] = [];
  for (const { group, pattern, hit } of SENSITIVE_PATTERNS) {
    if (group === 'credentials' || !groups[group]) continue;
    for (const match of text.matchAll(pattern)) {
      const found = blobAt(match);
      if (found && (!hit || hit(found.blob, text, found.index))) {
        spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'sensitive' });
      }
    }
  }
  return [
    ...spans,
    ...(groups.financial ? cardSpans(text) : []),
    ...(groups.credentials ? credentialSpans(text, CREDENTIALS, GLOBAL_ALLOWLIST) : []),
  ];
}

export type { SensitivePattern };
export { CARD_CANDIDATE, cardHit, SENSITIVE_PATTERNS, sensitiveSpans };
