import { Badge } from '@astryxdesign/core/Badge';
import type { ChatComposerInputHandle, ChatComposerToken } from '@astryxdesign/core/Chat';
import {
  hasRef,
  messageParts,
  type RefText,
  refIdText,
  textOfParts,
  type UserPart,
  type UserRef,
} from '@theoremjs/agents/interface';
import {
  createContext,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

/** How the host writes and draws its refs. */
export type RefTokenOptions = {
  /** Writes a ref into the message's text; the ref's id when absent. Give the server the same one. */
  refText?: RefText;
  /** Draws a ref's chip; a badge of its text when absent. */
  renderRef?: (ref: UserRef) => ReactNode;
};

// invariant: This file is the one that reads the input's own markup, which a host's input keeps.
const TOKEN = '[data-astryx-token]';
const tokenRefs = new WeakMap<Element, UserRef>();
const RefMounted = createContext<(() => void) | undefined>(undefined);

/** Marks the token around it with its ref, which is what makes a chip a ref. */
function RefChip({ target, children }: { target: UserRef; children: ReactNode }) {
  const own = useRef<HTMLSpanElement>(null);
  const mounted = useContext(RefMounted);
  // why: The input draws a token's content after the insert, so the draft is read again here.
  useLayoutEffect(() => {
    const token = own.current?.closest(TOKEN);
    if (!token) return;
    tokenRefs.set(token, target);
    mounted?.();
  }, [target, mounted]);
  return <span ref={own}>{children}</span>;
}

/**
 * A ref as a chip for the composer's input: give it to `inputRef.current.insertToken`, or return it
 * from a trigger's `onSelect`. Only a chip made here reaches the message as a ref.
 */
export function refToken(
  ref: Omit<UserRef, 'type'>,
  { refText = refIdText, renderRef }: RefTokenOptions = {},
): ChatComposerToken {
  const target: UserRef = { type: 'ref', kind: ref.kind, id: ref.id };
  const value = refText(target);
  return {
    value,
    render: () => (
      <RefChip target={target}>{renderRef?.(target) ?? <Badge label={value} />}</RefChip>
    ),
  };
}

function addWords(parts: UserPart[], text: string): void {
  const last = parts.at(-1);
  if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + text };
  else if (text) parts.push({ type: 'text', text });
}

function readElement(element: Element, parts: UserPart[], range: Range | undefined): void {
  if (element.matches(TOKEN)) {
    const ref = tokenRefs.get(element);
    if (ref) parts.push(ref);
    else addWords(parts, element.getAttribute('data-astryx-token-value') ?? '');
  } else if (element.tagName === 'BR') addWords(parts, '\n');
  else readInto(element, parts, range);
}

/** The text of `node`, cut to what `range` selects of it. */
function textIn(node: Node, range: Range | undefined): string {
  const text = node.textContent ?? '';
  const from = range?.startContainer === node ? range.startOffset : 0;
  const to = range?.endContainer === node ? range.endOffset : text.length;
  return text.slice(from, to);
}

/** Reads `node` into `parts`; with a `range`, only what it selects. */
function readInto(node: Node, parts: UserPart[], range?: Range): void {
  for (const child of node.childNodes) {
    if (range && !range.intersectsNode(child)) continue;
    if (child.nodeType === 3) addWords(parts, textIn(child, range));
    else if (child.nodeType === 1) readElement(child as Element, parts, range);
  }
}

/** The editor's words and refs, as the input's own value reads them; undefined with no ref. */
function readEditorParts(editor: Element, range?: Range): UserPart[] | undefined {
  const parts: UserPart[] = [];
  readInto(editor, parts, range);
  return hasRef(parts) ? parts : undefined;
}

/** Puts `parts` in at the caret through the input's handle, each ref a chip again. */
function insertParts(
  editor: Element,
  handle: ChatComposerInputHandle,
  parts: readonly UserPart[],
  options: RefTokenOptions,
): void {
  for (const part of parts) {
    if (part.type === 'text') {
      handle.insertText(part.text);
      continue;
    }
    const id = handle.insertToken(refToken(part, options));
    const token = id && editor.querySelector(`[data-astryx-token-id="${id}"]`);
    if (!token) continue;
    tokenRefs.set(token, part);
    // why: The input adds a space after each token; the parts' own words already hold theirs.
    token.nextSibling?.remove();
  }
}

