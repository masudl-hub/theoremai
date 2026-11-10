import {
  editorStateJSONToMarkdown,
  markdownToEditorStateJSON,
} from '@astryxdesign/richtext/markdown';
import type { ProfileSystem, SystemLine, SystemPrompt } from '@theoremjs/agents/kernel';
import { linesOf, markupOf, parseSystemMarkup } from './system-markup.ts';

/**
 * A system prompt as the formatted view holds it. The draft holds the prompt as the file writes
 * it; the view and the code both show it as markup text (`system-markup.ts`), and `promptReader`
 * reads that text back, keeping each line nobody touched exactly as written.
 *
 * The document is flat: each prompt line opens with a `prompt-line` node holding its `when`, and
 * the blocks after it up to the next one are that line's body. Private text is a text style.
 */
type DocNode = {
  type: string;
  text?: string;
  style?: string;
  when?: string | null;
  children?: DocNode[];
  [field: string]: unknown;
};

const PROMPT_LINE = 'prompt-line';
const PRIVATE_NAME = '--private';
const PRIVATE_ON = '1';
const PRIVATE_STYLE = `${PRIVATE_NAME}: ${PRIVATE_ON};`;
/** Marks a private stretch through Markdown, which has no words for one. */
const OPEN = '';
const CLOSE = '';
const MARKER = /([])/;
const BLOCK_START = /^(\s*(?:#{1,6} |[-*] |\d+\. ))/;
const OPEN_AFTER_START = /(^|\n)(\s*(?:#{1,6} |[-*] |\d+\. ))/g;
const OPEN_THEN_SPACE = /([ \t]+)/g;
const SPACE_THEN_CLOSE = /([ \t]+)/g;
const WHEN = /^when ([^:]+): ?/;

const isPrivateStyle = (style = '') => style.includes(PRIVATE_NAME);

function docNode(value: unknown): DocNode {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new Error('The editor gave a node with no type.');
  }
  const { type } = value;
  if (typeof type !== 'string') throw new Error('The editor gave a node with no type.');
  const children =
    'children' in value && Array.isArray(value.children) ? value.children.map(docNode) : undefined;
  return { ...value, type, ...(children ? { children } : {}) };
}

function rootOf(json: string): DocNode {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || !('root' in parsed)) {
    throw new Error('The editor gave a document with no root.');
  }
  return docNode(parsed.root);
}

type Stretch = { text: string; isPrivate: boolean };

/** One line's `when`, and its body with each private stretch between markers. */
function lineBody(line: SystemPrompt): { when: string | null; body: string } {
  const parts = typeof line === 'string' ? [line] : line;
  const stretches: Stretch[] = parts.map((part) =>
    typeof part === 'string'
      ? { text: part, isPrivate: false }
      : { text: part.private, isPrivate: true },
  );
  const [first] = stretches;
  const match = first ? WHEN.exec(first.text) : null;
  if (first && match) first.text = first.text.slice(match[0].length);
  const body = stretches
    .map(({ text, isPrivate }) => {
      if (!isPrivate) return text;
      const start = BLOCK_START.exec(text)?.[1] ?? '';
      return `${start}${OPEN}${text.slice(start.length)}${CLOSE}`;
    })
    .join('');
  return { when: match?.[1] ?? null, body };
}

/** The body's blocks, with each marker turned into the private style on the text it covers. */
function blocksOf(body: string): DocNode {
  const root = rootOf(markdownToEditorStateJSON(body));
  let inPrivate = false;
  const walk = (node: DocNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'text') {
        walk(child);
        return [child];
      }
      return (child.text ?? '').split(MARKER).flatMap((piece) => {
        if (piece === OPEN) inPrivate = true;
        if (piece === CLOSE) inPrivate = false;
        if (!piece || piece === OPEN || piece === CLOSE) return [];
        return [{ ...child, text: piece, style: inPrivate ? PRIVATE_STYLE : '' }];
      });
    });
  };
  walk(root);
  return root;
}

const EMPTY_LINE: DocNode = { type: 'paragraph', version: 1, children: [] };

/** The document for a prompt's lines, as the JSON the editor opens. */
function promptDoc(lines: readonly SystemPrompt[]): string {
  const roots = lines.map(lineBody).map(({ when, body }) => ({ when, root: blocksOf(body) }));
  const shell = roots[0]?.root ?? rootOf(markdownToEditorStateJSON(''));
  // invariant: the editor refuses an empty root, so a blank prompt opens on an empty paragraph.
  if (roots.length === 0) return JSON.stringify({ root: { ...shell, children: [EMPTY_LINE] } });
  const children = roots.flatMap(({ when, root }, at) => {
    const blocks = root.children ?? [];
    // why: lines side by side under one `when` read as one stretch; `withWhen` writes it back.
    const continues = when !== null && roots[at - 1]?.when === when;
    return continues ? blocks : [{ type: PROMPT_LINE, version: 1, when }, ...blocks];
  });
  return JSON.stringify({ root: { ...shell, children } });
}

