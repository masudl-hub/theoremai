/** labels-exempt-file: benchmark dataset parsing — not runtime user or model copy (P2) */
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

/** Every row of a parquet file, one row group at a time, so a large file never sits in memory whole. */
export async function* parquetRows(
  path: string,
  columns: readonly string[],
): AsyncIterable<Record<string, unknown>> {
  const file = await asyncBufferFromFile(path);
  const metadata = await parquetMetadataAsync(file);
  let rowStart = 0;
  for (const group of metadata.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    yield* await parquetReadObjects({
      file,
      metadata,
      columns: [...columns],
      rowStart,
      rowEnd,
      compressors,
    });
    rowStart = rowEnd;
  }
}

/** Every line of a text file, read as a stream so a file of gigabytes never sits in memory whole. */
export async function* fileLines(path: string): AsyncIterable<string> {
  const file = await Deno.open(path);
  let rest = '';
  for await (const chunk of file.readable.pipeThrough(new TextDecoderStream())) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    yield* lines;
  }
  if (rest) yield rest;
}

/** Each JSON object of a JSON-lines file. A line that does not parse is skipped. */
export async function* jsonLines(path: string): AsyncIterable<Record<string, unknown>> {
  for await (const line of fileLines(path)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // why: One malformed row is not worth failing the run over.
    }
  }
}

/** The rows of a page saved from the Hugging Face rows API: `{ rows: [{ row }] }`. */
export async function hfPageRows(path: string): Promise<Record<string, unknown>[]> {
  const parsed = JSON.parse(await Deno.readTextFile(path)) as {
    rows?: { row?: Record<string, unknown> }[];
  };
  return (parsed.rows ?? []).flatMap((entry) => (entry.row ? [entry.row] : []));
}

/** Rows of a CSV with a header line. Quoted fields may hold commas, quotes and newlines. */
export function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])));
}

/**
 * The rows of a `text,label` CSV whose label is 0 or 1. A blank label is dropped, because
 * `Number('')` is 0 and would count the row as benign.
 */
export function parseLabelledCsv(input: string): { text: string; label: 0 | 1 }[] {
  const out: { text: string; label: 0 | 1 }[] = [];
  for (const row of parseCsv(input)) {
    const text = row.text;
    const raw = row.label?.trim();
    if (!text || !raw) continue;
    const label = Number(raw);
    if (label === 0 || label === 1) out.push({ text, label });
  }
  return out;
}

function isYamlKeyChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return (code >= 97 && code <= 122) || ch === '_';
}

function skipIndent(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
  return i;
}

/** A linear scan rather than a regex split, which was polynomial on this input. */
function yamlRecordBlocks(yaml: string): string[] {
  const blocks: string[] = [];
  let start = -1;
  let offset = 0;
  for (const line of yaml.split('\n')) {
    const i = skipIndent(line);
    if (line[i] === '-' && line[i + 1] === ' ') {
      let j = i + 2;
      while (j < line.length && isYamlKeyChar(line[j] ?? '')) j += 1;
      if (j > i + 2 && line[j] === ':') {
        if (start >= 0) blocks.push(yaml.slice(start, offset));
        start = offset + i + 2;
      }
    }
    offset += line.length + 1;
  }
  if (start >= 0) blocks.push(yaml.slice(start));
  return blocks;
}

function parseYamlRecordLine(
  line: string,
):
  | { kind: 'scalar'; key: string; value: string }
  | { kind: 'header'; key: string }
  | { kind: 'item'; value: string }
  | null {
  let i = skipIndent(line);
  if (line[i] === '-' && line[i + 1] === ' ') {
    const value = line.slice(i + 2).trim();
    return value.length > 0 && !value.includes(' ') ? { kind: 'item', value } : null;
  }
  const keyStart = i;
  while (i < line.length && isYamlKeyChar(line[i] ?? '')) i += 1;
  if (i === keyStart || line[i] !== ':') return null;
  const key = line.slice(keyStart, i);
  let next = i + 1;
  while (next < line.length && (line[next] === ' ' || line[next] === '\t')) next += 1;
  if (next >= line.length) return { kind: 'header', key };
  let value = line.slice(next).trimEnd();
  if (value === '[]') return null;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
  return { kind: 'scalar', key, value };
}

/**
 * Each record of an AgentDojo fixture, written out the way a tool returns it. Taking only the
 * prose drops the addresses, ids and amounts a real tool result carries, and a detector would
 * score better than it deserves.
 */
export function recordsFromYaml(yaml: string): string[] {
  const out: string[] = [];
  for (const block of yamlRecordBlocks(yaml)) {
    const fields: Record<string, string | string[]> = {};
    let listKey = '';
    for (const line of block.split('\n')) {
      const parsed = parseYamlRecordLine(line);
      if (parsed?.kind === 'scalar') {
        fields[parsed.key] = parsed.value.replaceAll('\\n', '\n');
        listKey = '';
        continue;
      }
      // why: A bare `key:` opens a list. Without tracking it, the items below overwrite the field
      // before, which dropped the sender of every email.
      if (parsed?.kind === 'header') {
        listKey = parsed.key;
        fields[listKey] = [];
        continue;
      }
      if (parsed?.kind === 'item' && listKey) {
        const prior = fields[listKey];
        fields[listKey] = Array.isArray(prior) ? [...prior, parsed.value] : [parsed.value];
      }
    }
    const rendered = JSON.stringify(fields, null, 2);
    if (rendered.length > 80) out.push(rendered);
  }
  return out;
}

/** Each `FUNCTION RESPONSE:` body in a Glaive transcript: one tool result each. */
export function toolResultsFromChat(chat: string): string[] {
  const out: string[] = [];
  for (const match of chat.matchAll(/FUNCTION RESPONSE:\s*(\{[\s\S]*?\})\s*(?:\n|$)/g)) {
    const body = match[1];
    if (body && body.length > 15) out.push(body);
  }
  return out;
}

/** Whether a card number passes the Luhn checksum. A number that fails it is not a card. */
export function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