/** Fills an empty editor with `parts`, leaving focus where it was. */
function writeEditorParts(
  editor: HTMLElement,
  handle: ChatComposerInputHandle,
  parts: readonly UserPart[],
  options: RefTokenOptions,
): void {
  const focused = editor.ownerDocument.activeElement === editor;
  editor.textContent = '';
  insertParts(editor, handle, parts, options);
  if (!focused) editor.blur();
}

function editorIn(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  const selector = '[contenteditable]';
  return root.matches(selector) ? root : root.querySelector<HTMLElement>(selector);
}

function chipAround(editor: Element, node: Node): Element | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const chip = element?.closest(TOKEN);
  return chip && editor.contains(chip) ? chip : null;
}

/** Moves each end of `range` that sits inside a chip to just after it; true when one moved. */
function movedOutOfChips(editor: Element, range: Range): boolean {
  const start = chipAround(editor, range.startContainer);
  const end = chipAround(editor, range.endContainer);
  if (start) range.setStartAfter(start);
  if (end) range.setEndAfter(end);
  return Boolean(start || end);
}

/** Takes the editor's selection out of any chip. */
function leaveChips(editor: Element | null): void {
  const selection = editor?.ownerDocument.defaultView?.getSelection();
  if (!editor || !selection?.rangeCount) return;
  const range = selection.getRangeAt(0).cloneRange();
  if (!movedOutOfChips(editor, range)) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The input's handle, whose inserts never land inside a chip. */
function outsideChips(
  input: ChatComposerInputHandle,
  editor: () => Element | null,
): ChatComposerInputHandle {
  return {
    insertToken: (token) => {
      leaveChips(editor());
      return input.insertToken(token);
    },
    insertText: (text) => {
      leaveChips(editor());
      input.insertText(text);
    },
    expandToken: (id) => input.expandToken(id),
    focus: () => input.focus(),
    getValue: () => input.getValue(),
  };
}

/** The editor's selection, when it has one. */
function selectionIn(editor: Element): Range | undefined {
  const selection = editor.ownerDocument.defaultView?.getSelection();
  if (!selection?.rangeCount) return undefined;
  const range = selection.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer) ? range : undefined;
}

