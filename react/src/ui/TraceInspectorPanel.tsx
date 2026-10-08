import { Icon } from '@astryxdesign/core/Icon';
import { IconTimeline } from '@tabler/icons-react';
import type { TraceRecord } from '@theoremjs/agents';
import type { ProfileObservabilityView } from '@theoremjs/agents/interface';
import {
  cloneElement,
  createContext,
  isValidElement,
  lazy,
  type ReactElement,
  type ReactNode,
  type Ref,
  Suspense,
  use,
  useCallback,
  useId,
  useRef,
  useState,
} from 'react';
import type { TraceFeed } from '../client/trace-feed.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import {
  InPlace,
  isSidePanelWide,
  RaisedPane,
  SidePanel,
  SidePanelHeader,
  type SidePanelLabels,
  SidePanelToggle,
  useSidePanel,
  useWidth,
} from './SidePanel.tsx';

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
  /** The trace, while it's open; null otherwise. */
  view: ReactNode;
  /** Words for the docked panel. */
  labels: SidePanelLabels;
  /** The profile records traces, so a panel page can dock them even when the host drives the toggle. */
  offered: boolean;
};

/** `replace` takes the surface's place. `panel` docks at the inline end; its width eases with the theme. */
const TracePlacementContext = createContext<'replace' | 'panel'>('replace');

/** Where an open trace sits on this page. */
export function TracePlacement({
  value,
  children,
}: {
  value: 'replace' | 'panel';
  children: ReactNode;
}) {
  return <TracePlacementContext value={value}>{children}</TracePlacementContext>;
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
 * The trace inspector, offered when the profile records traces. By default the
 * open trace takes the surface's place. Inside `TracePlacement value="panel"`
 * it docks at the inline end instead, and the theme eases that panel's width.
 * It reads the records the host delivers on `traces`; a host that delivers none
 * shows the empty state. Pass `open` to drive it from the host's own control,
 * which hides the built-in toggle. The open trace takes the surface's place,
 * unless this page is inside `TracePlacement value="panel"`, where it docks.
 */
export function useTraceInspector(
  iface: { observability?: Pick<ProfileObservabilityView, 'record'> },
  traces?: TraceFeed,
  open?: boolean,
): TraceInspector {
  const t = useLabels();
  const id = useId();
  const [own, setOwn] = useState(false);
  const placement = use(TracePlacementContext);
  const labels = {
    name: t('@theorem.panel.trace.name'),
    show: t('@theorem.panel.trace.show'),
    hide: t('@theorem.panel.trace.hide'),
    resize: t('@theorem.panel.trace.resize'),
  };
  if (iface.observability?.record !== true)
    return { toggle: null, view: null, labels, offered: false };
  const isOpen = open ?? own;
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
  const view = isOpen ? openTrace(placement === 'panel', id, traces, toggle) : null;
  return { toggle, view, labels, offered: true };
}

/** The open trace: filling the host's docked panel, or as its own panel with the toggle on top. */
function openTrace(
  docked: boolean,
  id: string,
  traces: TraceFeed | undefined,
  toggle: ReactNode,
): ReactNode {
  if (docked) return <TraceFill id={id} traces={traces} />;
  return (
    <TraceView
      id={id}
      header={toggle ? <SidePanelHeader>{toggle}</SidePanelHeader> : undefined}
      traces={traces}
    />
  );
}

/** The trace body, filling the docked panel. The panel supplies the raised card. */
function TraceFill({ id, traces }: { id: string; traces: TraceFeed | undefined }) {
  const { ref, width } = useWidth();
  return (
    <div id={id} ref={ref} style={{ height: '100%' }}>
      <Suspense fallback={null}>
        <TraceFeedBody traces={traces} isWide={isSidePanelWide(width)} />
      </Suspense>
    </div>
  );
}

type DockChild = { end?: ReactNode; ref?: Ref<HTMLDivElement> };

/** The surface, with the trace docked at its inline end. A host-driven trace stays in place. */
function TraceDock({ inspector, children }: { inspector: TraceInspector; children: ReactNode }) {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const side = useSidePanel(layoutRef, false);
  const childRef = useRef<Ref<HTMLDivElement> | undefined>(undefined);
  const setLayout = useCallback((node: HTMLDivElement | null) => {
    layoutRef.current = node;
    const ref = childRef.current;
    if (typeof ref === 'function') ref(node);
    else if (ref != null) ref.current = node;
  }, []);
  if (!isValidElement<DockChild>(children)) {
    return <InPlace view={inspector.view}>{children}</InPlace>;
  }
  childRef.current = children.props.ref;
  const open = inspector.view != null;
  return cloneElement(children as ReactElement<DockChild>, {
    ref: setLayout,
    end: (
      <SidePanel labels={inspector.labels} resizable={side.resizable} open={open}>
        {inspector.view}
      </SidePanel>
    ),
  });
}

/** The surface, or the trace in its place — or, on a docked page, beside it. */
export function WithTrace({
  inspector,
  children,
}: {
  inspector: TraceInspector;
  children: ReactNode;
}) {
  const placement = use(TracePlacementContext);
  if (placement === 'panel' && inspector.offered) {
    return <TraceDock inspector={inspector}>{children}</TraceDock>;
  }
  return <InPlace view={inspector.view}>{children}</InPlace>;
}

/**
 * What `records` say of guardrails, for a host that holds a trace of its own
 * (the studio's guardrail test): the checks' time and count, then each
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
