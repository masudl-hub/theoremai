import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { Spinner } from '@astryxdesign/core/Spinner';
import { VStack } from '@astryxdesign/core/VStack';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/**
 * What a pane says when it has nothing of its own to show: centred both ways
 * in the room it is given. Loading, a failure and an empty pane are this one
 * component, so they sit in the same place.
 */
export function PaneState({
  icon,
  title,
  description,
  actions,
  children,
}: {
  /** Every pane state has one: it is what the eye finds first. */
  icon: ReactNode;
  title: string;
  description?: string;
  /** The buttons that lead out of the state. */
  actions?: ReactNode;
  /** What goes under the words: the detail of a failure, or the way out of it. */
  children?: ReactNode;
}) {
  return (
    <VStack height="100%" vAlign="center" hAlign="center" gap={3} padding={4}>
      <EmptyState icon={icon} title={title} description={description} actions={actions} />
      {children}
    </VStack>
  );
}

/** A pane that is waiting: the spinner where an empty pane's icon would be. */
export function PaneLoading({ label }: { label: string }) {
  return <PaneState icon={<Spinner size="lg" />} title={label} />;
}

/** A pane that could not show what it is for, and why. */
export function PaneFailure({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  /** The buttons that lead out of the failure. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <PaneState
      icon={<Icon icon={IconAlertTriangle} size="lg" color="secondary" />}
      title={title}
      description={description}
      actions={actions}
    >
      {children}
    </PaneState>
  );
}
