import { redactDetectors } from '../guardrails/detect-at.ts';
import { SENSITIVE_GROUPS } from '../guardrails/sensitive-groups.ts';

/** What stands in for a credential's value wherever one is shown. */
export const MASK = '••••';

/** Names that carry a credential, in a URL's query or a header. */
const CREDENTIAL_NAME =
  /auth|key|token|secret|passw|pwd|cookie|session|signature|^sig$|credential|^code$|appid/i;

/** Names a query parameter carries a credential under, in a URL too malformed to parse. */
const QUERY_CREDENTIAL = /auth|key|token|secret|passw|pwd|signature|credential|appid/i;

/** What a secret's prefix says it is. Nothing else about the value is told. */
const SECRET_KINDS: readonly [RegExp, string][] = [
  [/^AIza/, 'Google API key'],
  [/^sk-or-/, 'OpenRouter key'],
  [/^sk-ant-/, 'Anthropic key'],
  [/^sk-/, 'OpenAI key'],
  [/^(?:ghp_|github_pat_)/, 'GitHub token'],
  [/^xox[baprs]-/, 'Slack token'],
  [/^AKIA/, 'AWS access key id'],
  [/^eyJ[\w-]+\.[\w-]+\./, 'JWT'],
  [/^Bearer\s/i, 'a whole Bearer header, not a bare token'],
  [/^https?:\/\//i, 'a URL, not a key'],
];

/** Below this, a value is told as "short" and is too short to scrub safely. */
const SHORT = 16;
const SCRUB_MIN = 6;
const TEXT_CAP = 2000;
const BYTES_CAP = 200;

/** What an agent sees of a secret. */
export interface SecretCard {
  secret: true;
  set: boolean;
  looksLike?: string;
  /** Mistakes the value shows: whitespace, quotes, a line break, a placeholder. */
  problems: string[];
  /** Other secrets holding the same value. */
  sameAs: string[];
  usedBy: string[];
}

/** What an agent sees of a secret instead of its value: whether it is set, what kind it looks like, the mistakes it shows, and the other secrets with the same value and the places that use it. */
export function secretCard(
  value: unknown,
  extra: { sameAs?: readonly string[]; usedBy?: readonly string[] } = {},
): SecretCard {
  const text = typeof value === 'string' ? value : '';
  const core = text.trim();
  const problems: string[] = [];
  if (/^(?:<.*>|x{3,}|\.{3}|your[-_ ]?(?:api[-_ ]?)?key|changeme|todo)$/i.test(core)) {
    problems.push('a placeholder, not a real value');
  } else {
    if (core && core !== text) problems.push('spaces or a line break around it');
    if (/[\r\n]/.test(core)) problems.push('a line break inside');
    else if (/\s/.test(core)) problems.push('a space inside');
    if (/^(['"`]).*\1$/.test(core)) problems.push('wrapped in quotes');
    if (core && core.length < SHORT) problems.push('shorter than keys usually are');
  }
  const looksLike = SECRET_KINDS.find(([pattern]) => pattern.test(core))?.[1];
  return {
    secret: true,
    set: core.length > 0,
    ...(looksLike ? { looksLike } : {}),
    problems,
    sameAs: [...(extra.sameAs ?? [])],
    usedBy: [...(extra.usedBy ?? [])],
  };
}

/** A URL's `user:pass@`, after its scheme. */
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i;
/** One `name=value` of a URL, with the separator before it. */
const PAIR = /([?&;])([^=?&;#\s]*)=([^&;#\s]*)/g;

/** A `user:pass`, as its two parts. A password keeps its own colons. */
function userinfo(text: string): [user: string, password: string | undefined] {
  const at = text.indexOf(':');
  return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
}

function decoded(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** Whether a header or query parameter's name says it carries a credential: what `maskHeaders` masks. */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name);
}

/**
 * A URL with its credential query parameters and `user:pass@` masked. The rest stays as written:
 * a `{param}` in a tool's path is not encoded.
 */
export function maskUrl(raw: string): string {
  const names = URL.canParse(raw) ? CREDENTIAL_NAME : QUERY_CREDENTIAL;
  return raw
    .replace(USERINFO, (_whole, scheme: string, info: string) => {
      const [user, password] = userinfo(info);
      return `${scheme}${user && MASK}${password === undefined ? '' : `:${password && MASK}`}@`;
    })
    .replace(PAIR, (pair, separator: string, name: string, value: string) =>
      value && names.test(decoded(name)) ? `${separator}${name}=${MASK}` : pair,
    );
}

/**
 * A masked URL with each masked credential filled in from `held`, the URL it was masked from.
 * A mask `held` has no value for stays a mask.
 */
export function unmaskUrl(shown: string, held: string): string {
  const [user, password] = userinfo(USERINFO.exec(held)?.[2] ?? '');
  const values = new Map<string, string[]>();
  for (const [, , name = '', value = ''] of held.matchAll(PAIR)) {
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return shown
    .replace(USERINFO, (_whole, scheme: string, info: string) => {
      const [shownUser, shownPassword] = userinfo(info);
      const name = shownUser === MASK && user ? user : shownUser;
      const pass = shownPassword === MASK && password ? password : shownPassword;
      return `${scheme}${name}${pass === undefined ? '' : `:${pass}`}@`;
    })
    .replace(PAIR, (pair, separator: string, name: string, value: string) => {
      const real = value === MASK ? values.get(name)?.shift() : undefined;
      return real ? `${separator}${name}=${real}` : pair;
    });
}

/**
 * Masked headers with each masked value filled in from `held`, the headers they were masked from.
 * A mask `held` has no header for stays a mask.
 */
export function unmaskHeaders(
  shown: Record<string, string>,
  held: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(shown).map(([name, value]) => [
      name,
      value === MASK ? (held?.[name] ?? value) : value,
    ]),
  );
}

/**
 * Headers as JSON, credential-named values masked. Text that is not a JSON object is
 * told only by its length: a parse error would quote it.
 */
export function maskHeaders(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return raw;
  let headers: unknown = raw;
  if (typeof raw === 'string') {
    try {
      headers = JSON.parse(raw);
    } catch {
      return `(not a JSON object, ${String(raw.length)} characters)`;
    }
  }
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return '(not a JSON object)';
  }
  const masked = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, isCredentialName(name) ? MASK : value]),
  );
  return typeof raw === 'string' ? JSON.stringify(masked) : masked;
}

/** Scrubs text: each known secret value by name, then the kernel's sensitive patterns. */
export function scrubText(text: string, known: readonly [string, string][]): string {
  let out = text;
  for (const [name, value] of known) {
    if (value.length >= SCRUB_MIN) out = out.replaceAll(value, `[secret ${name}]`);
  }
  return redactDetectors(out, SENSITIVE_GROUPS);
}

/** Known secret values worth scrubbing: trimmed, long enough, longest first. */
export function knownSecrets(secrets: Record<string, string>): [string, string][] {
  return Object.entries(secrets)
    .map(([name, value]): [string, string] => [name, value.trim()])
    .filter(([, value]) => value.length >= SCRUB_MIN)
    .sort((a, b) => b[1].length - a[1].length);
}

/** Every string in `value` scrubbed and capped; long base64 under `data` told as bytes. */
export function scrubDeep(value: unknown, known: readonly [string, string][]): unknown {
  if (typeof value === 'string') {
    const text = scrubText(value, known);
    return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…(cut)` : text;
  }
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, known));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === 'data' && typeof inner === 'string' && inner.length > BYTES_CAP
          ? '(bytes)'
          : scrubDeep(inner, known),
      ]),
    );
  }
  return value;
}
