import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { RichTextEditor, RichTextEditorToolbar } from '@astryxdesign/richtext';
import '@astryxdesign/richtext/richtext.css';
import { $isListItemNode, $isListNode } from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelectionStyleValueForProperty, $patchStyleText } from '@lexical/selection';
import { IconFilter, IconShareOff } from '@tabler/icons-react';
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isRootNode,
  $setSelection,
  $splitNode,
  type BaseSelection,
  type LexicalNode,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {
  type ComponentProps,
  type MouseEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { openedDoc, PRIVATE_NAME, PRIVATE_ON, promptMarkup, samePrompt } from '../prompt-doc.ts';
import { ChangeHeld } from './inspector-context.ts';
import { $isPromptLine, optionItems, PromptLineNode, PromptOptions } from './prompt-line-node.tsx';
import './prompt-editor.css';

const NODES = [PromptLineNode];
const MIN_HEIGHT = '16rem';
const PRIVATE_HINT = 'Private: the model reads this, and a reply that repeats it is stopped.';
const HINT_DELAY_MS = 200;
const BLOCK_HINT = 'Text style: paragraph, heading, list or quote';
const FORMAT_LABELS = new Set(['Bold', 'Italic', 'Underline', 'Strikethrough', 'Inline code']);

/** Keeps the selection when a toolbar button is pressed. */
const keepSelection = (event: MouseEvent) => {
  event.preventDefault();
};

/** The block a node sits in: its list item, or else the child of the root. */
function $topOf(node: LexicalNode): LexicalNode {
  let at = node;
  for (let parent = at.getParent(); parent && !$isRootNode(parent); parent = at.getParent()) {
    if ($isListItemNode(at) && $isRootNode(parent.getParent())) return at;
    at = parent;
  }
  return at;
}

/** The child of the root a block sits in. */
const $blockOf = (top: LexicalNode): LexicalNode => {
  const list = top.getParent();
  return $isListItemNode(top) && list ? list : top;
};

/** The line a block belongs to. */
function $headOf(block: LexicalNode | null): PromptLineNode | null {
  for (let at = block; at; at = at.getPreviousSibling()) {
    if ($isPromptLine(at)) return at;
  }
  return null;
}

/** Splits a block's list after, or before, an item, so the item can stand apart from the rest. */
function $splitListAt(item: LexicalNode, offset: number) {
  const list = item.getParent();
  if ($isListNode(list)) $splitNode(list, offset);
}

/** The first and last block a selection touches, in reading order. */
function $selectedEnds(selection: RangeSelection) {
  const [from, to] = selection.isBackward()
    ? [selection.focus, selection.anchor]
    : [selection.anchor, selection.focus];
  return { first: $topOf(from.getNode()), last: $topOf(to.getNode()) };
}

/** The `when` of the line a block belongs to. */
const $whenOf = (top: LexicalNode): string | null => $headOf($blockOf(top))?.getWhen() ?? null;

/** Lets the blocks from `first` to `last` stand apart from the rest of their lists. */
function $standApart(first: LexicalNode, last: LexicalNode) {
  if ($isListItemNode(last) && last.getNextSibling()) {
    $splitListAt(last, last.getIndexWithinParent() + 1);
  }
  if ($isListItemNode(first) && first.getPreviousSibling()) {
    $splitListAt(first, first.getIndexWithinParent());
  }
}

/** Joins `start` to `end` into one line, and what follows keeps the `when` it had. */
function $closeLine(start: LexicalNode, end: LexicalNode, tail: string | null) {
  for (let at: LexicalNode | null = start; at && !at.is(end); ) {
    const after: LexicalNode | null = at.getNextSibling();
    if ($isPromptLine(at)) at.remove();
    at = after;
  }
  const after = end.getNextSibling();
  if (after && !$isPromptLine(after)) end.insertAfter(new PromptLineNode(tail));
}

/** Starts the line at `start` under `next`, and neighbours under one `when` join back up. */
function $openLine(start: LexicalNode, end: LexicalNode, next: string | null) {
  const before = start.getPreviousSibling();
  const head = $isPromptLine(before) ? before.setWhen(next) : new PromptLineNode(next);
  if (!$isPromptLine(before)) start.insertBefore(head);
  if (!next) return;
  const following = end.getNextSibling();
  if ($isPromptLine(following) && following.getWhen() === next) following.remove();
  const above = head.getPreviousSibling();
  if (above && $headOf(above)?.getWhen() === next) head.remove();
}

/** Sets the `when` on what is selected, or on the block the caret is in. */
function $setWhen(next: string | null) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const { first, last } = $selectedEnds(selection);
  const when = $whenOf(first);
  const tail = $whenOf(last);
  if (next === when && when === tail) return;
  $standApart(first, last);
  const start = $blockOf(first);
  const end = $blockOf(last);
  $closeLine(start, end, tail);
  $openLine(start, end, next);
}

