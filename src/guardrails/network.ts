/**
 * Network SSRF guardrails for HTTP tools, remote MCP tools, and OAuth.
 *
 * Enforces URL scheme safety and blocks loopback, private RFC 1918,
 * link-local (cloud metadata 169.254.x.x), and multicast targets unless
 * explicitly permitted by profile guardrail configuration. Every redirect
 * hop is checked the same way, and origin-bound headers never follow a
 * redirect off the origin they were configured for.
 *
 * The URL check judges literal addresses and local host names. A public name
 * whose DNS answers a private address passes it, so `fetchGuarded` also takes
 * a host-supplied resolver and refuses a hop when any address the name
 * resolves to is private. That lookup is separate from the connection's own,
 * so it stops names that point inward but not a DNS server that changes its
 * answer between the two (rebinding); only the host's egress layer can.
 *
 * @module
 */

import { TheoremError } from './error.ts';
import type { NetworkGuardrailSpec } from './types.ts';

/**
 * Checks if an IPv4 address is in a private, loopback, or link-local range:
 * - Loopback: 127.0.0.0/8
 * - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - Link-local / Cloud metadata: 169.254.0.0/16
 * - Current network: 0.0.0.0/8
 * - RFC 6598 Carrier-grade NAT: 100.64.0.0/10
 * - RFC 5737 / RFC 6890 documentation / assignments: 192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
 * - RFC 2544 benchmark testing: 198.18.0.0/15
 * - Broadcast / multicast / reserved: 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255
 */
type IPv4OctetMatch = (b0: number, b1: number, b2: number) => boolean;

const PRIVATE_OR_LOCAL_IPV4_MATCHES: readonly IPv4OctetMatch[] = [
  (b0) => b0 === 0, // 0.0.0.0/8
  (b0) => b0 === 127, // 127.0.0.0/8 (loopback)
  (b0) => b0 === 10, // 10.0.0.0/8
  (b0, b1) => b0 === 100 && b1 >= 64 && b1 <= 127, // 100.64.0.0/10 (CGNAT)
  (b0, b1) => b0 === 172 && b1 >= 16 && b1 <= 31, // 172.16.0.0/12
  (b0, b1) => b0 === 192 && b1 === 168, // 192.168.0.0/16
  (b0, b1) => b0 === 169 && b1 === 254, // 169.254.0.0/16 (link-local)
  (b0, b1, b2) => b0 === 192 && b1 === 0 && (b2 === 0 || b2 === 2), // 192.0.0.0/24, 192.0.2.0/24
  (b0, b1) => b0 === 198 && (b1 === 18 || b1 === 19), // 198.18.0.0/15
  (b0, b1, b2) => b0 === 198 && b1 === 51 && b2 === 100, // 198.51.100.0/24
  (b0, b1, b2) => b0 === 203 && b1 === 0 && b2 === 113, // 203.0.113.0/24
  (b0) => b0 >= 224, // Multicast & Reserved (224.0.0.0/4, 240.0.0.0/4)
];

function isPrivateOrLocalIPv4Parts(b0: number, b1: number, b2: number, _b3: number): boolean {
  return PRIVATE_OR_LOCAL_IPV4_MATCHES.some((match) => match(b0, b1, b2));
}

function isPrivateOrLocalIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4) {
    return false;
  }
  const b0 = parts[0];
  const b1 = parts[1];
  const b2 = parts[2];
  const b3 = parts[3];
  if (
    b0 === undefined ||
    b1 === undefined ||
    b2 === undefined ||
    b3 === undefined ||
    Number.isNaN(b0) ||
    Number.isNaN(b1) ||
    Number.isNaN(b2) ||
    Number.isNaN(b3) ||
    b0 < 0 ||
    b0 > 255 ||
    b1 < 0 ||
    b1 > 255 ||
    b2 < 0 ||
    b2 > 255 ||
    b3 < 0 ||
    b3 > 255
  ) {
    return false;
  }
  return isPrivateOrLocalIPv4Parts(b0, b1, b2, b3);
}