function selectAll(editor: Element): void {
  const selection = editor.ownerDocument.defaultView?.getSelection();
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

// invariant: The clipboard carries only a key; the refs stay in memory, so a paste can make no ref
// that was not copied from a composer on this page.
const CLIP = 'application/x-theorem-parts';
let clipped: { key: string; parts: UserPart[] } | undefined;

/** What the editor has selected, as a range holding any chip it touches whole. */
function wholeChips(editor: Element): Range | undefined {
  const selected = selectionIn(editor);
  if (!selected || selected.collapsed) return undefined;
  const range = selected.cloneRange();
  const start = chipAround(editor, range.startContainer);
  const end = chipAround(editor, range.endContainer);
  if (start) range.setStartBefore(start);
  if (end) range.setEndAfter(end);
  return range;
}

/** Copies a selection that holds a chip; any other is left to the browser. */
function copyChips(editor: HTMLElement, event: ClipboardEvent, refText: RefText | undefined): void {
  const range = wholeChips(editor);
  const parts = range && readEditorParts(editor, range);
  if (!range || !parts || !event.clipboardData) return;
  // why: Not `randomUUID`, which a page served over plain HTTP lacks.
  clipped = { key: `${Date.now()}-${Math.random()}`, parts };
  event.clipboardData.setData('text/plain', textOfParts(parts, refText));
  event.clipboardData.setData(CLIP, clipped.key);
  event.preventDefault();
  event.stopPropagation();
  if (event.type !== 'cut' || editor.getAttribute('contenteditable') === 'false') return;
  range.deleteContents();
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The parts a paste brings from a composer; undefined for anything from elsewhere. */
function pastedParts(event: ClipboardEvent): UserPart[] | undefined {
  const key = event.clipboardData?.getData(CLIP);
  return key && key === clipped?.key ? clipped.parts : undefined;
}

type ComposerEvents = {
  editor: () => HTMLElement | null;
  handle: () => ChatComposerInputHandle | null;
  options: () => RefTokenOptions;
  /** Reads the field into the draft. */
  read: () => void;
  /** A key was pressed in the field. */
  key: (key: string, shift: boolean) => void;
  /** The key came up: what it changes next is not its doing. */
  released: () => void;
};

/** Pastes a composer's copy as chips; an outside paste goes on to the input, past any chip. */
function pasteChips(editor: HTMLElement, event: ClipboardEvent, field: ComposerEvents): void {
  leaveChips(editor);
  const parts = pastedParts(event);
  const handle = field.handle();
  if (!parts || !handle) return;
  event.preventDefault();
  event.stopPropagation();
  if (editor.getAttribute('contenteditable') === 'false') return;
  insertParts(editor, handle, parts, field.options());
  field.read();
}

/** Typing with the caret in a chip goes after it, never inside. */
function typePastChips(editor: HTMLElement, event: InputEvent, field: ComposerEvents): void {
  if (event.isComposing || !event.inputType.startsWith('insert')) return;
  const at = selectionIn(editor)?.startContainer;
  if (!at || !chipAround(editor, at)) return;
  if (event.inputType !== 'insertText' || !event.data) {
    leaveChips(editor);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  field.handle()?.insertText(event.data);
}

/**
 * Moves the caret out of a chip before a key writes: a chip takes no input, so the browser would
 * drop the character.
 */
function keyPastChips(editor: HTMLElement, event: KeyboardEvent): void {
  const writes = event.key.length === 1 || event.key === 'Process' || event.key === 'Unidentified';
  if (writes && !event.ctrlKey && !event.metaKey) leaveChips(editor);
}

/**
 * Hears the field's own events before the input does. On the document, so a field drawn again
 * needs no new listeners.
 */
function listenToField(field: ComposerEvents): () => void {
  const heard: [string, (editor: HTMLElement, event: Event) => void][] = [
    ['copy', (editor, e) => copyChips(editor, e as ClipboardEvent, field.options().refText)],
    ['cut', (editor, e) => copyChips(editor, e as ClipboardEvent, field.options().refText)],
    ['paste', (editor, e) => pasteChips(editor, e as ClipboardEvent, field)],
    ['beforeinput', (editor, e) => typePastChips(editor, e as InputEvent, field)],
    [
      'keydown',
      (editor, e) => {
        const event = e as KeyboardEvent;
        keyPastChips(editor, event);
        field.key(event.key, event.shiftKey);
      },
    ],
    ['keyup', () => field.released()],
  ];
  const page = field.editor()?.ownerDocument ?? document;
  const added = heard.map(([type, act]) => {
    const listener = (event: Event) => {
      const editor = field.editor();
      if (editor && event.composedPath().includes(editor)) act(editor, event);
    };
    page.addEventListener(type, listener, true);
    return () => page.removeEventListener(type, listener, true);
  });
  return () => {
    for (const remove of added) remove();
  };
}

/**
 * The refs of messages sent from the field, by their words: the input's ↑ history keeps words
 * alone. Two sent with the same words give back the later one's refs.
 */
function useRecall(editor: () => HTMLElement | null, words: () => string) {
  const kept = useRef(new Map<string, UserPart[]>());
  const recalling = useRef(false);
  const reselect = useRef(false);
  return useRef({
    key(key: string, shift: boolean) {
      recalling.current = key === 'ArrowUp' || key === 'ArrowDown';
      const sends = key === 'Enter' && !shift;
      const field = editor();
      if (!field || !(sends || recalling.current)) return;
      const parts = messageParts(readEditorParts(field));
      if (parts) kept.current.set(words().trim(), parts);
      else if (sends) kept.current.delete(words().trim());
    },
    released() {
      recalling.current = false;
    },
    /** The refs of `text`, when an arrow key has just brought it back. */
    recalled(text: string): UserPart[] | undefined {
      const parts = recalling.current ? kept.current.get(text.trim()) : undefined;
      reselect.current = Boolean(parts);
      return parts;
    },
    /** Selects a recalled message again, so the next ↑ steps on as the input's own recall does. */
    written(field: Element) {
      if (reselect.current) selectAll(field);
      reselect.current = false;
    },
  }).current;
}

export type EditorRefsArgs = RefTokenOptions & {
  /** The input's root element. */
  rootRef: RefObject<HTMLElement | null>;
  /** The host's handle on the input. */
  inputRef: Ref<ChatComposerInputHandle> | undefined;
  /** Names what the field was drawn as; a change means it was drawn again. */
  drawn: unknown;
  value: string;
  parts: readonly UserPart[] | undefined;
  onChange: (text: string) => void;
  onParts: ((parts: UserPart[] | undefined) => void) | undefined;
};

/**
 * Keeps a draft's refs with its input: reads them as the person edits, and makes their chips again
 * when the input is drawn from a saved draft, which it would otherwise show as plain text.
 */
export function useEditorRefs(args: EditorRefsArgs) {
  const latest = useRef(args);
  latest.current = args;
  const handle = useRef<ChatComposerInputHandle | null>(null);
  const writing = useRef(false);
  const drawnAs = useRef(args.drawn);

  const editor = useCallback(() => editorIn(latest.current.rootRef.current), []);
  const { inputRef } = args;
  const handleRef = useCallback(
    (input: ChatComposerInputHandle | null) => {
      // why: An insert with the caret in a chip, as after a click on it, would nest a chip in it.
      const node = input && outsideChips(input, editor);
      handle.current = node;
      if (typeof inputRef === 'function') inputRef(node);
      else if (inputRef) inputRef.current = node;
    },
    [inputRef, editor],
  );
  const report = useCallback(() => {
    const field = editor();
    if (field && !writing.current) latest.current.onParts?.(readEditorParts(field));
  }, [editor]);
  const recall = useRecall(editor, () => handle.current?.getValue() ?? '');
  const onChange = useCallback(
    (text: string) => {
      if (writing.current) return;
      latest.current.onChange(text);
      const parts = recall.recalled(text);
      if (parts) latest.current.onParts?.(parts);
      else report();
    },
    [report, recall],
  );
  useEffect(
    () =>
      listenToField({
        editor,
        handle: () => handle.current,
        options: () => latest.current,
        read: () => {
          const text = handle.current?.getValue();
          if (text !== undefined && text !== latest.current.value) latest.current.onChange(text);
          report();
        },
        key: recall.key,
        released: recall.released,
      }),
    [editor, report, recall],
  );

  const { value, parts, drawn } = args;
  useEffect(() => {
    const editor = editorIn(latest.current.rootRef.current);
    drawnAs.current = drawn;
    if (!editor || !handle.current || !hasRef(parts)) return;
    // invariant: Words the draft's parts no longer spell are never written over.
    if (textOfParts(parts, latest.current.refText).trim() !== value.trim()) return;
    // why: A field that has its chips is the draft's source; only one that lost them is written.
    const refs = parts.filter((part) => part.type === 'ref').length;
    if (editor.querySelectorAll(TOKEN).length >= refs) return;
    writing.current = true;
    try {
      writeEditorParts(editor, handle.current, parts, latest.current);
    } finally {
      writing.current = false;
    }
    const written = handle.current.getValue();
    if (written !== value) latest.current.onChange(written);
    report();
    recall.written(editor);
  }, [value, parts, drawn, report, recall]);

  return {
    handleRef,
    handle,
    onChange,
    report,
    /** Wrap the input in this, so its chips are read once drawn. */
    provide: (input: ReactNode) => (
      <RefMounted.Provider value={report}>{input}</RefMounted.Provider>
    ),
  };
}
