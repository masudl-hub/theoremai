import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconActivity } from '@tabler/icons-react';

/** View trace / Hide trace: the same control in the preview's header and a run tab's. */
export function TraceButton({
  open,
  onToggle,
  isIconOnly,
}: {
  open: boolean;
  onToggle: () => void;
  isIconOnly: boolean;
}) {
  return (
    <Button
      label={open ? 'Hide trace' : 'View trace'}
      isIconOnly={isIconOnly}
      variant={open ? 'secondary' : 'ghost'}
      tooltip={
        open
          ? 'Hide the trace'
          : 'See how each reply was made, step by step: every model and tool call, guardrail check and gate, with its timing'
      }
      icon={<Icon icon={IconActivity} size="sm" />}
      aria-pressed={open}
      onClick={onToggle}
    />
  );
}
