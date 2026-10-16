import { asRecord, nonEmptyString } from '../../kernel/engine/record.ts';

export const OPENROUTER_IMAGE_TOOL = 'openrouter:image_generation';

/** `/images` answers `data[]` of `b64_json` + `media_type` (probe 23/09/2026, bytedance-seed/seedream-4.5). */
export function imagesFromImagesBody(
  body: Record<string, unknown>,
): { mimeType: string; data: string }[] {
  const entries = Array.isArray(body.data) ? body.data : [];
  return entries.flatMap((value) => {
    const entry = asRecord(value);
    const data = nonEmptyString(entry?.b64_json);
    const mimeType = nonEmptyString(entry?.media_type);
    return data && mimeType ? [{ mimeType, data }] : [];
  });
}

function mediaFromDataUrl(url: unknown): { mimeType: string; data: string } | undefined {
  if (typeof url !== 'string') {
    return undefined;
  }
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { mimeType: match[1], data: match[2] };
}

/**
 * OpenRouter returns chat images on `message.images[]` as `{ type: 'image_url', image_url: { url } }`
 * with a base64 data url; `message.content` holds only the text (probe 23/09/2026,
 * gemini-3.1-flash-lite with the image generation tool).
 */
export function imagesFromChatMessage(
  message: Record<string, unknown>,
): { mimeType: string; data: string }[] {
  const images = Array.isArray(message.images) ? message.images : [];
  return images.flatMap((entry) => {
    const media = mediaFromDataUrl(asRecord(asRecord(entry)?.image_url)?.url);
    return media ? [media] : [];
  });
}