/** The Private and Option buttons, on the toolbar's end. */
function PromptTools() {
  const [editor] = useLexicalComposerContext();
  const options = useContext(PromptOptions);
  const [isPrivate, setIsPrivate] = useState(false);
  const [when, setWhen] = useState<string | null>(null);
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const selection = $getSelection();
          const isRange = $isRangeSelection(selection);
          setIsPrivate(
            isRange &&
              $getSelectionStyleValueForProperty(selection, PRIVATE_NAME, '') === PRIVATE_ON,
          );
          const block = isRange ? $blockOf($topOf(selection.anchor.getNode())) : null;
          setWhen($headOf(block)?.getWhen() ?? null);
        });
      }),
    [editor],
  );
  return (
    <>
      <ToggleButton
        label="Private"
        tooltip={PRIVATE_HINT}
        size="sm"
        isIconOnly
        icon={<Icon icon={IconShareOff} size="sm" />}
        isPressed={isPrivate}
        onMouseDown={keepSelection}
        onPressedChange={() => {
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            $patchStyleText(selection, { [PRIVATE_NAME]: isPrivate ? null : PRIVATE_ON });
          });
        }}
      />
      {options.length > 0 && (
        <DropdownMenu
          renderTrigger={(props) => (
            <ToggleButton
              {...props}
              label="Option"
              tooltip="Send this part only on turns where an option fits"
              size="sm"
              isIconOnly
              icon={<Icon icon={IconFilter} size="sm" />}
              isPressed={Boolean(when)}
              onMouseDown={keepSelection}
            />
          )}
          items={optionItems(options, when, (next) => {
            editor.update(() => {
              $setWhen(next);
            });
          })}
        />
      )}
    </>
  );
}

/**
 * Whether a block sits in the private container: it opens and closes on private words. Shared
 * words inside it show as cut-outs; a block that opens or closes shared marks only its private
 * words.
 */
function $isPrivateBlock(block: LexicalNode | null): boolean {
  if (!block || $isPromptLine(block) || !$isElementNode(block)) return false;
  const words = block.getAllTextNodes().filter((text) => text.getTextContent().trim() !== '');
  const isPrivate = (text: TextNode | undefined) =>
    text?.getStyle().includes(PRIVATE_NAME) === true;
  return isPrivate(words.at(0)) && isPrivate(words.at(-1));
}

/** The block beside this one, past a line's opening that states no option. */
function $besideOf(block: LexicalNode, step: (at: LexicalNode) => LexicalNode | null) {
  let at = step(block);
  while ($isPromptLine(at) && at.getWhen() === null) at = step(at);
  return at;
}

/**
 * Private blocks run together, marked at the top of the run. In a list that is not private, its
 * private items run together the same way, bullets and all.
 */
function PrivateRuns() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const mark = (blocks: LexicalNode[], inRun: boolean) => {
      for (const block of blocks) {
        const whole = !inRun && $isPrivateBlock(block);
        const element = editor.getElementByKey(block.getKey());
        element?.toggleAttribute('data-private', whole);
        element?.toggleAttribute(
          'data-private-start',
          whole && !$isPrivateBlock($besideOf(block, (at) => at.getPreviousSibling())),
        );
        element?.toggleAttribute(
          'data-private-end',
          whole && !$isPrivateBlock($besideOf(block, (at) => at.getNextSibling())),
        );
        if ($isElementNode(block)) {
          const items = block
            .getChildren()
            .filter((child) => $isListNode(child) || $isListItemNode(child));
          mark(items, inRun || whole);
        }
      }
    };
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        mark($getRoot().getChildren(), false);
      });
    });
  }, [editor]);
  return null;
}

/** What the pointer rests on, if it is private: the whole block, or else the words. A shared cut-out is not. */
const privateUnder = (target: EventTarget | null): Element | null => {
  if (!(target instanceof Element)) return null;
  const words = target.closest('[data-lexical-text]');
  if (words && !words.matches('[style*="--private"]')) return null;
  return target.closest('[data-private]') ?? words;
};

type HintBox = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

/**
 * One tooltip for the editor's parts that can't hold their own.
 * why: Lexical owns the blocks' elements and the toolbar package its buttons, so it anchors to a
 * span of its own, moved over what it speaks of.
 */
function useEditorHint() {
  const anchor = useRef<HTMLSpanElement>(null);
  const waiting = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [shown, setShown] = useState<{ text: string; place: HintBox } | null>(null);
  const hide = useCallback(() => {
    clearTimeout(waiting.current);
    setShown(null);
  }, []);
  const show = useCallback(
    (text: string, { left, top, width, height }: HintBox) => {
      hide();
      const box = anchor.current?.offsetParent?.getBoundingClientRect();
      if (!box) return;
      waiting.current = setTimeout(() => {
        const place = { left: left - box.left, top: top - box.top, width, height };
        setShown({ text, place });
      }, HINT_DELAY_MS);
    },
    [hide],
  );
  useEffect(() => hide, [hide]);
  const hint = (
    <>
      <span ref={anchor} className="prompt-hint-anchor" style={shown?.place} />
      <Tooltip anchorRef={anchor} content={shown?.text} isOpen={shown !== null} />
    </>
  );
  return { hint, show, hide };
}

