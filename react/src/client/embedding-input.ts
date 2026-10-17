/**
 * The rules behind an embedding console: the inputs as the JSON a request
 * sends, edited as rows of text and files, checked the way the kernel checks
 * them, and the vectors that come back compared.
 *
 * @module
 */

import {
  type AttachmentFacts,
  attachmentIssues,
  base64Bytes,
  type EmbeddingInput,
  type EmbeddingPart,
  type EmbeddingResult,
  resolveMediaLimits,
} from '@theoremjs/agents';
import type { AttachmentValidationIssue } from '@theoremjs/agents/interface';
import type { EmbeddingInterface } from './embedding-transport.ts';

/** A part that is not text: a file sent inline, or one the provider already holds. */
export type EmbeddingMediaPart = Exclude<EmbeddingPart, { type: 'text' }>;

/** One input as the fields edit it: its words, and the files beside them. */
export type EmbeddingRow = { text: string; media: EmbeddingMediaPart[] };

export type EmbeddingInputCheck =
  | { ok: true; inputs: EmbeddingInput[] }
  | { ok: false; reason: 'invalid_json' | 'no_inputs' }
  | { ok: false; reason: 'empty_input' | 'text_off'; index: number; inputs: EmbeddingInput[] }
  | {
      ok: false;
      reason: 'attachments';
      issues: AttachmentValidationIssue[];
      inputs: EmbeddingInput[];
    };

function isPart(value: unknown): value is EmbeddingPart {
  if (typeof value !== 'object' || value === null) return false;
  const part = value as Record<string, unknown>;
  if (part.type === 'text') return typeof part.text === 'string';
  if (typeof part.mimeType !== 'string') return false;
  if (part.type === 'media') return typeof part.data === 'string';
  return part.type === 'media-ref' && typeof part.uri === 'string';
}

function isInput(value: unknown): value is EmbeddingInput {
  if (typeof value === 'string') return true;
  if (typeof value !== 'object' || value === null) return false;
  const parts = (value as { parts?: unknown }).parts;
  return Array.isArray(parts) && parts.every(isPart);
}

/** The request's inputs, read from its JSON; `undefined` when it is not a list of inputs. */
export function readEmbeddingInputs(text: string): EmbeddingInput[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Array.isArray(value) && value.every(isInput) ? value : undefined;
}

function partsOf(input: EmbeddingInput): readonly EmbeddingPart[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input.parts;
}

/** The inputs as rows, or `null` when one holds more than one text part and rows would lose it. */
export function embeddingRows(inputs: readonly EmbeddingInput[]): EmbeddingRow[] | null {
  const rows: EmbeddingRow[] = [];
  for (const input of inputs) {
    const parts = partsOf(input);
    const texts = parts.filter((part) => part.type === 'text');
    if (texts.length > 1) return null;
    rows.push({
      text: texts[0]?.text ?? '',
      media: parts.filter((part): part is EmbeddingMediaPart => part.type !== 'text'),
    });
  }
  return rows;
}

/** A row as the input it sends: plain text alone, else its parts with the text first. */
export function rowInput(row: EmbeddingRow): EmbeddingInput {
  if (row.media.length === 0) return row.text;
  return {
    parts: [...(row.text ? [{ type: 'text' as const, text: row.text }] : []), ...row.media],
  };
}

function mediaFacts(part: EmbeddingMediaPart): AttachmentFacts {
  return part.type === 'media'
    ? { mimeType: part.mimeType, sizeBytes: base64Bytes(part.data) }
    : { mimeType: part.mimeType };
}

/** The request's JSON as the inputs it sends, held to the profile's rules as the kernel holds them. */
export function checkEmbeddingInputs(
  text: string,
  rules: EmbeddingInterface['inputs'],
): EmbeddingInputCheck {
  const inputs = readEmbeddingInputs(text);
  if (inputs === undefined) return { ok: false, reason: 'invalid_json' };
  if (inputs.length === 0) return { ok: false, reason: 'no_inputs' };
  const media: AttachmentFacts[] = [];
  for (const [index, input] of inputs.entries()) {
    const parts = partsOf(input);
    if (parts.length === 0 || parts.every((part) => part.type === 'text' && !part.text.trim()))
      return { ok: false, reason: 'empty_input', index, inputs };
    if (!rules.text && parts.some((part) => part.type === 'text' && part.text.trim()))
      return { ok: false, reason: 'text_off', index, inputs };
    for (const part of parts) {
      if (part.type === 'text') continue;
      try {
        media.push(mediaFacts(part));
      } catch {
        return { ok: false, reason: 'invalid_json' };
      }
    }
  }
  const issues = attachmentIssues(
    { attachments: rules.attachments?.accept, limits: resolveMediaLimits(rules) },
    media,
    [],
  );
  return issues.length > 0
    ? { ok: false, reason: 'attachments', issues, inputs }
    : { ok: true, inputs };
}

/** How alike two vectors point, from -1 to 1. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

/** A vector's length. */
export function vectorNorm(values: readonly number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

export type EmbeddingPair = { a: number; b: number; similarity: number };

/** Every pair of vectors of the same width, most alike first. */
export function embeddingPairs(result: EmbeddingResult): EmbeddingPair[] {
  const pairs: EmbeddingPair[] = [];
  const vectors = result.embeddings;
  for (let i = 0; i < vectors.length; i += 1)
    for (let j = i + 1; j < vectors.length; j += 1)
      if (vectors[i].dimensions === vectors[j].dimensions)
        pairs.push({
          a: vectors[i].index,
          b: vectors[j].index,
          similarity: cosineSimilarity(vectors[i].values, vectors[j].values),
        });
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

/** The values in `bins` equal runs, each its mean: a long vector drawn at the width it has. */
export function vectorBins(values: readonly number[], bins: number): number[] {
  if (values.length <= bins) return [...values];
  return Array.from({ length: bins }, (_, bin) => {
    const start = Math.floor((bin * values.length) / bins);
    const end = Math.floor(((bin + 1) * values.length) / bins);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += values[i];
    return sum / (end - start);
  });
}
