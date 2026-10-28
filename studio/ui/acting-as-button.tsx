import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconUser } from '@tabler/icons-react';
import { useActingAs } from './lib/acting-as.ts';
import { openSettings } from './lib/studio-settings.ts';

/** Who runs act as, in the chat's header: opens the People settings, where the pick is made. */
export function ActingAsButton({ isIconOnly }: { isIconOnly: boolean }) {
  const { offer, problem, actingAs } = useActingAs();
  if (!offer && !problem) return null;
  const place = actingAs && offer?.places.find((each) => each.id === actingAs.place);
  const who = actingAs && `${actingAs.person.label} · ${place?.label ?? actingAs.place}`;
  return (
    <Button
      label={who ? `As: ${who}` : 'No one'}
      isIconOnly={isIconOnly}
      variant="ghost"
      size="sm"
      icon={<Icon icon={IconUser} size="sm" />}
      // why: with only the icon showing, the tooltip is the one place that says who.
      tooltip={isIconOnly ? `Acting as ${who ?? 'no one'}` : 'Who this run acts as'}
      onClick={() => {
        openSettings('people');
      }}
    />
  );
}
