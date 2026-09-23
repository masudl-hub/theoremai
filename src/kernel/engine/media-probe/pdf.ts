/**
 * PDF page count from the page tree. FlateDecode object streams are inflated
 * to reach a compressed page tree; page content is never parsed.
 *
 * @module
 */

const PDF_PAGES_TYPE = /\/Type\s*\/Pages(?![A-Za-z])/g;
const PDF_COUNT = /\/Count\s+(\d+)/;
const PDF_PARENT = /\/Parent(?![A-Za-z])/;
const PDF_OBJSTM = /\/Type\s*\/ObjStm(?![A-Za-z])/g;
const PDF_STREAM_START = /stream\r?\n/g;
/** Direct `/Length n` — not an indirect `/Length n 0 R`. */
const PDF_DIRECT_LENGTH = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/;
/** End-of-line before `endstream`; not part of the stream data. */
const PDF_TRAILING_EOL = /\r?\n$|\r$/;
const PDF_HEADER = '%PDF-';

function latin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

/** Innermost `<< … >>` dictionary that contains `at`, with its end offset. */
function enclosingDict(text: string, at: number): { dict: string; end: number } | undefined {
  let depth = 0;
  let start = -1;
  for (let i = at; i > 0; i--) {
    if (text[i] === '>' && text[i - 1] === '>') {
      depth++;
      i--;
    } else if (text[i] === '<' && text[i - 1] === '<') {
      if (depth === 0) {
        start = i - 1;
        break;
      }
      depth--;
      i--;
    }
  }
  if (start < 0) return undefined;
  depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '<' && text[i + 1] === '<') {
      depth++;
      i++;
    } else if (text[i] === '>' && text[i + 1] === '>') {
      depth--;
      i++;
      if (depth === 0) return { dict: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return undefined;
}

/** A page-tree root (`/Type /Pages` without `/Parent`) and where it sits in the file. */
interface PageTreeRoot {
  at: number;
  count: number;
}

/** Page-tree roots in `text`, each placed at `at` (or at its own offset when `at` is omitted). */
function pageTreeRoots(text: string, at?: number): PageTreeRoot[] {
  const roots: PageTreeRoot[] = [];
  for (const match of text.matchAll(PDF_PAGES_TYPE)) {
    const dict = enclosingDict(text, match.index)?.dict;
    if (!dict || PDF_PARENT.test(dict)) continue;
    const count = PDF_COUNT.exec(dict)?.[1];
    if (count !== undefined) roots.push({ at: at ?? match.index, count: Number(count) });
  }
  return roots;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const stream = new Blob([bytes.slice()])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}

/** End offset of stream data: the direct `/Length`, else up to `endstream` less its EOL. */
function streamEnd(text: string, bodyStart: number, dict: string): number | undefined {
  const length = PDF_DIRECT_LENGTH.exec(dict)?.[1];
  if (length !== undefined && bodyStart + Number(length) <= text.length) {
    return bodyStart + Number(length);
  }
  const keyword = text.indexOf('endstream', bodyStart);
  if (keyword < 0) return undefined;
  const eol = PDF_TRAILING_EOL.exec(text.slice(bodyStart, keyword));
  return keyword - (eol?.[0].length ?? 0);
}

/** Page-tree roots inside FlateDecode object streams (`/Type /ObjStm`), placed at the stream. */
async function objectStreamRoots(text: string, bytes: Uint8Array): Promise<PageTreeRoot[]> {
  const roots: PageTreeRoot[] = [];
  for (const match of text.matchAll(PDF_OBJSTM)) {
    const found = enclosingDict(text, match.index);
    if (!found?.dict.includes('/FlateDecode')) continue;
    PDF_STREAM_START.lastIndex = found.end;
    const start = PDF_STREAM_START.exec(text);
    if (!start || text.slice(found.end, start.index).trim() !== '') continue;
    const bodyStart = start.index + start[0].length;
    const bodyEnd = streamEnd(text, bodyStart, found.dict);
    if (bodyEnd === undefined) continue;
    const inflated = await inflate(bytes.subarray(bodyStart, bodyEnd));
    if (inflated) roots.push(...pageTreeRoots(latin1(inflated), match.index));
  }
  return roots;
}

/**
 * Page count of a PDF: the `/Count` of the last page-tree root in file order,
 * so an incremental update that rewrites the page tree wins over the original.
 * Roots stored in compressed object streams are read too. `undefined` when no
 * root can be read (not a PDF, encrypted object streams, damaged file).
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | undefined> {
  const text = latin1(bytes);
  if (!text.startsWith(PDF_HEADER)) return undefined;
  const roots = [...pageTreeRoots(text), ...(await objectStreamRoots(text, bytes))];
  const last = roots.sort((a, b) => a.at - b.at).at(-1);
  return last && last.count > 0 ? last.count : undefined;
}