type EditorHint = ReturnType<typeof useEditorHint>;

/** What the toolbar's control under the pointer says, for the controls that say nothing. */
function toolbarHint(control: Element): string | undefined {
  if (control.matches('.astryx-selector')) return BLOCK_HINT;
  const label = control.getAttribute('aria-label');
  return label && FORMAT_LABELS.has(label) ? label : undefined;
}

/** The hover of the toolbar's own buttons, which the package leaves without a tooltip. */
function toolbarHovers({ show, hide }: EditorHint) {
  let over: Element | null = null;
  return {
    onMouseOver: (event: MouseEvent) => {
      const control =
        event.target instanceof Element ? event.target.closest('.astryx-selector, button') : null;
      if (control === over) return;
      over = control;
      hide();
      const text = control && toolbarHint(control);
      if (control && text) show(text, control.getBoundingClientRect());
    },
    onMouseLeave: () => {
      over = null;
      hide();
    },
  };
}

/** Says what private text is, at the pointer. */
function PrivateHint({ show, hide }: EditorHint) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let over: Element | null = null;
    const move = (event: globalThis.MouseEvent) => {
      const under = privateUnder(event.target);
      if (under === over) return;
      over = under;
      hide();
      if (!under) return;
      show(PRIVATE_HINT, { left: event.clientX, top: event.clientY, width: 1, height: 1 });
    };
    let stop = () => {};
    const unregister = editor.registerRootListener((root) => {
      stop();
      stop = () => {};
      if (!root) return;
      const page = root.ownerDocument;
      // why: the root's mouseleave fires while the pointer rests on its text.
      page.addEventListener('mousemove', move);
      root.addEventListener('mousedown', hide);
      root.addEventListener('keydown', hide);
      stop = () => {
        page.removeEventListener('mousemove', move);
        root.removeEventListener('mousedown', hide);
        root.removeEventListener('keydown', hide);
      };
    });
    return () => {
      unregister();
      stop();
    };
  }, [editor, show, hide]);
  return null;
}

/** The caret stays where it was through the dialog that holds a change. */
function HeldCaret() {
  const [editor] = useLexicalComposerContext();
  const isChangeHeld = useContext(ChangeHeld);
  const caret = useRef<BaseSelection | null>(null);
  useEffect(() => {
    if (isChangeHeld) {
      caret.current = editor.getEditorState().read(() => $getSelection()?.clone() ?? null);
      return;
    }
    const held = caret.current;
    caret.current = null;
    if (held) {
      editor.update(() => {
        $setSelection(held);
      });
    }
  }, [editor, isChangeHeld]);
  return null;
}

export type EditorStatus = ComponentProps<typeof RichTextEditor>['status'];

export type PromptEditorProps = {
  /** The prompt as markup text, the only form the draft holds. */
  value: string;
  placeholder?: string;
  status?: EditorStatus;
  onChange: (next: string) => void;
};

function OpenedEditor({
  opened,
  placeholder,
  status,
  onEdit,
}: {
  opened: string;
  placeholder?: string;
  status?: EditorStatus;
  onEdit: (next: string) => void;
}) {
  const [doc] = useState(() => openedDoc(opened));
  const hint = useEditorHint();
  const [hovers] = useState(() => toolbarHovers(hint));
  return (
    <div className="prompt-editor">
      {hint.hint}
      <RichTextEditor
        label="Prompt"
        isLabelHidden
        width="100%"
        size="sm"
        minHeight={MIN_HEIGHT}
        placeholder={placeholder}
        status={status}
        defaultValue={doc}
        nodes={NODES}
        toolbar={
          <RichTextEditorToolbar
            size="sm"
            hasLink={false}
            endContent={<PromptTools />}
            {...hovers}
          />
        }
        plugins={
          <>
            <PrivateRuns />
            <PrivateHint {...hint} />
            <HeldCaret />
          </>
        }
        onChange={(state) => {
          onEdit(promptMarkup(JSON.stringify(state.toJSON())));
        }}
      />
    </div>
  );
}

/**
 * The prompt with its private stretches and options in view. It is a view of the markup text:
 * it writes back only when the prompt changes, so opening it never dirties the draft, and text
 * changed from outside (another profile, a reload, a kept source) opens afresh.
 */
export function PromptEditor({ value, placeholder, status, onChange }: PromptEditorProps) {
  const [held, setHeld] = useState(value);
  const [opening, setOpening] = useState(0);
  // why: a held change is still on screen; Change keeps it and the caret, Cancel reopens the prompt.
  const isChangeHeld = useContext(ChangeHeld);
  if (!isChangeHeld && !samePrompt(value, held)) {
    setHeld(value);
    setOpening(opening + 1);
  }
  return (
    <OpenedEditor
      key={opening}
      opened={value}
      placeholder={placeholder}
      status={status}
      onEdit={(next) => {
        if (samePrompt(next, held)) return;
        setHeld(next);
        onChange(next);
      }}
    />
  );
}
