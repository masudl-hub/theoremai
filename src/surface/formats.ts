import { sensitiveSpans } from '../guardrails/sensitive.ts';
import { applySpans } from '../observability/spans.ts';

const MASK = '••••';

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

/** A URL with its credential query parameters and `user:pass@` masked. */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.replace(/[?&;][^?&;#\s]*/g, (pair) => {
      const at = pair.indexOf('=');
      const name = pair.slice(1, at);
      return at > 1 && at < pair.length - 1 && QUERY_CREDENTIAL.test(name)
        ? `${pair.slice(0, at + 1)}${MASK}`
        : pair;
    });
  }
  const credentials = [...new Set(url.searchParams.keys())].filter((name) =>
    CREDENTIAL_NAME.test(name),
  );
  if (!url.username && !url.password && credentials.length === 0) return raw;
  if (url.username) url.username = MASK;
  if (url.password) url.password = MASK;
  for (const name of credentials) url.searchParams.set(name, MASK);
  return url.href.replaceAll(encodeURIComponent(MASK), MASK);
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
    Object.entries(headers).map(([name, value]) => [
      name,
      CREDENTIAL_NAME.test(name) ? MASK : value,
    ]),
  );
  return typeof raw === 'string' ? JSON.stringify(masked) : masked;
}

/** Scrubs text: each known secret value by name, then the kernel's sensitive patterns. */
export function scrubText(text: string, known: readonly [string, string][]): string {
  let out = text;
  for (const [name, value] of known) {
    if (value.length >= SCRUB_MIN) out = out.replaceAll(value, `[secret ${name}]`);
  }
  return applySpans(out, sensitiveSpans(out));
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
