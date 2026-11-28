import { Badge } from '@astryxdesign/core/Badge';
import type { ChatComposerInputHandle, ChatComposerToken } from '@astryxdesign/core/Chat';
import {
  hasRef,
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

function readElement(element: Element, parts: UserPart[]): void {
  if (element.matches(TOKEN)) {
    const ref = tokenRefs.get(element);
    if (ref) parts.push(ref);
    else addWords(parts, element.getAttribute('data-astryx-token-value') ?? '');
  } else if (element.tagName === 'BR') addWords(parts, '\n');
  else readInto(element, parts);
}

function readInto(node: Node, parts: UserPart[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) addWords(parts, child.textContent ?? '');
    else if (child.nodeType === 1) readElement(child as Element, parts);
  }
}

/** The editor's words and refs, as the input's own value reads them; undefined with no ref. */
function readEditorParts(editor: Element): UserPart[] | undefined {
  const parts: UserPart[] = [];
  readInto(editor, parts);
  return hasRef(parts) ? parts : undefined;
}

/** Fills an empty editor with `parts` through the input's handle, each ref a chip again. */
function writeEditorParts(
  editor: HTMLElement,
  handle: ChatComposerInputHandle,
  parts: readonly UserPart[],
  options: RefTokenOptions,
): void {
  const focused = editor.ownerDocument.activeElement === editor;
  editor.textContent = '';
  for (const part of parts) {
    if (part.type === 'text') {
      handle.insertText(part.text);
      continue;
    }
    const id = handle.insertToken(refToken(part, options));
    const token = id && editor.querySelector(`[data-astryx-token-id="${id}"]`);
    if (!token) continue;
    tokenRefs.set(token, part);
    // why: The input adds a space after each token; the draft's own words already hold theirs.
    token.nextSibling?.remove();
  }
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

/** Moves each end of the selection that sits inside a chip to just after that chip. */
function leaveChips(editor: Element | null): void {
  const selection = editor?.ownerDocument.defaultView?.getSelection();
  if (!editor || !selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const start = chipAround(editor, range.startContainer);
  const end = chipAround(editor, range.endContainer);
  if (!start && !end) return;
  const moved = range.cloneRange();
  if (start) moved.setStartAfter(start);
  if (end) moved.setEndAfter(end);
  selection.removeAllRanges();
  selection.addRange(moved);
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

  const { inputRef } = args;
  const handleRef = useCallback(
    (input: ChatComposerInputHandle | null) => {
      // why: An insert with the caret in a chip, as after a click on it, would nest a chip in it.
      const node = input && outsideChips(input, () => editorIn(latest.current.rootRef.current));
      handle.current = node;
      if (typeof inputRef === 'function') inputRef(node);
      else if (inputRef) inputRef.current = node;
    },
    [inputRef],
  );
  const report = useCallback(() => {
    const editor = editorIn(latest.current.rootRef.current);
    if (editor && !writing.current) latest.current.onParts?.(readEditorParts(editor));
  }, []);
  const onChange = useCallback(
    (text: string) => {
      if (writing.current) return;
      latest.current.onChange(text);
      report();
    },
    [report],
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
  }, [value, parts, drawn, report]);

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
