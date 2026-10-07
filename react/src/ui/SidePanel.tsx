import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from '@astryxdesign/core/Layout';
import {
  type ResizableRegion,
  ResizeHandle,
  type UseResizableSingleConfig,
  useResizable,
} from '@astryxdesign/core/Resizable';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip as HoverTip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import { type ReactNode, type RefObject, useCallback, useId, useState } from 'react';

/**
 * `useResizable` sizing for side panels: a third of the layout (pass the
 * Layout as `containerRef` so the percentages resolve), dragged between a
 * readable minimum and half.
 */
const SIDE_PANEL_SIZING = {
  defaultSize: '33%',
  minSize: 280,
  maxSize: '50%',
} as const satisfies UseResizableSingleConfig;

/** Whether a side panel is wide enough for two readable columns: twice its minimum. */
export function isSidePanelWide(size: number): boolean {
  return size >= SIDE_PANEL_SIZING.minSize * 2;
}

/** A side panel's open state and size. `containerRef` is the Layout its percentages resolve against. */
export function useSidePanel(
  containerRef: RefObject<HTMLDivElement | null>,
  initiallyOpen: boolean,
) {
  const id = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const resizable = useResizable({ ...SIDE_PANEL_SIZING, containerRef });
  return { id, open, toggle, resizable };
}

/** The Layout header row: side panel toggles, at the end. */
export function SidePanelHeader({ children }: { children?: ReactNode }) {
  return (
    <LayoutHeader hasDivider={false}>
      <HStack hAlign="end" gap={1}>
        {children}
      </HStack>
    </LayoutHeader>
  );
}

/** A side panel's words: its name, and its toggle and drag handle actions. */
export type SidePanelLabels = { name: string; show: string; hide: string; resize: string };

