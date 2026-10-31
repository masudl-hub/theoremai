import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { HStack } from '@astryxdesign/core/HStack';
import { useLocale } from '@astryxdesign/core/i18n';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { useResizable } from '@astryxdesign/core/Resizable';
import { percent, pixel } from '@astryxdesign/core/Resizable/utils';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { VStack } from '@astryxdesign/core/VStack';
import type { HttpOptions } from '@theoremjs/web/client';
import {
  Children,
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  use,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { TheoremLabels } from './labels.ts';
import { useLabels } from './labels-provider.tsx';
import {
  PANEL_EDGE,
  PanelBody,
  PanelScroll,
  paneEdge,
  SidePanel,
  SidePanelHeader,
} from './SidePanel.tsx';
import { textRows } from './StateFields.tsx';
import { type TraceInspector, WithTrace } from './TraceInspectorPanel.tsx';
import { CONSOLE_CARD } from './trace-patterns.tsx';

/** The props a one-call console page shares: its look, its wording, its trace, and its layout. */
export type ConsolePageProps = {
  /** Extra fetch options for the default HTTP transport (auth headers, custom fetch). */
  http?: HttpOptions;
  theme?: DefinedTheme;
  mode?: 'system' | 'light' | 'dark';
  /** Replacement lines by locale, for any `@theorem.*` or `@astryx.*` key. */
  labels?: TheoremLabels;
  /** Widest the column may grow, as a CSS length. Default `960px`. */
  maxWidth?: string;
  /**
   * Drive the trace from the host's own control. The built-in toggle hides.
   * The open trace takes the result's place, unless this page is inside
   * `TracePlacement value="panel"`, where it docks. Omit to keep the toggle.
   * Needs a profile that records traces.
   */
  trace?: boolean;
  /**
   * The page is already a raised panel. The console sits in it instead of
   * painting the ground it uses on a flat page.
   */
  flush?: boolean;
  /** The request on the left and the result on the right. */
  columns?: boolean;
  className?: string;
  style?: CSSProperties;
};

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

/** Below the app shell's drawer breakpoint, where the two columns stack. */
const NARROW = '(width < 768px)';

/** Side by side, the panel card is the frame, so the request and response bring no card of their own. */
const ConsoleChrome = createContext(true);

function useNarrow() {
  return useSyncExternalStore(
    (change) => {
      const query = globalThis.matchMedia(NARROW);
      query.addEventListener('change', change);
      return () => {
        query.removeEventListener('change', change);
      };
    },
    () => globalThis.matchMedia(NARROW).matches,
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
  const column = (
    <Center axis="horizontal" width="100%" minHeight="100%">
      <VStack width="100%" maxWidth={wide ? undefined : maxWidth} gap={3} padding={4}>
        {children}
      </VStack>
    </Center>
  );
  if (!flush)
    return (
      <PanelBody inset="all" padding={0} isScrollable>
        {column}
      </PanelBody>
    );
  // why: A flush page is already the raised panel, so it takes no block inset of its own.
  return (
    <VStack
      height="100%"
      paddingInlineStart={PANEL_EDGE}
      style={{ ...FLUSH_CARD, paddingInlineEnd: paneEdge(PANEL_EDGE) }}
    >
      <Card variant="transparent" height="100%" padding={0} style={{ overflowY: 'auto' }}>
        {column}
      </Card>
    </VStack>
  );
}

/**
 * A console's page, for decisions and hosts alike: the trace toggle floats over
 * the content (same as chat), and one raised panel scrolls inside.
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
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const header = inspector.toggle ? (
    <SidePanelHeader floating>{inspector.toggle}</SidePanelHeader>
  ) : undefined;
  return (
    <WithTrace inspector={inspector}>
      <Layout
        ref={layoutRef}
        height="fill"
        className={className}
        style={{ position: 'relative', ...style }}
        header={header}
        content={
          <LayoutContent padding={0} isScrollable={false}>
            <ConsoleBody
              layoutRef={layoutRef}
              flush={flush}
              columns={columns}
              maxWidth={maxWidth}
              requestLabel={requestLabel}
            >
              {children}
            </ConsoleBody>
          </LayoutContent>
        }
      />
    </WithTrace>
  );
}

/** The console's panels: a request and response side by side when there is room, else one column. */
function ConsoleBody({
  layoutRef,
  flush,
  columns,
  maxWidth,
  requestLabel,
  children,
}: Pick<ConsoleFrameProps, 'maxWidth' | 'requestLabel' | 'children'> & {
  layoutRef: RefObject<HTMLDivElement | null>;
  flush: boolean;
  columns: boolean;
}) {
  const narrow = useNarrow();
  // why: Children.count counts a null slot; toArray drops it, which is the child that is actually drawn.
  const drawn = Children.toArray(children).length;
  const paired = columns && drawn > 1;
  if (paired && !narrow) {
    return (
      <ConsoleColumns requestLabel={requestLabel} layoutRef={layoutRef}>
        {children}
      </ConsoleColumns>
    );
  }
  return (
    <ConsoleSingle flush={flush} wide={paired} maxWidth={maxWidth}>
      {children}
    </ConsoleSingle>
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
  layoutRef,
  children,
}: {
  requestLabel?: string;
  /** The outer layout, measured once when the pair first draws. The pair is not measurable yet. */
  layoutRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const t = useLabels();
  const pairRef = useRef<HTMLDivElement | null>(null);
  // why: a percentage default resolves against a 1200px stand-in until the pair
  // is measured, and the panel's width transition then eases between the two,
  // reflowing the request. This layout is already on screen, so the first
  // width is two fifths of it. 70% leaves the response a readable share, and a
  // percentage maximum follows the pair when the trace opens.
  // why: Read once. Reading layout on every render forces a reflow of each streamed event's commit.
  const [basisWidth] = useState(() => layoutRef.current?.clientWidth ?? 0);
  const requestPanel = useResizable({
    defaultSize: basisWidth > 0 ? Math.round(basisWidth * 0.4) : '40%',
    minSize: 280,
    // why: In a narrow pair 70% is below the minimum; the maximum never is.
    maxSize: percent(70, { min: pixel(280) }),
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
            <PanelBody inset="beside" className="theorem-console-response">
              {response}
            </PanelBody>
          </LayoutContent>
        }
      />
    </ConsoleChrome>
  );
}

/** One card of a response with several: its request and result sit in it without cards of their own. */
export function ConsoleSection({ children }: { children: ReactNode }) {
  return (
    <Card variant="muted" padding={0} className="theorem-console-card" style={CONSOLE_CARD}>
      <ConsoleChrome value={false}>{children}</ConsoleChrome>
    </Card>
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
  /** Runs on ⌘/Ctrl+Enter anywhere in the card. */
  onRun: () => void;
  children: ReactNode;
} & (
  | {
      /** The view shown: fields only while the request parses. */
      view: ConsoleView;
      hasFields: boolean;
      onView: (next: ConsoleView) => void;
      actions?: never;
    }
  | {
      view?: never;
      hasFields?: never;
      onView?: never;
      /** In the Fields/JSON switch's place, for a request that has no JSON of its own. */
      actions?: ReactNode;
    }
);

/** The request's card: its heading with the Fields/JSON switch, then the request and its run bar. */
export function RequestCard({ title, onRun, children, ...heading }: RequestCardProps) {
  const t = useLabels();
  const framed = use(ConsoleChrome);
  const body = (
    <VStack gap={3} padding={framed ? undefined : 4} onKeyDown={runShortcut(onRun)}>
      <HStack gap={2} hAlign="between" vAlign="center">
        <Text type="supporting" color="secondary" as="h3">
          {title}
        </Text>
        {heading.onView ? (
          <SegmentedControl
            label={t('@theorem.decision.view')}
            size="sm"
            value={heading.view}
            onChange={(next) => {
              heading.onView(next === 'json' ? 'json' : 'fields');
            }}
          >
            <SegmentedControlItem
              value="fields"
              label={t('@theorem.decision.fields')}
              isDisabled={!heading.hasFields}
            />
            <SegmentedControlItem value="json" label={t('@theorem.data.json')} />
          </SegmentedControl>
        ) : (
          heading.actions
        )}
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
      rows={textRows(text, 8, 24)}
      hasSpellCheck={false}
      status={isInvalid ? { type: 'error' } : undefined}
      controlStyle={CODE_FONT}
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

/** A size in bytes as the reader's locale writes it: bytes under a kilobyte, else kilobytes. */
export function useBytes(): (bytes: number) => string {
  const locale = useLocale();
  return useMemo(() => {
    const b = new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'narrow' });
    const kb = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'kilobyte',
      unitDisplay: 'narrow',
      maximumFractionDigits: 1,
    });
    return (bytes) => (bytes < 1024 ? b.format(bytes) : kb.format(bytes / 1024));
  }, [locale]);
}
