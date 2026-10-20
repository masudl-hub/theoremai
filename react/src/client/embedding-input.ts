/**
 * The rules behind an embedding console: the inputs as the JSON a request
 * sends, text split into documents, documents packed into the requests the
 * profile allows, all checked the way the kernel checks them, and documents
 * ranked by how alike they point to a query.
 *
 * @module
 */

import {
  type AttachmentFacts,
  base64Bytes,
  type EmbeddingInput,
  type EmbeddingPart,
  type EmbeddingUsage,
  embeddingMediaIssues,
} from '@theoremjs/agents';
import type { AttachmentValidationIssue } from '@theoremjs/agents/interface';
import type { EmbeddingInterface } from './embedding-transport.ts';

/** A part that is not text: a file sent inline, or one the provider already holds. */
export type EmbeddingMediaPart = Exclude<EmbeddingPart, { type: 'text' }>;

export type EmbeddingInputCheck =
  | { ok: true; inputs: EmbeddingInput[] }
  | { ok: false; reason: 'invalid_json' | 'no_inputs' }
  | { ok: false; reason: 'too_many_inputs'; max: number; inputs: EmbeddingInput[] }
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

/** One input, read from its JSON; `undefined` when it is not one. */
export function readEmbeddingInput(text: string): EmbeddingInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isInput(value) ? value : undefined;
}

/** One input as fields edit it: its words, and the files beside them. */
export type EmbeddingFields = { text: string; media: EmbeddingMediaPart[] };

/** The input as fields, or `null` when it holds more than one text part and fields would lose it. */
export function inputFields(input: EmbeddingInput): EmbeddingFields | null {
  const parts = partsOf(input);
  const texts = parts.filter((part) => part.type === 'text');
  if (texts.length > 1) return null;
  return {
    text: texts[0]?.text ?? '',
    media: parts.filter((part): part is EmbeddingMediaPart => part.type !== 'text'),
  };
}

/** Fields as the input they send: plain text alone, else its parts with the text first. */
export function fieldsInput(fields: EmbeddingFields): EmbeddingInput {
  if (fields.media.length === 0) return fields.text;
  return {
    parts: [
      ...(fields.text ? [{ type: 'text' as const, text: fields.text }] : []),
      ...fields.media,
    ],
  };
}

function mediaFacts(part: EmbeddingMediaPart): AttachmentFacts {
  return part.type === 'media'
    ? { mimeType: part.mimeType, sizeBytes: base64Bytes(part.data) }
    : { mimeType: part.mimeType };
}

/** The inputs, held to the profile's rules and its model's limits as the kernel holds them in one request. */
export function checkInputs(
  inputs: readonly EmbeddingInput[],
  rules: EmbeddingInterface['inputs'],
): EmbeddingInputCheck {
  const list = [...inputs];
  if (list.length === 0) return { ok: false, reason: 'no_inputs' };
  if (rules.maxInputs !== undefined && list.length > rules.maxInputs)
    return { ok: false, reason: 'too_many_inputs', max: rules.maxInputs, inputs: list };
  const media: AttachmentFacts[][] = [];
  for (const [index, input] of list.entries()) {
    const parts = partsOf(input);
    if (parts.length === 0 || parts.every((part) => part.type === 'text' && !part.text.trim()))
      return { ok: false, reason: 'empty_input', index, inputs: list };
    if (!rules.text && parts.some((part) => part.type === 'text' && part.text.trim()))
      return { ok: false, reason: 'text_off', index, inputs: list };
    const files: AttachmentFacts[] = [];
    for (const part of parts) {
      if (part.type === 'text') continue;
      try {
        files.push(mediaFacts(part));
      } catch {
        return { ok: false, reason: 'invalid_json' };
      }
    }
    media.push(files);
  }
  const issues = embeddingMediaIssues(rules, media);
  return issues.length > 0
    ? { ok: false, reason: 'attachments', issues, inputs: list }
    : { ok: true, inputs: list };
}

/** The request's JSON as the inputs it sends, held to the profile's rules. */
export function checkEmbeddingInputs(
  text: string,
  rules: EmbeddingInterface['inputs'],
): EmbeddingInputCheck {
  const inputs = readEmbeddingInputs(text);
  return inputs === undefined ? { ok: false, reason: 'invalid_json' } : checkInputs(inputs, rules);
}

/** Where text is cut into documents: not at all, at each line, at blank lines, at commas, or at a separator of your own. */
export type EmbeddingSplit = 'whole' | 'lines' | 'paragraphs' | 'commas' | { separator: string };

/** The text as documents, each trimmed, none empty. */
export function splitText(text: string, split: EmbeddingSplit): string[] {
  const pieces =
    split === 'whole'
      ? [text]
      : split === 'lines'
        ? text.split(/\r?\n/)
        : split === 'paragraphs'
          ? text.split(/\r?\n[^\S\r\n]*\r?\n/)
          : split === 'commas'
            ? text.split(',')
            : split.separator
              ? text.split(split.separator)
              : [text];
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== '');
}

/** A file read as words and split, not sent as media: plain text, Markdown, CSV, and JSON. */
export function readsAsText(file: { name: string; type: string }): boolean {
  return (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    /\.(txt|md|markdown|csv|tsv|json)$/i.test(file.name)
  );
}

// why: OpenRouter caps no batch (it took 101 inputs); 100 is Gemini's cap, a size every provider checked carries.
/** The most inputs the console sends in one request when the model sets no cap. */
export const MAX_BATCH_INPUTS = 100;

/**
 * The inputs, in order, as the fewest requests the profile and its model
 * allow: each holds at most `most` inputs and passes {@linkcode checkInputs}.
 * An input refused on its own goes alone, for the kernel to refuse.
 */
export function embeddingBatches(
  inputs: readonly EmbeddingInput[],
  rules: EmbeddingInterface['inputs'],
  most: number = MAX_BATCH_INPUTS,
): EmbeddingInput[][] {
  const batches: EmbeddingInput[][] = [];
  let current: EmbeddingInput[] = [];
  for (const input of inputs) {
    const next = [...current, input];
    if (current.length > 0 && (next.length > most || !checkInputs(next, rules).ok)) {
      batches.push(current);
      current = [input];
    } else current = next;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Two calls' usage as one: token counts and costs added, estimated when either was. */
export function addUsage(
  a: EmbeddingUsage | undefined,
  b: EmbeddingUsage | undefined,
): EmbeddingUsage | undefined {
  if (!a || !b) return a ?? b;
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const inputTokens = sum(a.inputTokens, b.inputTokens);
  const costUsd = sum(a.costUsd, b.costUsd);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(a.estimated || b.estimated ? { estimated: true as const } : {}),
  };
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

/** A document and how alike it points to the query, from -1 to 1. */
export type EmbeddingMatch = { index: number; score: number };

/** The documents, most alike to the query first; a vector of another width is left out. */
export function rankMatches(
  query: readonly number[],
  documents: readonly (readonly number[])[],
): EmbeddingMatch[] {
  return documents
    .flatMap((values, index) =>
      values.length === query.length ? [{ index, score: cosineSimilarity(query, values) }] : [],
    )
    .sort((a, b) => b.score - a.score);
}
