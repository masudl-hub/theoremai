import { Icon } from '@astryxdesign/core/Icon';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { IconCode, IconEye } from '@tabler/icons-react';
import type { ProfileSystem } from '@theoremjs/agents/kernel';
import { useDeferredValue, useMemo, useState } from 'react';
import type { OptionDraft } from '../draft.ts';
import { type PromptForms, promptDocProblem, promptReader } from '../prompt-doc.ts';
import { markupOf, sameWritten } from '../system-markup.ts';
import { TextAreaRow, useFieldRow, WideRow } from './inspector.tsx';
import { PromptEditor } from './prompt-editor.tsx';
import { PromptOptions } from './prompt-line-node.tsx';

const PATH = 'identity.system';

/** Text typed in the code view, and the prompt it was typed over. */
type Typed = { text: string; over: ProfileSystem };

/**
 * A profile's prompt: formatted, or as code, which is all a prompt the view can't hold can be.
 * Both show the prompt as written and read back only what changed, so each line nobody touched
 * stays as the file writes it.
 */
export function PromptRow({
  value,
  options,
  rows,
  placeholder,
  onChange,
}: {
  value: ProfileSystem;
  options: readonly OptionDraft[];
  rows: number;
  placeholder?: string;
  onChange: (next: ProfileSystem) => void;
}) {
  const row = { label: 'Prompt', path: PATH, field: 'system' };
  const { status, required } = useFieldRow(row);
  const [wantsCode, setWantsCode] = useState(false);
  const [written] = useState(value);
  // why: text that doesn't read yet is the author's until it does, and the prompt still runs as it was.
  const [typed, setTyped] = useState<Typed>();
  const shown = useMemo(() => markupOf(value), [value]);
  const text = typed?.over === value ? typed.text : shown;
  // why: the check converts the whole prompt, and a long one mustn't slow each keystroke.
  const settled = useDeferredValue(text);
  const problem = useMemo(() => promptDocProblem(settled), [settled]);
  const [forms] = useState<PromptForms>(() => new Map());
  const read = useMemo(() => promptReader([value, written], forms), [value, written, forms]);
  const type = (next: string) => {
    const result = read(next);
    if (!result.ok || sameWritten(result.system, value)) {
      setTyped({ text: next, over: value });
      return;
    }
    setTyped({ text: next, over: result.system });
    onChange(result.system);
  };
  const isCode = wantsCode || problem !== undefined;
  const toggle = (
    <ToggleButton
      label="Code"
      tooltip={problem ?? (isCode ? 'Show formatted' : 'Show code')}
      size="sm"
      isIconOnly
      isDisabled={problem !== undefined}
      icon={<Icon icon={IconEye} size="sm" />}
      pressedIcon={<Icon icon={IconCode} size="sm" />}
      isPressed={isCode}
      onPressedChange={setWantsCode}
    />
  );
  if (isCode) {
    const isRead = read(text).ok;
    return (
      <TextAreaRow
        {...row}
        rows={rows}
        value={text}
        placeholder={placeholder}
        status={
          problem
            ? {
                type: 'warning',
                message: isRead
                  ? problem
                  : `${problem} Until it reads, the agent runs with the prompt as it was.`,
              }
            : undefined
        }
        action={toggle}
        onChange={type}
      />
    );
  }
  return (
    <WideRow
      label={row.label}
      path={row.path}
      isRequired={required}
      hasIssue={status !== undefined}
      action={toggle}
    >
      <PromptOptions.Provider value={options}>
        <PromptEditor
          value={value}
          written={written}
          placeholder={placeholder}
          status={status}
          onChange={onChange}
        />
      </PromptOptions.Provider>
    </WideRow>
  );
}
