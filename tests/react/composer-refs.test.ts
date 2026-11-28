/// <reference lib="dom" />
/// <reference lib="deno.ns" />
import { assert, assertEquals } from '@std/assert';
import { Window } from 'happy-dom';
import type { UserPart } from '../../src/interface/mod.ts';

const win = new Window({ url: 'http://localhost/' });
for (const key of [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLDivElement',
  'Text',
  'Range',
  'Selection',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'NodeFilter',
  'DocumentFragment',
]) {
  const value = key === 'window' ? win : (win as unknown as Record<string, unknown>)[key];
  const bound = /^(get|request|cancel)/.test(key)
    ? (value as (...args: unknown[]) => unknown).bind(win)
    : value;
  Object.defineProperty(globalThis, key, { value: bound, configurable: true, writable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// why: Specifiers held in values keep the type check off the React tree, which has its own.
const load = (path: string) => import(path);
const react = '../../react/node_modules';
const React = await load(`${react}/react/index.js`);
const { createRoot } = await load(`${react}/react-dom/client.js`);
const { ChatComposerInput } = await load(`${react}/@astryxdesign/core/dist/Chat/index.js`);
const { ChatComposerBar } = await load('../../react/src/ui/ChatComposerBar.tsx');
const { refToken } = await load('../../react/src/ui/composer-refs.tsx');
const { act, createElement: h } = React.default ?? React;

const REF = { type: 'ref', kind: 'document', id: 'doc-7' } as const;
const PARTS: UserPart[] = [{ type: 'text', text: 'Compare ' }, REF, { type: 'text', text: ' now' }];
const iface = { identity: { handle: 'helper' }, inputs: { text: true } };

type Props = Record<string, unknown>;
type Drawn = { props: Props };

/** The composer bar over a draft the test holds, as a chat controller does. */
async function bar(
  extra: Props = {},
  initial: { text: string; parts?: UserPart[] } = { text: '' },
) {
  const draft = { ...initial };
  const inputRef: {
    current: { insertToken(t: unknown): void; insertText(t: string): void } | null;
  } = { current: null };
  const sent: UserPart[][] = [];
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const draw = () =>
    root.render(
      h(ChatComposerBar, {
        iface,
        layout: 'row',
        pendingFiles: [],
        pendingVoice: [],
        pendingMessages: [],
        issues: [],
        isStreaming: false,
        inputRef,
        draftText: draft.text,
        draftParts: draft.parts,
        onDraftTextChange: (text: string) => {
          draft.text = text;
          draft.parts = undefined;
          draw();
        },
        onDraftPartsChange: (parts: UserPart[] | undefined) => {
          draft.parts = parts;
          draw();
        },
        onPendingFilesChange: () => {},
        onPendingVoiceChange: () => {},
        onSubmit: () => sent.push(draft.parts ?? []),
        ...extra,
      }),
    );
  await act(() => draw());
  return {
    draft,
    inputRef,
    chips: () => host.querySelectorAll('[data-astryx-token]').length,
    tokens: () => [...host.querySelectorAll('[data-astryx-token]')],
    words: () => host.querySelector('[contenteditable]')?.textContent,
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

/** An input that is today's, noting the props it was given. */
function slot() {
  const seen: Drawn[] = [];
  const Input = (props: Props) => {
    seen.push({ props });
    return h(ChatComposerInput, props);
  };
  return { Input, seen };
}

for (const layout of ['row', 'stacked']) {
  Deno.test(`the ${layout} composer draws the input it is given, with its triggers`, async () => {
    const { Input, seen } = slot();
    const triggers = [{ character: '@', searchSource: { search: () => [], bootstrap: () => [] } }];
    const drawn = await bar({ layout, inputComponent: Input, triggers });
    assert(seen.length > 0);
    assertEquals(seen.at(-1)?.props.triggers, triggers);
    await drawn.close();
  });
}

Deno.test('an inserted ref reaches the draft typed, between the words around it', async () => {
  const drawn = await bar();
  await act(() => {
    drawn.inputRef.current?.insertText('Compare ');
  });
  await act(() => {
    drawn.inputRef.current?.insertToken(refToken(REF));
  });
  assertEquals(drawn.chips(), 1);
  assertEquals(drawn.draft.parts?.slice(0, 2), [PARTS[0], REF]);
  await drawn.close();
});

for (const layout of ['row', 'stacked']) {
  Deno.test(`a saved draft drawn again in the ${layout} composer shows its chips`, async () => {
    const drawn = await bar({ layout }, { text: 'Compare doc-7 now', parts: PARTS });
    assertEquals(drawn.chips(), 1);
    assertEquals(drawn.draft.parts, PARTS);
    assertEquals(drawn.draft.text, 'Compare doc-7 now');
    await drawn.close();
  });
}

Deno.test('parts that no longer spell the words are not written over them', async () => {
  const drawn = await bar({}, { text: 'something else', parts: PARTS });
  assertEquals(drawn.chips(), 0);
  assertEquals(drawn.words(), 'something else');
  await drawn.close();
});

Deno.test("the live composer draws the input it is given, and keeps a ref's chip", async () => {
  const { Input, seen } = slot();
  const drawn = await bar(
    { isDisabled: false, iface: undefined, handle: 'helper', inputComponent: Input },
    { text: 'Compare doc-7 now', parts: PARTS },
  );
  assert(seen.length > 0);
  assertEquals(drawn.chips(), 1);
  await drawn.close();
});

/** Puts the caret in the middle of what a chip shows, as a click on it does. */
function caretInChip(chip: Element): void {
  let text: Node = chip;
  while (text.firstChild) text = text.firstChild;
  const range = document.createRange();
  range.setStart(text, 1);
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

Deno.test('an insert with the caret in a chip lands after it, not inside it', async () => {
  const drawn = await bar();
  await act(() => {
    drawn.inputRef.current?.insertToken(refToken(REF));
  });
  const other = { type: 'ref', kind: 'document', id: 'doc-9' } as const;
  for (const insert of [
    () => drawn.inputRef.current?.insertToken(refToken(other)),
    () => drawn.inputRef.current?.insertText('here'),
  ]) {
    const [first] = drawn.tokens();
    await act(() => caretInChip(first));
    await act(() => {
      insert();
    });
    assertEquals(first.textContent, 'doc-7');
    assertEquals(first.querySelector('[data-astryx-token]'), null);
  }
  const [first, second] = drawn.tokens();
  assertEquals(second.parentNode, first.parentNode);
  assertEquals(
    drawn.draft.parts?.filter((part) => part.type === 'ref'),
    [REF, other],
  );
  await drawn.close();
});
