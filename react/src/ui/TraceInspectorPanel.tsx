import { Icon } from '@astryxdesign/core/Icon';
import { IconTimeline } from '@tabler/icons-react';
import type { TraceRecord } from '@theoremjs/agents';
import type { ProfileObservabilityView } from '@theoremjs/agents/interface';
import { lazy, type ReactNode, Suspense, useId, useState } from 'react';
import type { TraceFeed } from '../client/trace-feed.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { InPlace, RaisedPane, SidePanelHeader, SidePanelToggle } from './SidePanel.tsx';

// why: The inspector and its charts are fetched when the trace first opens, not with the chat.
const TraceGuardrailsBody = lazy(() =>
  import('./TraceInspector.tsx').then((module) => ({ default: module.TraceGuardrailsBody })),
);
const TraceFeedBody = lazy(() =>
  import('./TraceInspector.tsx').then((module) => ({ default: module.TraceFeedBody })),
);

export type TraceInspector = {
  /** The header toggle; null when the host drives the trace or the profile records none. */
  toggle: ReactNode;
  /** The trace, full size, while it's open; null otherwise. */
  view: ReactNode;
};

function TraceView({
  id,
  header,
  traces,
}: {
  id: string;
  header: ReactNode;
  traces: TraceFeed | undefined;
}) {
  return (
    <RaisedPane id={id} header={header}>
      {(isWide) => (
        <Suspense fallback={null}>
          <TraceFeedBody traces={traces} isWide={isWide} />
        </Suspense>
      )}
    </RaisedPane>
  );
}

/**
 * The trace inspector, offered when the profile records traces. Open, the
 * trace takes the surface's place; the two never share the screen. It reads
 * the records the host delivers on `traces`; a host that delivers none shows
 * the empty state. Pass `open` to drive it from the host's own control, which
 * hides the built-in toggle.
 */
export function useTraceInspector(
  iface: { observability?: Pick<ProfileObservabilityView, 'record'> },
  traces?: TraceFeed,
  open?: boolean,
): TraceInspector {
  const t = useLabels();
  const id = useId();
  const [own, setOwn] = useState(false);
  if (iface.observability?.record !== true) return { toggle: null, view: null };
  const isOpen = open ?? own;
  const labels = {
    name: t('@theorem.panel.trace.name'),
    show: t('@theorem.panel.trace.show'),
    hide: t('@theorem.panel.trace.hide'),
    resize: t('@theorem.panel.trace.resize'),
  };
  const toggle =
    open === undefined ? (
      <SidePanelToggle
        labels={labels}
        icon={<Icon icon={IconTimeline} />}
        panelId={id}
        open={isOpen}
        onToggle={() => setOwn((value) => !value)}
      />
    ) : null;
  return {
    toggle,
    view: isOpen ? (
      <TraceView
        id={id}
        header={toggle ? <SidePanelHeader>{toggle}</SidePanelHeader> : undefined}
        traces={traces}
      />
    ) : null,
  };
}

/** The surface, or the trace in its place. */
export function WithTrace({
  inspector,
  children,
}: {
  inspector: TraceInspector;
  children: ReactNode;
}) {
  return <InPlace view={inspector.view}>{children}</InPlace>;
}

/**
 * What `records` say of guardrails, for a host that holds a trace of its own
 * (the playground's guardrail test): the checks' time and count, then each
 * check, laid out as the trace lays them out. `head` leads it.
 */
export function TraceGuardrailsView({
  records,
  head,
}: {
  records: readonly TraceRecord[];
  head?: ReactNode;
}) {
  return (
    <TheoremLabelsProvider>
      <Suspense fallback={null}>
        <TraceGuardrailsBody records={records} head={head} />
      </Suspense>
    </TheoremLabelsProvider>
  );
}
