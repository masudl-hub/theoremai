import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { IconPlus } from '@tabler/icons-react';
import { kernelDefinitions, newProvider, type StudioProvider } from '../mod.ts';

/**
 * Adds a provider to the project from the first of `definitions`, under the first free id, and
 * hands it to `onAdd`, which opens its page: its id, definition, connection, and key slots are set
 * there. `taken` are the ids the workspace already holds. Compact, it is an icon beside a picker,
 * whose `definitions` are those that serve what picks.
 */
export function AddProviderButton({
  taken,
  onAdd,
  definitions = kernelDefinitions(),
  isCompact = false,
}: {
  taken: readonly string[];
  onAdd: (provider: StudioProvider) => void;
  definitions?: readonly string[];
  isCompact?: boolean;
}) {
  const add = () => {
    const [definition] = definitions;
    if (definition) onAdd(newProvider(taken, definition));
  };
  return isCompact ? (
    <IconButton
      label="New provider"
      variant="ghost"
      size="sm"
      icon={<Icon icon={IconPlus} size="sm" />}
      tooltip="New provider"
      onClick={add}
    />
  ) : (
    <Button
      label="Add provider"
      variant="ghost"
      size="sm"
      width="100%"
      icon={<Icon icon={IconPlus} size="sm" />}
      style={{ height: 'calc(var(--size-element-sm) - 4px)' }}
      onClick={add}
    />
  );
}
