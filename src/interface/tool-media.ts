/**
 * Promote http(s) media URLs found in completed tool output into transcript media blocks.
 *
 * @module
 */

/** Guessed media kind + MIME from a URL path extension. */
export type PromotedToolMedia = {
  url: string;
  mimeType: string;
  /** A smaller copy of the same file, when the output also carried one. */
  previewUrl?: string;
};

const EXT_MIME: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

function mimeForPathname(pathname: string): string | undefined {
  const base = pathname.split('/').pop() ?? pathname;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_MIME[ext];
}

/** Return a promoted media descriptor when `raw` is an http(s) media URL. */
export function promotedMediaFromUrlString(raw: string): PromotedToolMedia | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const mimeType = mimeForPathname(parsed.pathname);
  if (!mimeType) return undefined;
  return { url: parsed.href, mimeType };
}

/** MediaWiki resizes: `…/thumb/<a>/<ab>/<File>/<N>px-<File>` is `<N>` wide; the original is `…/<a>/<ab>/<File>`. */
const MEDIAWIKI_THUMB = /^(.*)\/thumb(\/.+\/([^/]+))\/(\d+)px-\3(?:\.[a-z0-9]+)?$/i;

/**
 * The underlying file, so one picture at several sizes counts once (Wikipedia
 * summaries carry `thumbnail` and `originalimage`, sometimes on different
 * wikimedia.org hosts). `width` ranks copies; the original ranks highest.
 */
function mediaAsset(url: string): { key: string; width: number } {
  const parsed = new URL(url);
  const site = parsed.hostname.split('.').slice(-2).join('.');
  // Tracking parameters never change the file; other query parameters may.
  for (const name of [...parsed.searchParams.keys()]) {
    if (name.startsWith('utm_')) parsed.searchParams.delete(name);
  }
  const thumb = MEDIAWIKI_THUMB.exec(parsed.pathname);
  const pathname = thumb ? `${thumb[1]}${thumb[2]}` : parsed.pathname;
  return {
    key: `${site}${pathname}${parsed.search}`,
    width: thumb ? Number(thumb[4]) : Number.POSITIVE_INFINITY,
  };
}

/**
 * Depth-first walk of tool output collecting unique http(s) image/video/audio URLs.
 * Order follows first encounter in JSON tree order. One file at several sizes
 * is promoted once: `url` is its largest copy, `previewUrl` its smallest.
 */
export function collectPromotedMediaFromToolOutput(output: unknown): PromotedToolMedia[] {
  const seen = new Map<string, { index: number; largest: number; smallest: number }>();
  const out: PromotedToolMedia[] = [];

  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const media = promotedMediaFromUrlString(value);
      if (!media) return;
      const asset = mediaAsset(media.url);
      const prior = seen.get(asset.key);
      if (!prior) {
        seen.set(asset.key, { index: out.length, largest: asset.width, smallest: asset.width });
        out.push(media);
        return;
      }
      const current = out[prior.index] as PromotedToolMedia;
      if (asset.width > prior.largest) {
        prior.largest = asset.width;
        out[prior.index] = { ...current, url: media.url, previewUrl: current.previewUrl ?? current.url };
      } else if (asset.width < prior.smallest) {
        prior.smallest = asset.width;
        out[prior.index] = { ...current, previewUrl: media.url };
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        visit(nested);
      }
    }
  };

  visit(output);
  return out;
}