function parseIPv6Words(ip: string): number[] | null {
  const trimmed = ip.toLowerCase().trim();
  const lastColon = trimmed.lastIndexOf(':');
  let ipv4Words: number[] = [];
  let v6Str = trimmed;
  if (lastColon !== -1) {
    const potentialV4 = trimmed.slice(lastColon + 1);
    if (potentialV4.includes('.')) {
      const v4Parts = potentialV4.split('.').map((p) => Number.parseInt(p, 10));
      if (v4Parts.length !== 4 || v4Parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
        return null;
      }
      const b0 = v4Parts[0] ?? 0;
      const b1 = v4Parts[1] ?? 0;
      const b2 = v4Parts[2] ?? 0;
      const b3 = v4Parts[3] ?? 0;
      ipv4Words = [(b0 << 8) | b1, (b2 << 8) | b3];
      v6Str = trimmed.slice(0, lastColon);
    }
  }

  const parts = v6Str.split('::');
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];

  const needed = 8 - ipv4Words.length;
  if (parts.length === 1) {
    if (left.length !== needed) return null;
  } else {
    if (left.length + right.length >= needed) return null;
  }

  const zerosNeeded = needed - (left.length + right.length);
  const mid = new Array(zerosNeeded).fill(0);

  const parseHex = (s: string) => (/^[0-9a-f]{1,4}$/.test(s) ? Number.parseInt(s, 16) : null);

  const leftWords: number[] = [];
  for (const s of left) {
    const w = parseHex(s);
    if (w === null) return null;
    leftWords.push(w);
  }
  const rightWords: number[] = [];
  for (const s of right) {
    const w = parseHex(s);
    if (w === null) return null;
    rightWords.push(w);
  }

  return [...leftWords, ...mid, ...rightWords, ...ipv4Words];
}

type IPv6WordsMatch = (w: readonly number[]) => boolean;

const zeros = (w: readonly number[], from: number, to: number) =>
  w.slice(from, to).every((x) => x === 0);

/**
 * IPv6 ranges refused outright:
 * - Unspecified `::` and loopback `::1`
 * - Link-local fe80::/10, deprecated site-local fec0::/10, unique local fc00::/7
 * - Multicast ff00::/8, documentation 2001:db8::/32, discard 100::/64
 * - Local-use NAT64 64:ff9b:1::/48 (RFC 8215), which translates to IPv4 behind
 *   the host's own gateway, and Teredo 2001::/32, whose client address is hidden
 */
const PRIVATE_OR_LOCAL_IPV6_MATCHES: readonly IPv6WordsMatch[] = [
  (w) => zeros(w, 0, 8),
  (w) => zeros(w, 0, 7) && w[7] === 1,
  (w) => ((w[0] ?? 0) & 0xffc0) === 0xfe80,
  (w) => ((w[0] ?? 0) & 0xffc0) === 0xfec0,
  (w) => ((w[0] ?? 0) & 0xfe00) === 0xfc00,
  (w) => ((w[0] ?? 0) & 0xff00) === 0xff00,
  (w) => w[0] === 0x2001 && w[1] === 0x0db8,
  (w) => w[0] === 0x0100 && zeros(w, 1, 4),
  (w) => w[0] === 0x0064 && w[1] === 0xff9b && w[2] === 0x0001,
  (w) => w[0] === 0x2001 && w[1] === 0x0000,
];

/**
 * IPv6 ranges that carry an IPv4 address, judged by that address. `at` is the
 * word where its two words start.
 * - IPv4-mapped ::ffff:0:0/96 and IPv4-translated ::ffff:0:0:0/96
 * - IPv4-compatible ::/96 and NAT64 64:ff9b::/96
 * - 6to4 2002::/16, whose relay forwards to the embedded address
 */
const EMBEDDED_IPV4_RANGES: readonly { match: IPv6WordsMatch; at: number }[] = [
  { match: (w) => zeros(w, 0, 5) && w[5] === 0xffff, at: 6 },
  { match: (w) => zeros(w, 0, 4) && w[4] === 0xffff && w[5] === 0, at: 6 },
  { match: (w) => zeros(w, 0, 6), at: 6 },
  { match: (w) => w[0] === 0x0064 && w[1] === 0xff9b && zeros(w, 2, 6), at: 6 },
  { match: (w) => w[0] === 0x2002, at: 1 },
];

