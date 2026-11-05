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

/** The state as named fields, or undefined when it is a list, a value, or nothing. */
export function stateFields(
  state: DecisionJson | undefined,
): Record<string, DecisionJson> | undefined {
  return state !== null && typeof state === 'object' && !Array.isArray(state) ? state : undefined;
}

/**
 * The images and state after files are dropped: each file a field named after it, holding a
 * reference no image the page or the host holds, nor any field, has yet.
 */
export function droppedImages(
  dropped: readonly (readonly [File, DecisionAsset])[],
  held: { images: DecisionImages; host?: DecisionImages; state: Record<string, DecisionJson> },
): { images: DecisionImages; state: Record<string, DecisionJson> } {
  let { images, state } = held;
  for (const [file, image] of dropped) {
    const { key, reference } = imageField(
      file.name,
      { ...held.host, ...images },
      Object.keys(state),
    );
    images = { ...images, [reference]: image };
    state = { ...state, [key]: reference };
  }
  return { images, state };
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
 * The image a box answer is drawn on: the one its question gives, by reference or by the state
 * field that holds it, else the decision's only image. Otherwise the page cannot tell, so none.
 */
export function boxSource(
  images: DecisionImages,
  state: DecisionJson,
  image?: string,
): DecisionAsset | undefined {
  const reference = image === undefined || image in images ? image : at(state, image);
  if (typeof reference === 'string' && reference in images) return images[reference];
  const held = Object.values(images);
  return image === undefined && held.length === 1 ? held[0] : undefined;
}

/** A box answer's edges, each a share of the image from its top or left. */
export type DecisionBox = { top: number; bottom: number; left: number; right: number };

/** The box in an image's pixels, and an outline that stays visible at any size. */
export function boxRect(box: DecisionBox, width: number, height: number) {
  return {
    x: box.left * width,
    y: box.top * height,
    width: (box.right - box.left) * width,
    height: (box.bottom - box.top) * height,
    line: Math.max(2, Math.round(Math.min(width, height) / 200)),
  };
}

/** How much of the shade's colour lies over the rest of the image, so the image still shows through it. */
const SHADE_ALPHA = 0.45;

/** The colours a marked image is drawn in: the box's outline, and the shade over the rest. */
export type BoxMarks = { outline: string; shade: string };

/** The whole image with the box outlined and the rest shaded, as a PNG `src`. */
export async function markedBox(src: string, box: DecisionBox, marks: BoxMarks): Promise<string> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) return src;
  const rect = boxRect(box, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  context.fillStyle = marks.shade;
  context.globalAlpha = SHADE_ALPHA;
  context.beginPath();
  context.rect(0, 0, canvas.width, canvas.height);
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.fill('evenodd');
  context.globalAlpha = 1;
  context.strokeStyle = marks.outline;
  context.lineWidth = rect.line;
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  return canvas.toDataURL('image/png');
}

/** The part of an image a box takes, as the frame's size and the image's place inside it, in percent. */
export function cropOf(box: DecisionBox) {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  return {
    width: 100 / width,
    height: 100 / height,
    left: (-box.left / width) * 100,
    top: (-box.top / height) * 100,
  };
}