/** Shows or hides one side panel (`panelId` from useSidePanel). */
export function SidePanelToggle({
  labels,
  icon,
  panelId,
  open,
  onToggle,
}: {
  labels: SidePanelLabels;
  icon: ReactNode;
  panelId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const action = open ? labels.hide : labels.show;
  return (
    <IconButton
      label={action}
      tooltip={action}
      variant="ghost"
      aria-expanded={open}
      aria-controls={panelId}
      icon={icon}
      onClick={onToggle}
    />
  );
}

export type SidePanelProps = {
  id?: string;
  labels: SidePanelLabels;
  /** From `useResizable`: the panel's width and its handle's drag state. */
  resizable: ResizableRegion;
  /**
   * Closed panels stay mounted at zero width and inert, so the theme can ease
   * their width; their content renders only while open, so it never reflows
   * into the collapsing width.
   */
  open?: boolean;
  /** Card padding; 0 for content that brings its own (e.g. ChatLayout). */
  padding?: 0;
  /**
   * `end` docks on the trailing edge: the handle, then the panel. `start`
   * docks on the leading edge: the panel, then the handle.
   */
  side?: 'start' | 'end';
  className?: string;
  children?: ReactNode;
};

/** Page corners like the host's raised panels, no border or shadow; the card fill, so surface-filled cards read on it. */
export const RAISED = {
  background: 'var(--color-background-card)',
  borderRadius: 'var(--radius-page)',
  overflow: 'hidden',
};

/** A docked panel's inset: 12px off the outer edge, 16px off the bottom (the page inset). */
export const PANEL_EDGE = 3;
export const PANEL_BOTTOM = 4;

/** The raised card every docked panel and the content beside one share. */
export function PanelBody({
  padding,
  inset = 'end',
  className,
  children,
}: {
  padding?: 0;
  /**
   * `end` insets the trailing edge (a panel docked there, or the content
   * filling beside a start panel). `start` insets the leading edge. `beside`
   * insets both.
   */
  inset?: 'end' | 'start' | 'beside';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <VStack
      height="100%"
      className={className}
      paddingInlineStart={inset === 'end' ? undefined : PANEL_EDGE}
      paddingInlineEnd={inset === 'start' ? undefined : PANEL_EDGE}
      paddingBlockEnd={PANEL_BOTTOM}
    >
      <Card variant="transparent" height="100%" padding={padding} style={RAISED}>
        {children}
      </Card>
    </VStack>
  );
}

/** The scroll inside a panel card. The same area the trace uses, so a short body sizes to its rows. */
export function PanelScroll({
  label,
  padding,
  children,
}: {
  label: string;
  padding?: 4;
  children?: ReactNode;
}) {
  return (
    <ScrollableArea className="theorem-panel-scroll" label={label} height="100%" padding={padding}>
      {children}
    </ScrollableArea>
  );
}

/**
 * A Layout side panel as Astryx's IDE template builds one (a `ResizeHandle`
 * beside a `LayoutPanel` sized by `useResizable`), holding a raised section
 * inset from the layout's outer edge and bottom instead of a flat pane.
 * `end` puts the handle first and reverses it; `start` puts the panel first.
 * For more than one panel, nest Layouts, one panel each, as the template does.
 */
export function SidePanel({
  id,
  labels,
  resizable,
  open = true,
  padding,
  side = 'end',
  className,
  children,
}: SidePanelProps) {
  const handle = open ? (
    <ResizeHandle
      direction="horizontal"
      isReversed={side === 'end'}
      hasDivider={false}
      isAlwaysVisible={false}
      resizable={resizable.props}
      label={labels.resize}
    />
  ) : null;
  const panel = (
    <LayoutPanel
      id={id}
      className={className}
      label={labels.name}
      role="complementary"
      width={open ? resizable.size : 0}
      hasDivider={false}
      padding={0}
      isScrollable={false}
      inert={!open}
    >
      <PanelBody padding={padding} inset={side}>
        {open ? children : null}
      </PanelBody>
    </LayoutPanel>
  );
  return side === 'start' ? (
    <>
      {panel}
      {handle}
    </>
  ) : (
    <>
      {handle}
      {panel}
    </>
  );
}

/** The element's width, kept current. */
export function useWidth() {
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * A raised pane that fills its place, inset from the sides. Its content is
 * told whether the pane is wide enough for two readable columns.
 */
export function RaisedPane({
  id,
  header,
  children,
}: {
  id?: string;
  header?: ReactNode;
  children: (isWide: boolean) => ReactNode;
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
                {children(isSidePanelWide(width))}
              </div>
            </Card>
          </VStack>
        </LayoutContent>
      }
    />
  );
}

/** A raised pane's content. Narrow, the detail takes the overview's place; wide, it sits beside it. */
export function PaneLayout({
  isWide,
  label,
  detailLabel,
  lead,
  overview,
  detail,
}: {
  isWide: boolean;
  label: string;
  detailLabel: string;
  /** Rendered once, ahead of the content. */
  lead?: ReactNode;
  overview: ReactNode;
  detail: ReactNode;
}) {
  if (!isWide) {
    return (
      <PanelScroll label={label}>
        {lead}
        {detail ?? overview}
      </PanelScroll>
    );
  }
  return (
    <HStack height="100%" gap={0}>
      <StackItem size="fill">
        <PanelScroll label={label}>
          {lead}
          {overview}
        </PanelScroll>
      </StackItem>
      {detail ? (
        <div
          style={{
            width: '48%',
            flexShrink: 0,
            height: '100%',
            borderInlineStart: '1px solid var(--color-border)',
          }}
        >
          <PanelScroll label={detailLabel}>{detail}</PanelScroll>
        </div>
      ) : null}
    </HStack>
  );
}

/** One titled block of a pane's detail; `doc` says what the title means, on hover. */
export function PanePanel({
  title,
  doc,
  children,
}: {
  title: string;
  doc?: string;
  children: ReactNode;
}) {
  return (
    <Card padding={3} variant="muted" style={{ background: 'var(--color-background-surface)' }}>
      <VStack gap={2}>
        <HoverTip content={doc ?? title}>
          <Text type="supporting" color="secondary">
            {title}
          </Text>
        </HoverTip>
        {children}
      </VStack>
    </Card>
  );
}

/** Text as it was written: its line breaks kept, long words wrapped. */
export function Prose({ text }: { text: string }) {
  return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</span>;
}

/** The surface, or the view in its place; the surface stays mounted underneath, so nothing it holds is lost. */
export function InPlace({ view, children }: { view: ReactNode; children: ReactNode }) {
  return (
    <>
      {view}
      <div style={{ display: view ? 'none' : 'contents' }}>{children}</div>
    </>
  );
}
