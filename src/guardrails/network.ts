/**
 * Network SSRF guardrails for HTTP and remote MCP tools.
 *
 * Enforces URL scheme safety and blocks loopback, private RFC 1918,
 * link-local (cloud metadata 169.254.x.x), and multicast targets unless
 * explicitly permitted by profile guardrail configuration.
 *
 * @module
 */

import { TheorumError } from './error.ts';

export interface NetworkGuardrailSpec {
  /** When true, allows connections to localhost / loopback and private subnets (e.g. for local dev/testing). Default: false. */
  allowPrivateNetworks?: boolean;
  /** Explicit whitelist of hostnames or IP addresses permitted regardless of private subnet status. */
  allowedHosts?: string[];
  /** Optional allowed URL schemes. Defaults to ['https'] in production, or ['http', 'https'] if allowPrivateNetworks is true. */
  allowedSchemes?: string[];
}

/**
 * Checks if an IPv4 address is in a private, loopback, or link-local range:
 * - Loopback: 127.0.0.0/8
 * - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - Link-local / Cloud metadata: 169.254.0.0/16
 * - Current network: 0.0.0.0/8
 * - Broadcast / multicast: 224.0.0.0/4, 255.255.255.255
 */
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
function isPrivateOrLocalIPv4Parts(b0: number, b1: number, b2: number, _b3: number): boolean {
  if (b0 === 0) return true; // 0.0.0.0/8
  if (b0 === 127) return true; // 127.0.0.0/8 (loopback)
  if (b0 === 10) return true; // 10.0.0.0/8
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64.0.0/10 (CGNAT / cloud internal)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
  if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
  if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 (link-local, cloud metadata)
  if (b0 === 192 && b1 === 0 && (b2 === 0 || b2 === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true; // 198.18.0.0/15 (benchmark)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true; // 198.51.100.0/24
  if (b0 === 203 && b1 === 0 && b2 === 113) return true; // 203.0.113.0/24
  if (b0 >= 224) return true; // Multicast & Reserved (240.0.0.0/4)
  return false;
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

/**
 * Checks if an IPv6 address is in a private, loopback, or link-local range:
 * - Loopback: ::1
 * - Unspecified: ::
 * - Link-local: fe80::/10
 * - Unique Local (ULA): fc00::/7 (fc00:: - fdff::)
 * - Multicast: ff00::/8
 * - Documentation: 2001:db8::/32
 * - Discard: 100::/64
 * - IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), and NAT64 (64:ff9b::/96)
 */
function isPrivateOrLocalIPv6(ip: string): boolean {
  const words = parseIPv6Words(ip);
  if (words?.length !== 8) {
    return false;
  }

  const w0 = words[0] ?? 0;
  const w1 = words[1] ?? 0;

  // Unspecified ::
  if (words.every((w) => w === 0)) return true;

  // Loopback ::1
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;

  // Link-local unicast (fe80::/10)
  if ((w0 & 0xffc0) === 0xfe80) return true;

  // Unique local address (fc00::/7)
  if ((w0 & 0xfe00) === 0xfc00) return true;

  // Multicast (ff00::/8)
  if ((w0 & 0xff00) === 0xff00) return true;

  // Documentation (2001:db8::/32)
  if (w0 === 0x2001 && w1 === 0x0db8) return true;

  // Discard prefix (100::/64)
  if (w0 === 0x0100 && words.slice(1, 4).every((w) => w === 0)) return true;

  // IPv4-mapped (::ffff:0:0/96)
  const isV4Mapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
  // IPv4-compatible (::/96)
  const isV4Compatible = words.slice(0, 6).every((w) => w === 0);
  // NAT64 well-known prefix (64:ff9b::/96)
  const isNat64 = w0 === 0x0064 && w1 === 0xff9b && words.slice(2, 6).every((w) => w === 0);

  if (isV4Mapped || isV4Compatible || isNat64) {
    const w6 = words[6] ?? 0;
    const w7 = words[7] ?? 0;
    const b0 = (w6 >> 8) & 0xff;
    const b1 = w6 & 0xff;
    const b2 = (w7 >> 8) & 0xff;
    const b3 = w7 & 0xff;
    return isPrivateOrLocalIPv4Parts(b0, b1, b2, b3);
  }

  return false;
}

/** Check if hostname represents localhost or private domain names */
function isLocalhostName(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
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

/**
 * Validates a target URL against network guardrail policy.
 * Throws a `TheorumError` if the URL is blocked.
 */
export function assertSafeUrl(urlStr: string, policy?: NetworkGuardrailSpec): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new TheorumError(`Invalid URL provided: "${urlStr}"`);
  }

  const allowPrivate = policy?.allowPrivateNetworks ?? false;
  const allowedHosts = policy?.allowedHosts?.map((h) => h.toLowerCase()) ?? [];
  const hostname = parsed.hostname.toLowerCase();

  // If host is explicitly whitelisted, allow it
  if (allowedHosts.includes(hostname)) {
    return parsed;
  }

  // Scheme validation
  const defaultSchemes = allowPrivate ? ['http:', 'https:'] : ['https:'];
  const allowedSchemes = policy?.allowedSchemes
    ? policy.allowedSchemes.map((s) => (s.endsWith(':') ? s.toLowerCase() : `${s.toLowerCase()}:`))
    : defaultSchemes;

  if (!allowedSchemes.includes(parsed.protocol)) {
    throw new TheorumError(
      `URL scheme "${parsed.protocol}" is not permitted by network policy. Allowed: ${allowedSchemes.join(', ')}`,
    );
  }

  // Unless private networks are allowed, block localhost and private subnets
  if (!allowPrivate) {
    if (isLocalhostName(hostname)) {
      throw new TheorumError(
        `Access to loopback target "${hostname}" blocked by network guardrail. Enable allowPrivateNetworks to permit local addresses.`,
      );
    }

    if (isPrivateOrLocalIPv4(hostname)) {
      throw new TheorumError(
        `Access to private IPv4 address "${hostname}" blocked by network guardrail.`,
      );
    }

    const strippedV6 =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (isPrivateOrLocalIPv6(strippedV6)) {
      throw new TheorumError(
        `Access to private IPv6 address "${hostname}" blocked by network guardrail.`,
      );
    }
  }

  return parsed;
}
