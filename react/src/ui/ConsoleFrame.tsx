import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { useResizable } from '@astryxdesign/core/Resizable';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import {
  Children,
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  use,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useLabels } from './labels-provider.tsx';
import { PanelBody, PanelScroll, RAISED, SidePanel, SidePanelHeader } from './SidePanel.tsx';
import { type TraceInspector, WithTrace } from './TraceInspectorPanel.tsx';

export type ConsoleFrameProps = {
  inspector: TraceInspector;
  maxWidth: string;
  /**
   * The page is already a raised panel. The console sits in that panel instead
   * of painting the ground it uses when the page behind it is flat.
   */
  flush?: boolean;
  /**
   * The request and the response sit side by side. The request is a start
   * panel at two fifths of that pair, so its handle is on the trailing edge
   * and the response fills the other three fifths. Below the shell's drawer
   * breakpoint they stack, request first. Two children: the request, then the
   * response. One child keeps the single column.
   */
  columns?: boolean;
  /** The request column's name, read by its scroll region and its resize handle. */
  requestLabel?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
};

/** Cards on a flush console. The flat page uses the surface; a raised page uses the card. */
const FLUSH_CARD = {
  '--theorem-console-card': 'var(--color-background-muted)',
} as CSSProperties;

/** The request and response cards. A flush page points this at the muted ground. */
const CONSOLE_CARD = {
  background: 'var(--theorem-console-card, var(--color-background-surface))',
  borderRadius: 'var(--radius-page)',
} as CSSProperties;

/** Below the app shell's drawer breakpoint, where the two columns stack. */
const NARROW = '(width < 768px)';

/** Side by side, the panel card is the frame, so the request and response bring no card of their own. */
const ConsoleChrome = createContext(true);

function useNarrow() {
  return useSyncExternalStore(
    (change) => {
      const query = window.matchMedia(NARROW);
      query.addEventListener('change', change);
      return () => {
        query.removeEventListener('change', change);
      };
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

/**
 * One column: the request, then the response under it, in the page's own card.
 * `wide` is a pair stacked on a narrow page, which takes the page's width.
 */
function ConsoleSingle({
  flush,
  wide,
  maxWidth,
  children,
}: {
  flush: boolean;
  wide: boolean;
  maxWidth: string;
  children: ReactNode;
}) {
  return (
    <VStack height="100%" paddingInline={3} style={flush ? FLUSH_CARD : undefined}>
      <Card
        variant="transparent"
        height="100%"
        padding={0}
        style={flush ? { overflowY: 'auto' } : { ...RAISED, overflowY: 'auto' }}
      >
        <Center axis="horizontal" width="100%">
          <VStack width="100%" maxWidth={wide ? undefined : maxWidth} gap={3} padding={4}>
            {children}
          </VStack>
        </Center>
      </Card>
    </VStack>
  );
}

/**
 * A console's page, for decisions and hosts alike: the trace's toggle in the
 * header, and one raised panel, flush with the host's, scrolling inside.
 */
export function ConsoleFrame({
  inspector,
  maxWidth,
  flush = false,
  columns = false,
  requestLabel,
  className,
  style,
  children,
}: ConsoleFrameProps) {
  const narrow = useNarrow();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  // why: Children.count counts a null slot; toArray drops it, which is the child that is actually drawn.
  const paired = columns && Children.toArray(children).length > 1;
  return (
    <WithTrace inspector={inspector}>
      <Layout
        ref={layoutRef}
        height="fill"
        className={className}
        style={style}
        header={
          inspector.toggle ? <SidePanelHeader>{inspector.toggle}</SidePanelHeader> : undefined
        }
        content={
          <LayoutContent padding={0} isScrollable={false}>
            {paired && !narrow ? (
              <ConsoleColumns
                requestLabel={requestLabel}
                basisWidth={layoutRef.current?.clientWidth ?? 0}
              >
                {children}
              </ConsoleColumns>
            ) : (
              <ConsoleSingle flush={flush} wide={paired} maxWidth={maxWidth}>
                {children}
              </ConsoleSingle>
            )}
          </LayoutContent>
        }
      />
    </WithTrace>
  );
}

/**
 * The request is the sized panel and the response fills what it leaves, so
 * one handle keeps the pair at two fifths / three fifths. The request sizes
 * against this inner layout, not the page, so a trace docked outside the pair
 * cannot take the request's share.
 */
function ConsoleColumns({
  requestLabel = 'Request',
  basisWidth,
  children,
}: {
  requestLabel?: string;
  /** The outer layout's width. The pair is not measurable on this first render. */
  basisWidth: number;
  children: ReactNode;
}) {
  const t = useLabels();
  const pairRef = useRef<HTMLDivElement | null>(null);
  // why: a percentage default resolves against a 1200px stand-in until the pair
  // is measured, and the panel's width transition then eases between the two,
  // reflowing the request. This layout is already on screen, so the first
  // width is two fifths of it. 70% leaves the response a readable share, and a
  // percentage maximum follows the pair when the trace opens.
  const requestPanel = useResizable({
    defaultSize: basisWidth > 0 ? Math.round(basisWidth * 0.4) : '40%',
    minSize: 280,
    maxSize: '70%',
    containerRef: pairRef,
  });
  const [request, response] = Children.toArray(children);
  const labels = {
    name: requestLabel,
    show: requestLabel,
    hide: requestLabel,
    resize: t('@theorem.panel.resize', { name: requestLabel }),
  };
  return (
    <ConsoleChrome value={false}>
      <Layout
        ref={pairRef}
        height="fill"
        start={
          <SidePanel
            side="start"
            className="theorem-console-request"
            labels={labels}
            resizable={requestPanel}
            open
          >
            <PanelScroll label={requestLabel}>{request}</PanelScroll>
          </SidePanel>
        }
        content={
          <LayoutContent padding={0} isScrollable={false}>
            <PanelBody inset="end" className="theorem-console-response">
              {response}
            </PanelBody>
          </LayoutContent>
        }
      />
    </ConsoleChrome>
  );
}

/** The response. Beside the request it scrolls in the panel; a centred state fills the card, as an empty trace does. */
export function ResponseColumn({
  label,
  fill = false,
  children,
}: {
  label: string;
  fill?: boolean;
  children: ReactNode;
}) {
  const framed = use(ConsoleChrome);
  if (!framed) {
    return fill ? (
      children
    ) : (
      <PanelScroll label={label} padding={4}>
        {children}
      </PanelScroll>
    );
  }
  return (
    <Card
      variant="muted"
      padding={fill ? 0 : 4}
      className="theorem-console-card"
      style={CONSOLE_CARD}
    >
      {fill ? (
        children
      ) : (
        <VStack height="100%" gap={3}>
          {children}
        </VStack>
      )}
    </Card>
  );
}

/** ⌘/Ctrl+Enter runs the console's request. */
function runShortcut(run: () => void): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      run();
    }
  };
}

