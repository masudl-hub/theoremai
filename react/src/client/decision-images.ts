import type { DecisionAsset, DecisionJson } from '@theoremjs/agents';

/**
 * An image the page holds for a decision, by its reference: the text the state and the questions
 * write where the image goes, such as `<pantry_shelf>`.
 */
export type DecisionImages = Record<string, DecisionAsset>;

const MIME_TYPES = new Set<string>(['image/png', 'image/jpeg']);

/** The image types a decision reads. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg';

/**
 * A reference for a file that no image holds yet: its base name in angle brackets, then `_2`, `_3`,
 * and so on. The model reads any text as a reference, so the brackets keep it from matching words.
 */
export function imageName(file: string, taken: readonly string[]): string {
  const base =
    file
      .replace(/\.[^.]*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'image';
  let name = `<${base}>`;
  for (let n = 2; taken.includes(name); n += 1) name = `<${base}_${String(n)}>`;
  return name;
}

/** A file as an asset, or null when it is not a PNG or JPEG. */
export async function readImage(file: File): Promise<DecisionAsset | null> {
  if (!MIME_TYPES.has(file.type)) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mimeType: file.type as DecisionAsset['mimeType'], data: btoa(binary) };
}

/** The image as a `src` the page can show. */
export function imageSrc(image: DecisionAsset): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function mentions(value: DecisionJson, name: string): boolean {
  if (typeof value === 'string') return value === name;
  if (Array.isArray(value)) return value.some((each) => mentions(each, name));
  if (value !== null && typeof value === 'object')
    return Object.values(value).some((each) => mentions(each, name));
  return false;
}

/** The held images the state still names, the only ones a decision sends. */
export function namedImages(images: DecisionImages, state: DecisionJson): DecisionImages {
  return Object.fromEntries(Object.entries(images).filter(([name]) => mentions(state, name)));
}

/**
 * The field a dropped file becomes: its reference, unused by any image or field, and the field
 * named after it, such as `plant` holding `<plant>`.
 */
export function imageField(
  file: string,
  images: DecisionImages,
  fields: readonly string[],
): { key: string; reference: string } {
  const reference = imageName(file, [...Object.keys(images), ...fields.map((key) => `<${key}>`)]);
  return { key: reference.slice(1, -1), reference };
}

function at(state: DecisionJson, path: string): DecisionJson | undefined {
  let value: DecisionJson | undefined = state;
  for (const step of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = Array.isArray(value) ? value[Number(step)] : value[step];
  }
  return value;
}

/**
 * The image a box answer is drawn on: the one at `field`, the state field its question names, else
 * the first the state refers to, else the first held. A box answer names no image, so this is the
 * page's best reading of where it points.
 */
export function boxSource(
  images: DecisionImages,
  state: DecisionJson,
  field?: string,
): DecisionAsset | undefined {
  const names = Object.keys(images);
  const pointed = field === undefined ? undefined : at(state, field);
  const named =
    (typeof pointed === 'string' && pointed in images ? pointed : undefined) ??
    names.find((name) => mentions(state, name));
  return images[named ?? names[0] ?? ''];
}

/** The part of an image a box takes, as the frame's size and the image's place inside it, in percent. */
export function cropOf(box: { top: number; bottom: number; left: number; right: number }) {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  return {
    width: 100 / width,
    height: 100 / height,
    left: (-box.left / width) * 100,
    top: (-box.top / height) * 100,
  };
}
