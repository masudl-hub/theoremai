import { Icon } from '@astryxdesign/core/Icon';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { IconCode, IconEye } from '@tabler/icons-react';
import { useDeferredValue, useMemo, useState } from 'react';
import type { ConditionDraft } from '../draft.ts';
import { promptDocProblem } from '../prompt-doc.ts';
import { TextAreaRow, useFieldRow, WideRow } from './inspector.tsx';
import { PromptEditor } from './prompt-editor.tsx';
import { PromptConditions } from './prompt-line-node.tsx';

const PATH = 'identity.system';

/** A profile's prompt: formatted, or as code, which is all a prompt the view can't hold can be. */
export function PromptRow({
  value,
  conditions,
  rows,
  placeholder,
  onChange,
}: {
  value: string;
  conditions: readonly ConditionDraft[];
  rows: number;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  const row = { label: 'Prompt', path: PATH, field: 'system' };
  const { status, required } = useFieldRow(row);
  const [wantsCode, setWantsCode] = useState(false);
  // why: the check converts the whole prompt, and a long one mustn't slow each keystroke.
  const settled = useDeferredValue(value);
  const problem = useMemo(() => promptDocProblem(settled), [settled]);
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
    return (
      <TextAreaRow
        {...row}
        rows={rows}
        value={value}
        placeholder={placeholder}
        status={problem ? { type: 'warning', message: problem } : undefined}
        action={toggle}
        onChange={onChange}
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
      <PromptConditions.Provider value={conditions}>
        <PromptEditor value={value} placeholder={placeholder} status={status} onChange={onChange} />
      </PromptConditions.Provider>
    </WideRow>
  );
}
