import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { Spinner } from '@astryxdesign/core/Spinner';
import { VStack } from '@astryxdesign/core/VStack';
import { IconAlertTriangle } from '@tabler/icons-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useSecondTicker } from '../hooks/use-second-ticker.ts';
import { liveDuration } from './labels.ts';
import { useLabels } from './labels-provider.tsx';

/**
 * What a pane says when it has nothing of its own to show: centred both ways
 * in the room it is given. Loading, a failure, and an empty pane are this one
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
      <EmptyState icon={icon} title={title} description={description} actions={actions} isCompact />
      {children}
    </VStack>
  );
}

/**
 * A pane that is waiting: the spinner where an empty pane's icon would be,
 * once the wait has gone on a moment; blank and busy before then. Given when
 * the work began, it counts the seconds under the label.
 */
export function PaneLoading({ label, since }: { label: string; since?: number | null }) {
  const t = useLabels();
  const now = useSecondTicker(since != null);
  const long = useLongWait();
  if (!long) return <div aria-busy="true" style={{ height: '100%' }} />;
  return (
    <PaneState
      icon={<Spinner size="lg" />}
      title={label}
      description={since == null ? undefined : liveDuration(t, now - since)}
    />
  );
}

/**
 * How long a wait stays blank before its spinner shows. Most waits (a profile
 * describing itself, a switch to another agent) end sooner, and the pane
 * changes straight to what it waited for instead of flashing a spinner.
 */
const QUIET_WAIT_MS = 300;

/** Whether a wait has gone on long enough to say so. */
function useLongWait(): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setLong(true), QUIET_WAIT_MS);
    return () => globalThis.clearTimeout(timer);
  }, []);
  return long;
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