type Leaf = { siblings: DocNode[]; node: DocNode };

function leavesOf(nodes: DocNode[]): Leaf[] {
  return nodes.flatMap((node) =>
    node.children
      ? leavesOf(node.children)
      : typeof node.text === 'string'
        ? [{ siblings: nodes, node }]
        : [],
  );
}

const marker = (text: string): DocNode => ({
  type: 'text',
  version: 1,
  text,
  format: 0,
  mode: 'normal',
  style: '',
  detail: 0,
});

/**
 * A body with its `when` on each stretch a blank line starts, since markup ends a line there
 * unless a private stretch holds it open.
 */
function withWhen(when: string | null | undefined, body: string): string {
  if (!when) return body;
  let held = false;
  return body
    .split('\n\n')
    .map((chunk) => {
      const starts = !held;
      const opens = chunk.lastIndexOf(OPEN);
      const closes = chunk.lastIndexOf(CLOSE);
      if (opens !== closes) held = opens > closes;
      if (!starts) return chunk;
      return chunk.startsWith(OPEN)
        ? `${OPEN}when ${when}: ${chunk.slice(OPEN.length)}`
        : `when ${when}: ${chunk}`;
    })
    .join('\n\n');
}

/** One line's blocks back as markup, with the markers in place of the private style. */
function lineMarkup(when: string | null | undefined, blocks: DocNode[], shell: DocNode): string {
  const copy = structuredClone(blocks);
  let inPrivate = false;
  let last: Leaf | undefined;
  for (const leaf of leavesOf(copy)) {
    const held = isPrivateStyle(leaf.node.style);
    if (held && !inPrivate) leaf.siblings.splice(leaf.siblings.indexOf(leaf.node), 0, marker(OPEN));
    if (!held && inPrivate && last) {
      last.siblings.splice(last.siblings.indexOf(last.node) + 1, 0, marker(CLOSE));
    }
    inPrivate = held;
    leaf.node.style = '';
    last = leaf;
  }
  if (inPrivate && last) {
    last.siblings.splice(last.siblings.indexOf(last.node) + 1, 0, marker(CLOSE));
  }
  const body = editorStateJSONToMarkdown(JSON.stringify({ root: { ...shell, children: copy } }));
  if (!body.trim()) return '';
  // why: `{private: ` has to stand before a line's block mark for the mark to stay a mark, so the
  // first private stretch of a block opens ahead of it.
  const opened = body
    .replace(OPEN_AFTER_START, (_, before: string, start: string) => `${before}${OPEN}${start}`)
    // invariant: private text is trimmed, so the spaces at its edges stand outside it.
    .replace(OPEN_THEN_SPACE, `$1${OPEN}`)
    .replace(SPACE_THEN_CLOSE, `${CLOSE}$1`)
    .replaceAll(`${OPEN}${CLOSE}`, '');
  return withWhen(when, opened).replaceAll(OPEN, '{private: ').replaceAll(CLOSE, '}');
}

/** The document for markup text that parses. */
function openedDoc(text: string): string | undefined {
  const parsed = parseSystemMarkup(text);
  return parsed.ok ? promptDoc(parsed.lines) : undefined;
}

