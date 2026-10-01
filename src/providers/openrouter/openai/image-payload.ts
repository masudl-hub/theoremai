import { TheoremError } from '../../../guardrails/error.ts';
import { isMediaRefPart } from '../../../kernel/interaction-parts.ts';
import type {
  ImageResponseFormat,
  InteractionMediaPart,
  InteractionMediaRefPart,
  InteractionPart,
  ProviderCompleteRequest,
} from '../../../kernel/types.ts';

export function extractPromptText(input: InteractionPart[]): string {
  return input
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
}

export function outputFormatFromMime(mimeType: string): string {
  const essence = mimeType.toLowerCase().replace(/^image\//, '');
  if (essence === 'jpg') {
    return 'jpeg';
  }
  if (essence === 'png' || essence === 'jpeg' || essence === 'webp') {
    return essence;
  }
  return 'png';
}

const HTTP_URL = /^https?:\/\//i;

export function wireInputReference(
  part: InteractionMediaPart | InteractionMediaRefPart,
): Record<string, unknown> {
  const url = isMediaRefPart(part) ? part.uri : `data:${part.mimeType};base64,${part.data}`;
  return { type: 'image_url', image_url: { url } };
}

/** Non-image media is refused, not dropped: a dropped file would leave the user believing the model saw it. */
export function wireInputReferences(input: InteractionPart[]): Record<string, unknown>[] {
  const references: Record<string, unknown>[] = [];
  for (const part of input) {
    if (part.type === 'text') {
      continue;
    }
    if (part.type !== 'image') {
      throw new TheoremError(
        'unsupported',
        `${part.mimeType} input is not supported on /images, which takes image references only`,
      );
    }
    if (isMediaRefPart(part) && !HTTP_URL.test(part.uri)) {
      throw new TheoremError(
        'unsupported',
        'only http(s) media references are supported on /images',
      );
    }
    references.push(wireInputReference(part));
  }
  return references;
}

export function attachImagePins(
  payload: Record<string, unknown>,
  image: ImageResponseFormat,
): void {
  if (image.aspectRatio) {
    payload.aspect_ratio = image.aspectRatio;
  }
  if (image.resolution) {
    payload.resolution = image.resolution;
  }
  if (image.mimeType) {
    payload.output_format = outputFormatFromMime(image.mimeType);
  }
  if (image.quality) {
    payload.quality = image.quality;
  }
  if (image.background) {
    payload.background = image.background;
  }
  if (image.n !== undefined) {
    payload.n = image.n;
  }
  if (image.seed !== undefined) {
    payload.seed = image.seed;
  }
  if (image.outputCompression !== undefined) {
    payload.output_compression = image.outputCompression;
  }
}

export function buildImagesPayload(req: ProviderCompleteRequest): Record<string, unknown> {
  if (!req.image) {
    throw new Error('buildImagesPayload requires req.image');
  }
  const payload: Record<string, unknown> = {
    model: req.apiId,
    prompt: extractPromptText(req.input),
  };
  attachImagePins(payload, req.image);
  const references = wireInputReferences(req.input);
  if (references.length > 0) {
    payload.input_references = references;
  }
  if (req.stream === false) {
    payload.stream = false;
  }
  return payload;
}

export function imageToolParameters(image: ImageResponseFormat): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (image.mimeType) {
    params.output_format = outputFormatFromMime(image.mimeType);
  }
  if (image.aspectRatio) {
    params.aspect_ratio = image.aspectRatio;
  }
  if (image.resolution) {
    params.resolution = image.resolution;
  }
  if (image.quality) {
    params.quality = image.quality;
  }
  if (image.background) {
    params.background = image.background;
  }
  if (image.outputCompression !== undefined) {
    params.output_compression = image.outputCompression;
  }
  for (const [name, value] of [
    ['n', image.n],
    ['seed', image.seed],
  ] as const) {
    if (value !== undefined) {
      throw new TheoremError(
        'unsupported',
        `image.${name} is not supported with image.includeText`,
      );
    }
  }
  return params;
}
