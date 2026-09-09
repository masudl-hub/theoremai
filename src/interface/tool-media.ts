/**
 * Promote http(s) media URLs found in completed tool output into transcript media blocks.
 *
 * @module
 */

/** Guessed media kind + MIME from a URL path extension. */
export type PromotedToolMedia = {
  url: string;
  mimeType: string;
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

/**
 * Depth-first walk of tool output collecting unique http(s) image/video/audio URLs.
 * Order follows first encounter in JSON tree order.
 */
export function collectPromotedMediaFromToolOutput(output: unknown): PromotedToolMedia[] {
  const seen = new Set<string>();
  const out: PromotedToolMedia[] = [];

  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const media = promotedMediaFromUrlString(value);
      if (media && !seen.has(media.url)) {
        seen.add(media.url);
        out.push(media);
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