/** The markup text for what the editor holds. */
function promptMarkup(json: string): string {
  const { children = [], ...shell } = rootOf(json);
  const lines: { when: string | null | undefined; blocks: DocNode[] }[] = [];
  for (const node of children) {
    if (node.type === PROMPT_LINE) lines.push({ when: node.when, blocks: [] });
    else if (lines.at(-1)) lines.at(-1)?.blocks.push(node);
    else lines.push({ when: null, blocks: [node] });
  }
  return lines
    .map(({ when, blocks }) => lineMarkup(when, blocks, shell))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * A line as what it says and what it keeps private, with a private stretch's `when` and block mark
 * outside it. Where those stand doesn't change what is sent, and the document keeps one place.
 */
function settledLine(line: SystemPrompt): Stretch[] {
  const runs: Stretch[] = [];
  const add = (text: string, isPrivate: boolean) => {
    const last = runs.at(-1);
    if (last?.isPrivate === isPrivate) last.text += text;
    else if (text) runs.push({ text, isPrivate });
  };
  (typeof line === 'string' ? [line] : line).forEach((part, at) => {
    if (typeof part === 'string') {
      add(part, false);
      return;
    }
    const when = at === 0 ? (WHEN.exec(part.private)?.[0] ?? '') : '';
    const rest = part.private.slice(when.length);
    const start = BLOCK_START.exec(rest)?.[1] ?? '';
    add(`${when}${start}`, false);
    add(rest.slice(start.length), true);
  });
  return runs;
}

/** A `when`'s checks, each as `name is value`. */
const checksOf = (when: string | null): string[] => (when ? when.split(' and ') : []);

/** One `when` holds one value; picking the value it already has takes it off. */
function withCheck(when: string | null, name: string, value: string): string | null {
  const check = `${name} is ${value}`;
  const had = checksOf(when);
  const rest = had.filter((each) => !each.startsWith(`${name} is `));
  return (had.includes(check) ? rest : [...rest, check]).join(' and ') || null;
}

/** The `when` left once one check is off. */
const withoutCheck = (when: string | null, check: string): string | null =>
  checksOf(when)
    .filter((each) => each !== check)
    .join(' and ') || null;

/** Whether two markup texts hold the same prompt, however each is written. */
function samePrompt(a: string, b: string): boolean {
  if (a === b) return true;
  const left = parseSystemMarkup(a);
  const right = parseSystemMarkup(b);
  if (!left.ok || !right.ok) return a === b;
  return (
    JSON.stringify(left.lines.map(settledLine)) === JSON.stringify(right.lines.map(settledLine))
  );
}

/**
 * Why this text can't open formatted, if it can't: its markup is broken, or the document would
 * not give the same prompt back. Those stay in the code view, where every character is the author's.
 */
function promptDocProblem(text: string): string | undefined {
  const parsed = parseSystemMarkup(text);
  if (!parsed.ok) return parsed.message;
  if (samePrompt(promptMarkup(promptDoc(parsed.lines)), text)) return undefined;
  return 'This prompt holds text the formatted view would change, so it stays in code.';
}

/** A prompt read back from markup, or why the markup doesn't read. */
type PromptRead = { ok: true; system: ProfileSystem } | { ok: false; message: string };

/** The lines a written line comes back as once shown as markup, and once opened formatted. */
type PromptForms = Map<string, SystemLine[][]>;

const sameLines = (a: readonly unknown[], b: readonly unknown[]) =>
  JSON.stringify(a) === JSON.stringify(b);

function formsOf(line: SystemLine, forms: PromptForms): SystemLine[][] {
  const key = JSON.stringify(line);
  const known = forms.get(key);
  if (known) return known;
  const shown = parseSystemMarkup(markupOf([line]));
  const found: SystemLine[][] = [];
  if (shown.ok && shown.lines.length > 0) {
    found.push(shown.lines);
    const viewed = parseSystemMarkup(promptMarkup(promptDoc(shown.lines)));
    if (viewed.ok && viewed.lines.length > 0 && !sameLines(viewed.lines, shown.lines)) {
      found.push(viewed.lines);
    }
  }
  forms.set(key, found);
  return found;
}

/**
 * Reads markup back into a prompt. Lines that come back as a line of `written` came back from
 * showing, came back untouched, so they stay as written, to the byte; the rest are read from the
 * text. The first of `written` gives the shape: a prompt written as one text stays one text while
 * it is one line.
 * invariant: showing a prompt and reading it back, untouched, gives the same prompt.
 */
function promptReader(
  written: readonly ProfileSystem[],
  forms: PromptForms = new Map(),
): (text: string) => PromptRead {
  const known = written
    .flatMap(linesOf)
    .flatMap((line) => formsOf(line, forms).map((form) => ({ line, form })))
    .sort((a, b) => b.form.length - a.form.length);
  const [shape] = written;
  return (text) => {
    const parsed = parseSystemMarkup(text);
    if (!parsed.ok) return parsed;
    const kept: SystemLine[] = [];
    for (let at = 0; at < parsed.lines.length; ) {
      const match = known.find(({ form }) =>
        sameLines(form, parsed.lines.slice(at, at + form.length)),
      );
      kept.push(match ? match.line : (parsed.lines[at] as SystemLine));
      at += match ? match.form.length : 1;
    }
    const [only, ...rest] = kept;
    const isText = shape === undefined || typeof shape === 'string';
    if (only === undefined) return { ok: true, system: '' };
    return {
      ok: true,
      system: isText && rest.length === 0 && typeof only === 'string' ? only : kept,
    };
  };
}

export type { PromptForms, PromptRead };
export {
  checksOf,
  openedDoc,
  PRIVATE_NAME,
  PRIVATE_ON,
  PROMPT_LINE,
  promptDoc,
  promptDocProblem,
  promptMarkup,
  promptReader,
  samePrompt,
  withCheck,
  withoutCheck,
};
