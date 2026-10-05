import { Card } from '@astryxdesign/core/Card';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { VStack } from '@astryxdesign/core/VStack';
import { IconTimeline } from '@tabler/icons-react';
import type { ProfileObservabilityView } from '@theoremjs/agents/interface';
import { lazy, type ReactNode, Suspense, useCallback, useId, useState } from 'react';
import type { TraceFeed } from '../client/trace-feed.ts';
import { useLabels } from './labels-provider.tsx';
import { isSidePanelWide, RAISED, SidePanelHeader, SidePanelToggle } from './SidePanel.tsx';

// why: The inspector and its charts are fetched when the trace first opens, not with the chat.
const TraceFeedBody = lazy(() =>
  import('./TraceInspector.tsx').then((module) => ({ default: module.TraceFeedBody })),
);

export type TraceInspector = {
  /** The header toggle; null when the host drives the trace or the profile records none. */
  toggle: ReactNode;
  /** The trace, full size, while it's open; null otherwise. */
  view: ReactNode;
};

/** The element's width, kept current. */
function useWidth() {
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function TraceView({
  id,
  header,
  traces,
}: {
  id: string;
  header: ReactNode;
  traces: TraceFeed | undefined;
}) {
  const { ref, width } = useWidth();
  return (
    <Layout
      height="fill"
      header={header}
      content={
        <LayoutContent padding={0} isScrollable={false}>
          <VStack height="100%" paddingInline={3}>
            <Card variant="transparent" height="100%" padding={0} style={RAISED}>
              <div id={id} ref={ref} style={{ height: '100%' }}>
                <Suspense fallback={null}>
                  <TraceFeedBody traces={traces} isWide={isSidePanelWide(width)} />
                </Suspense>
              </div>
            </Card>
          </VStack>
        </LayoutContent>
      }
    />
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

/** The surface, or the trace in its place; the surface stays mounted underneath, so nothing it holds is lost. */
export function WithTrace({
  inspector,
  children,
}: {
  inspector: TraceInspector;
  children: ReactNode;
}) {
  return (
    <>
      {inspector.view}
      <div style={{ display: inspector.view ? 'none' : 'contents' }}>{children}</div>
    </>
  );
}
