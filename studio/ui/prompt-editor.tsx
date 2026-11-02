import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
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
} from 'lexical';
import {
  type ComponentProps,
  type MouseEvent,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { openedDoc, PRIVATE_NAME, PRIVATE_ON, promptMarkup, samePrompt } from '../prompt-doc.ts';
import { ChangeHeld } from './inspector-context.ts';
import {
  $isPromptLine,
  conditionItems,
  PromptConditions,
  PromptLineNode,
} from './prompt-line-node.tsx';
import './prompt-editor.css';

const NODES = [PromptLineNode];
const MIN_HEIGHT = '16rem';

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

/** The condition of the line a block belongs to. */
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

/** Joins `start` to `end` into one line, and what follows keeps the condition it had. */
function $closeLine(start: LexicalNode, end: LexicalNode, tail: string | null) {
  for (let at: LexicalNode | null = start; at && !at.is(end); ) {
    const after: LexicalNode | null = at.getNextSibling();
    if ($isPromptLine(at)) at.remove();
    at = after;
  }
  const after = end.getNextSibling();
  if (after && !$isPromptLine(after)) end.insertAfter(new PromptLineNode(tail));
}

/** Starts the line at `start` under `next`, and neighbours under one condition join back up. */
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

/** Sets the condition on what is selected, or on the block the caret is in. */
function $setCondition(next: string | null) {
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

/** The Private and Condition buttons, on the toolbar's end. */
function PromptTools() {
  const [editor] = useLexicalComposerContext();
  const conditions = useContext(PromptConditions);
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
      {conditions.length > 0 && (
        <DropdownMenu
          label="Condition"
          renderTrigger={(props) => (
            <ToggleButton
              {...props}
              label="Condition"
              size="sm"
              isIconOnly
              icon={<Icon icon={IconFilter} size="sm" />}
              isPressed={Boolean(when)}
              onMouseDown={keepSelection}
            />
          )}
          items={conditionItems(conditions, when, (next) => {
            editor.update(() => {
              $setCondition(next);
            });
          })}
        />
      )}
    </>
  );
}

/** Whether every word of a block is private. A block with some private words marks only those. */
function $isWhollyPrivate(block: LexicalNode | null): boolean {
  if (!block || $isPromptLine(block) || !$isElementNode(block)) return false;
  const words = block.getAllTextNodes().filter((text) => text.getTextContent().trim() !== '');
  return words.length > 0 && words.every((text) => text.getStyle().includes(PRIVATE_NAME));
}

/** Blocks that are wholly private run together, marked at the top of the run. */
function PrivateRuns() {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          for (const block of $getRoot().getChildren()) {
            const whole = $isWhollyPrivate(block);
            const element = editor.getElementByKey(block.getKey());
            element?.toggleAttribute('data-private', whole);
            element?.toggleAttribute(
              'data-private-start',
              whole && !$isWhollyPrivate(block.getPreviousSibling()),
            );
            element?.toggleAttribute(
              'data-private-end',
              whole && !$isWhollyPrivate(block.getNextSibling()),
            );
          }
        });
      }),
    [editor],
  );
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
  return (
    <div className="prompt-editor">
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
        toolbar={<RichTextEditorToolbar size="sm" hasLink={false} endContent={<PromptTools />} />}
        plugins={
          <>
            <PrivateRuns />
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
 * The prompt with its private stretches and conditions in view. It is a view of the markup text:
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
