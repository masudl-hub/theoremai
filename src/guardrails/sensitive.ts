import { blobAt, type RedactSpan, spansFromPatterns } from '../observability/spans.ts';

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_CONTEXTUAL = /(?:SSN|social\s*security(?:\s*number)?)[:\s]+(?:\d[-\s]*){9}/gi;
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
const AWS_ACCESS = /\bAKIA[0-9A-Z]{16,20}\b/g;
const GOOGLE_API = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const OPENAI_KEY = /\bsk-\s*[A-Za-z0-9]{20,}\b/g;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g;
const OPENROUTER_KEY = /\bsk-or-[A-Za-z0-9_-]{20,}\b/g;
const GITHUB_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_TOKEN = /\bghp_[A-Za-z0-9]{36}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
/** Bounded payload so PEM redaction cannot ReDoS on repeated BEGIN markers. */
const PEM_KEY =
  /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,16384}?-----END (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----/g;
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

/** The patterns each group matches. Card numbers are financial too, found by `cardSpans`. */
const GROUP_PATTERNS: Readonly<Record<SensitiveGroup, readonly RegExp[]>> = {
  ids: [SSN, SSN_CONTEXTUAL, ITIN, EIN],
  financial: [IBAN],
  network: [IPV4, IPV6],
  credentials: [
    AWS_ACCESS,
    GOOGLE_API,
    OPENAI_KEY,
    ANTHROPIC_KEY,
    OPENROUTER_KEY,
    GITHUB_PAT,
    GITHUB_TOKEN,
    SLACK_TOKEN,
    BEARER,
    PEM_KEY,
  ],
};

/** Every pattern, with its group. */
const SENSITIVE_PATTERNS: readonly { group: SensitiveGroup; pattern: RegExp }[] =
  SENSITIVE_GROUPS.flatMap((group) => GROUP_PATTERNS[group].map((pattern) => ({ group, pattern })));

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
  const patterns = SENSITIVE_GROUPS.flatMap((group) =>
    groups[group] ? GROUP_PATTERNS[group] : [],
  );
  const spans = spansFromPatterns(text, patterns, 'sensitive');
  return groups.financial ? [...spans, ...cardSpans(text)] : spans;
}

export type { SensitiveGroup, SensitiveGroups, SensitiveSelection, SensitiveSwitches };
export {
  anySensitive,
  CARD_CANDIDATE,
  cardHit,
  resolveSensitive,
  SENSITIVE_GROUPS,
  SENSITIVE_PATTERNS,
  sensitiveSpans,
};