export type ConsoleView = 'fields' | 'json';

export type RequestCardProps = {
  title: string;
  /** The view shown: fields only while the request parses. */
  view: ConsoleView;
  hasFields: boolean;
  onView: (next: ConsoleView) => void;
  /** Runs on ⌘/Ctrl+Enter anywhere in the card. */
  onRun: () => void;
  children: ReactNode;
};

/** The request's card: its heading with the Fields/JSON switch, then the request and its run bar. */
export function RequestCard({ title, view, hasFields, onView, onRun, children }: RequestCardProps) {
  const t = useLabels();
  const framed = use(ConsoleChrome);
  const body = (
    <VStack gap={3} padding={framed ? undefined : 4} onKeyDown={runShortcut(onRun)}>
      <HStack gap={2} hAlign="between" vAlign="center">
        <Text type="supporting" color="secondary" as="h3">
          {title}
        </Text>
        <SegmentedControl
          label={t('@theorem.decision.view')}
          size="sm"
          value={view}
          onChange={(next) => {
            onView(next === 'json' ? 'json' : 'fields');
          }}
        >
          <SegmentedControlItem
            value="fields"
            label={t('@theorem.decision.fields')}
            isDisabled={!hasFields}
          />
          <SegmentedControlItem value="json" label={t('@theorem.data.json')} />
        </SegmentedControl>
      </HStack>
      {children}
    </VStack>
  );
  if (!framed) return body;
  return (
    <Card variant="muted" padding={4} className="theorem-console-card" style={CONSOLE_CARD}>
      {body}
    </Card>
  );
}

/** The field reads as code: the body font is swapped for the code font inside it. */
const CODE_FONT = { '--font-family-body': 'var(--font-family-code)' } as CSSProperties;

/** The request as JSON text, marked while it doesn't parse. */
export function JsonRequest({
  label,
  text,
  isInvalid,
  onChange,
}: {
  label: string;
  text: string;
  isInvalid: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <TextArea
      label={label}
      isLabelHidden
      value={text}
      onChange={onChange}
      rows={8}
      hasSpellCheck={false}
      status={isInvalid ? { type: 'error' } : undefined}
      style={CODE_FONT}
    />
  );
}

export type RunBarProps = {
  /** The shortcut, or what the request still lacks. */
  note: string | null;
  isReady: boolean;
  isRunning: boolean;
  runLabel: string;
  runningLabel: string;
  stopLabel: string;
  onRun: () => void;
  onStop: () => void;
};

/** A note on the request, Stop while it runs, and Run. */
export function RunBar({
  note,
  isReady,
  isRunning,
  runLabel,
  runningLabel,
  stopLabel,
  onRun,
  onStop,
}: RunBarProps) {
  return (
    <HStack gap={3} hAlign="between" vAlign="center">
      <Text
        type="supporting"
        color="secondary"
        style={isReady ? undefined : { color: 'var(--color-error)' }}
        hasTabularNumbers
      >
        {note}
      </Text>
      <HStack gap={2} vAlign="center">
        {isRunning ? <Button label={stopLabel} variant="ghost" onClick={onStop} /> : null}
        <Button
          label={isRunning ? runningLabel : runLabel}
          variant="primary"
          isLoading={isRunning}
          isDisabled={!isReady}
          onClick={onRun}
        />
      </HStack>
    </HStack>
  );
}
