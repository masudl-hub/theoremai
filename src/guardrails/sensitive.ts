import { blobAt, type RedactSpan, spansFromPatterns } from '../observability/spans.ts';
import { CREDENTIAL_RULES, GLOBAL_ALLOWLIST } from './credential-rules.ts';
import { type CredentialRule, credentialHit, credentialSpans } from './credential-scan.ts';

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
/** Credentials gitleaks' rules miss: keys cut short or spaced out, a short private key, and a bare bearer token. */
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
];

/** Every credential rule: gitleaks', then Theorem's own. */
const CREDENTIALS: readonly CredentialRule[] = [...CREDENTIAL_RULES, ...OWN_CREDENTIAL_RULES];

const CARD_CANDIDATE = /\b(?:\d[\s.-]*?){13,19}\b/g;

/**
 * The families of sensitive data, each switched on its own: a profile can
 * redact credentials and card numbers but leave network addresses alone.
 */
const SENSITIVE_GROUPS = ['ids', 'financial', 'network', 'credentials'] as const;

/** A group of sensitive-value checks: ids, financial, network or credentials. */
type SensitiveGroup = (typeof SENSITIVE_GROUPS)[number];

/** Per group, whether it runs. A group left out keeps its default. */
type SensitiveSwitches = Partial<Record<SensitiveGroup, boolean>>;

/** `true` runs every group, `false` none; an object switches the groups it names. */
type SensitiveSelection = boolean | SensitiveSwitches;

/** Every group's switch, defaults applied. */
type SensitiveGroups = Readonly<Record<SensitiveGroup, boolean>>;

/** The patterns each group matches. Card numbers are financial too, found by `cardSpans`; credentials by `credentialSpans`. */
const GROUP_PATTERNS: Readonly<Record<Exclude<SensitiveGroup, 'credentials'>, readonly RegExp[]>> =
  {
    ids: [SSN, SSN_CONTEXTUAL, ITIN, EIN],
    financial: [IBAN],
    network: [IPV4, IPV6],
  };

interface SensitivePattern {
  group: SensitiveGroup;
  pattern: RegExp;
  /** Whether a match at `at` of `text` counts. */
  hit?: (match: string, text: string, at: number) => boolean;
}

/** Every pattern, with its group. */
const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  ...(['ids', 'financial', 'network'] as const).flatMap((group) =>
    GROUP_PATTERNS[group].map((pattern) => ({ group, pattern })),
  ),
  ...CREDENTIALS.map((rule) => ({
    group: 'credentials' as const,
    pattern: new RegExp(rule.pattern.source, `${rule.pattern.flags}g`),
    hit: (match: string, text: string, at: number) =>
      credentialHit(rule, GLOBAL_ALLOWLIST, match, text, at),
  })),
];

const ALL_GROUPS: SensitiveGroups = {
  ids: true,
  financial: true,
  network: true,
  credentials: true,
};

/** `selection` with the groups it leaves out taken from `defaults`. */
function resolveSensitive(
  selection: SensitiveSelection | undefined,
  defaults: SensitiveGroups = ALL_GROUPS,
): SensitiveGroups {
  if (selection === undefined) return defaults;
  if (typeof selection === 'boolean') {
    return { ids: selection, financial: selection, network: selection, credentials: selection };
  }
  return { ...defaults, ...selection };
}

/** Whether any group runs. */
function anySensitive(groups: SensitiveGroups): boolean {
  return SENSITIVE_GROUPS.some((group) => groups[group]);
}

const LUHN_DOUBLE = 2;
const LUHN_NINE = 9;
const LUHN_TEN = 10;
const CARD_MIN_DIGITS = 13;
const CARD_MAX_DIGITS = 19;

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

/** A card-number candidate that is a card: 13–19 digits passing the Luhn check. */
function cardHit(blob: string): boolean {
  const digits = blob.replaceAll(/[^\d]/g, '');
  const inRange = digits.length >= CARD_MIN_DIGITS && digits.length <= CARD_MAX_DIGITS;
  return inRange && luhnOk(digits);
}

function cardSpans(text: string): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const found = blobAt(match);
    if (found && cardHit(found.blob)) {
      spans.push({ start: found.index, end: found.index + found.blob.length, kind: 'sensitive' });
    }
  }
  return spans;
}

/** Sensitive-data spans in `text`, from the groups `selection` runs (every group by default). */
function sensitiveSpans(text: string, selection: SensitiveSelection = true): RedactSpan[] {
  const groups = resolveSensitive(selection);
  const patterns = (['ids', 'financial', 'network'] as const).flatMap((group) =>
    groups[group] ? GROUP_PATTERNS[group] : [],
  );
  return [
    ...spansFromPatterns(text, patterns, 'sensitive'),
    ...(groups.financial ? cardSpans(text) : []),
    ...(groups.credentials ? credentialSpans(text, CREDENTIALS, GLOBAL_ALLOWLIST) : []),
  ];
}

export type {
  SensitiveGroup,
  SensitiveGroups,
  SensitivePattern,
  SensitiveSelection,
  SensitiveSwitches,
};
export {
  anySensitive,
  CARD_CANDIDATE,
  cardHit,
  resolveSensitive,
  SENSITIVE_GROUPS,
  SENSITIVE_PATTERNS,
  sensitiveSpans,
};
