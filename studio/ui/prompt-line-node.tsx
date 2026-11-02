import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { IconCheck, IconFilter } from '@tabler/icons-react';
import {
  $getNodeByKey,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { createContext, type ReactNode, useContext, useState } from 'react';
import type { ConditionDraft } from '../draft.ts';
import { checksOf, PROMPT_LINE, withCheck, withoutCheck } from '../prompt-doc.ts';

/** The conditions this profile declares, which the tokens' menus and the toolbar's offer. */
export const PromptConditions = createContext<readonly ConditionDraft[]>([]);

export type SetWhen = (when: string | null) => void;

/** The menu of a line's `when`: one section per condition, with what it holds ticked. */
export function conditionItems(
  conditions: readonly ConditionDraft[],
  when: string | null,
  set: SetWhen,
): DropdownMenuOption[] {
  const have = checksOf(when);
  return [
    ...(have.length > 0
      ? [
          {
            label: 'Remove condition',
            onClick: () => {
              set(null);
            },
          },
        ]
      : []),
    ...conditions.map(({ name, values }) => ({
      type: 'section' as const,
      title: name,
      items: values.map((value) => ({
        label: `${name} is ${value}`,
        onClick: () => {
          set(withCheck(when, name, value));
        },
        endContent: have.includes(`${name} is ${value}`) ? (
          <Icon icon={IconCheck} size="sm" />
        ) : undefined,
      })),
    })),
  ];
}

/**
 * One check of a line's `when`.
 * why: the menu opens from its own state, since a press-open needs a real button and Token's root
 * is a span.
 */
function CheckToken({ check, when, set }: { check: string; when: string | null; set: SetWhen }) {
  const conditions = useContext(PromptConditions);
  const [isOpen, setIsOpen] = useState(false);
  return (
    <DropdownMenu
      label={check}
      isMenuOpen={isOpen}
      onOpenChange={setIsOpen}
      items={conditionItems(conditions, when, set)}
      renderTrigger={({ ref, id }) => (
        <Tooltip content={`Sent only on turns where ${when ?? check}. Press to change it.`}>
          <Token
            ref={ref}
            id={id}
            size="sm"
            label={check}
            icon={<Icon icon={IconFilter} size="xsm" />}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            onClick={() => {
              setIsOpen(!isOpen);
            }}
            onRemove={() => {
              set(withoutCheck(when, check));
            }}
          />
        </Tooltip>
      )}
    />
  );
}

function LineHead({ nodeKey, when }: { nodeKey: NodeKey; when: string | null }) {
  const [editor] = useLexicalComposerContext();
  const set: SetWhen = (next) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isPromptLine(node)) node.setWhen(next);
    });
  };
  const checks = checksOf(when);
  if (checks.length === 0) return null;
  return (
    <div className="prompt-line-head" contentEditable={false}>
      {checks.map((check) => (
        <CheckToken key={check} check={check} when={when} set={set} />
      ))}
    </div>
  );
}

export type SerializedPromptLine = Spread<{ when?: string | null }, SerializedLexicalNode>;

/** Where a prompt line opens: the blocks after it, up to the next one, are that line's body. */
export class PromptLineNode extends DecoratorNode<ReactNode> {
  __when: string | null;

  static override getType(): string {
    return PROMPT_LINE;
  }

  static override clone(node: PromptLineNode): PromptLineNode {
    return new PromptLineNode(node.__when, node.__key);
  }

  static override importJSON(json: SerializedPromptLine): PromptLineNode {
    return new PromptLineNode(json.when ?? null);
  }

  constructor(when: string | null, key?: NodeKey) {
    super(key);
    this.__when = when;
  }

  override exportJSON(): SerializedPromptLine {
    return { type: PROMPT_LINE, version: 1, when: this.__when };
  }

  getWhen(): string | null {
    return this.getLatest().__when;
  }

  setWhen(when: string | null): this {
    this.getWritable().__when = when;
    return this;
  }

  override createDOM(): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'prompt-line-slot';
    return slot;
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return false;
  }

  override isKeyboardSelectable(): boolean {
    return false;
  }

  override decorate(): ReactNode {
    return <LineHead nodeKey={this.getKey()} when={this.getWhen()} />;
  }
}

export const $isPromptLine = (node: LexicalNode | null | undefined): node is PromptLineNode =>
  node instanceof PromptLineNode;