/** Checks if an IPv6 address is private or local, itself or through the IPv4 address it carries. */
function isPrivateOrLocalIPv6(ip: string): boolean {
  const words = parseIPv6Words(ip);
  if (words?.length !== 8) {
    return false;
  }
  if (PRIVATE_OR_LOCAL_IPV6_MATCHES.some((match) => match(words))) return true;
  return EMBEDDED_IPV4_RANGES.some(({ match, at }) => {
    if (!match(words)) return false;
    const hi = words[at] ?? 0;
    const lo = words[at + 1] ?? 0;
    return isPrivateOrLocalIPv4Parts((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
  });
}

/** Check if hostname represents localhost or private domain names */
export function isLocalhostName(hostname: string): boolean {
  let lower = hostname.toLowerCase();
  while (lower.endsWith('.')) {
    lower = lower.slice(0, -1);
  }
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === 'local' ||
    lower.endsWith('.local') ||
    lower === 'internal' ||
    lower.endsWith('.internal') ||
    lower === 'lan' ||
    lower.endsWith('.lan') ||
    lower === 'home.arpa' ||
    lower.endsWith('.home.arpa') ||
    lower === 'localdomain' ||
    lower.endsWith('.localdomain') ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '[::1]'
  );
}

/** Check if an IP address string is loopback or private IPv4/IPv6 */
export function isPrivateOrLocalAddress(ipOrHost: string): boolean {
  const stripped =
    ipOrHost.startsWith('[') && ipOrHost.endsWith(']') ? ipOrHost.slice(1, -1) : ipOrHost;
  return isPrivateOrLocalIPv4(stripped) || isPrivateOrLocalIPv6(stripped);
}

/**
 * Validates a target URL against network guardrail policy.
 * Throws a `TheoremError` if the URL is blocked.
 */
export function assertSafeUrl(urlStr: string, policy?: NetworkGuardrailSpec): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new TheoremError('request', `Invalid URL provided: "${urlStr}"`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }

  const allowPrivate = policy?.allowPrivateNetworks ?? false;
  const allowedHosts = policy?.allowedHosts?.map((h) => h.toLowerCase()) ?? [];
  const hostname = parsed.hostname.toLowerCase();

  // An allowed host is exempt from the address checks, never from the scheme.
  const defaultSchemes = allowPrivate ? ['http:', 'https:'] : ['https:'];
  const allowedSchemes = policy?.allowedSchemes
    ? policy.allowedSchemes.map((s) => (s.endsWith(':') ? s.toLowerCase() : `${s.toLowerCase()}:`))
    : defaultSchemes;

  if (!allowedSchemes.includes(parsed.protocol)) {
    throw new TheoremError(
      'blocked',
      `URL scheme "${parsed.protocol}" is not permitted by network policy. Allowed: ${allowedSchemes.join(', ')}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }

  // Unless private networks or this host are allowed, block localhost and private subnets
  if (!allowPrivate && !allowedHosts.includes(hostname)) {
    if (isLocalhostName(hostname)) {
      throw new TheoremError(
        'blocked',
        `Access to loopback target "${hostname}" blocked by network guardrail. Enable allowPrivateNetworks to permit local addresses.`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }

    if (isPrivateOrLocalIPv4(hostname)) {
      throw new TheoremError(
        'blocked',
        `Access to private IPv4 address "${hostname}" blocked by network guardrail.`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }

    const strippedV6 =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (isPrivateOrLocalIPv6(strippedV6)) {
      throw new TheoremError(
        'blocked',
        `Access to private IPv6 address "${hostname}" blocked by network guardrail.`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }

  return parsed;
}

/** The Fetch standard's redirect limit — the one `redirect: 'follow'` applies. */
const FETCH_REDIRECT_LIMIT = 20;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Options for {@link fetchGuarded}. */
export interface GuardedFetchOptions {
  /** Network policy every hop must clear. */
  policy?: NetworkGuardrailSpec;
  /** Follow redirects, clearing each hop; when false a redirect comes back as the response. */
  followRedirects: boolean;
  /**
   * Headers for the first request's origin only: credentials and host-configured
   * headers. Once a redirect leaves that origin they are never sent again.
   */
  originBoundHeaders?: Record<string, string>;
  /**
   * Resolves each hop's host name before it is fetched; the hop is refused when
   * any address is private or the name does not resolve. Skipped for literal
   * addresses and wherever `policy` already permits private targets.
   */
  resolveHost?: ResolveHost;
  fetchFn?: typeof fetch;
}

/** A host name's IPv4 and IPv6 addresses; empty when the name does not exist. */
export type ResolveHost = (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Refuse `target` when its name resolves to a private address, or to nothing. */
async function assertResolvesPublic(
  target: URL,
  options: GuardedFetchOptions,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  const { resolveHost, policy } = options;
  const hostname = target.hostname.toLowerCase();
  if (
    resolveHost === undefined ||
    policy?.allowPrivateNetworks === true ||
    policy?.allowedHosts?.some((h) => h.toLowerCase() === hostname) === true ||
    hostname.startsWith('[') ||
    IPV4_LITERAL.test(hostname)
  ) {
    return;
  }
  const addresses = await resolveHost(hostname, signal ?? undefined);
  if (addresses.length === 0) {
    throw new TheoremError('blocked', `Host "${hostname}" did not resolve to an address.`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const inward = addresses.find(isPrivateOrLocalAddress);
  if (inward !== undefined) {
    throw new TheoremError(
      'blocked',
      `Host "${hostname}" resolves to private address "${inward}", blocked by network guardrail.`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** A 301/302 turns a POST into a GET, and a 303 turns anything but HEAD into a GET (Fetch standard). */
function redirectsToGet(status: number, method: string): boolean {
  if (status === 303) return method !== 'HEAD';
  return (status === 301 || status === 302) && method === 'POST';
}

/**
 * `fetch` through the network guard: the target and every redirect hop must
 * clear `policy`, and origin-bound headers stay on their origin.
 * Throws a `TheoremError` (`blocked`) when a hop is refused.
 */
export async function fetchGuarded(
  url: string,
  init: Omit<RequestInit, 'redirect' | 'body'> & { body?: string },
  options: GuardedFetchOptions,
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  let target = assertSafeUrl(url, options.policy);
  await assertResolvesPublic(target, options, init.signal);
  const origin = target.origin;
  const headers = new Headers(init.headers);
  let method = init.method ?? 'GET';
  let body = init.body;
  let onOrigin = true;
  for (let hop = 0; ; hop++) {
    const sent = new Headers(headers);
    if (onOrigin) {
      for (const [name, value] of Object.entries(options.originBoundHeaders ?? {})) {
        sent.set(name, value);
      }
    }
    const response = await fetchFn(target.href, {
      ...init,
      method,
      headers: sent,
      body,
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    if (!options.followRedirects || !REDIRECT_STATUSES.has(response.status) || location === null) {
      return response;
    }
    await response.body?.cancel();
    if (hop === FETCH_REDIRECT_LIMIT) {
      throw new TheoremError('network', `Too many redirects from "${url}"`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    target = assertSafeUrl(new URL(location, target).href, options.policy);
    await assertResolvesPublic(target, options, init.signal);
    onOrigin &&= target.origin === origin;
    if (redirectsToGet(response.status, method)) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
    }
  }
}

/** Options for {@link dnsOverHttpsResolver}. */
export interface DnsOverHttpsOptions {
  /** A DNS JSON API endpoint, e.g. `https://cloudflare-dns.com/dns-query`. */
  endpoint: string;
  fetchFn?: typeof fetch;
}

const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;
const DNS_NOERROR = 0;
const DNS_NXDOMAIN = 3;

/**
 * A {@link ResolveHost} over DNS-over-HTTPS (the DNS JSON API), for runtimes
 * with `fetch` but no DNS lookup, such as Cloudflare Workers. It asks the
 * endpoint, not the machine's resolver, so names only an internal resolver
 * knows are not seen; a server host should resolve through its own DNS.
 */
export function dnsOverHttpsResolver(options: DnsOverHttpsOptions): ResolveHost {
  const fetchFn = options.fetchFn ?? fetch;
  const query = async (hostname: string, type: number, signal?: AbortSignal) => {
    const url = new URL(options.endpoint);
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', String(type));
    const response = await fetchFn(url.href, {
      headers: { accept: 'application/dns-json' },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new TheoremError(
        'network',
        `DNS lookup for "${hostname}" failed: HTTP ${response.status}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    const answer = (await response.json()) as {
      Status?: number;
      Answer?: { type?: number; data?: string }[];
    };
    if (answer.Status === DNS_NXDOMAIN) return [];
    if (answer.Status !== DNS_NOERROR) {
      throw new TheoremError(
        'network',
        `DNS lookup for "${hostname}" failed: status ${answer.Status}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return (answer.Answer ?? []).flatMap((record) =>
      record.type === type && typeof record.data === 'string' ? [record.data] : [],
    );
  };
  return async (hostname, signal) => {
    const [v4, v6] = await Promise.all([
      query(hostname, DNS_TYPE_A, signal),
      query(hostname, DNS_TYPE_AAAA, signal),
    ]);
    return [...v4, ...v6];
  };
}
