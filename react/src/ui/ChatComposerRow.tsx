import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import type { ChatComposerStatus } from '@astryxdesign/core/Chat';
import { useCollapsible } from '@astryxdesign/core/Collapsible';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { IconChevronDown, IconChevronUp, IconPlayerStopFilled } from '@tabler/icons-react';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useState,
} from 'react';
import type { BackgroundJob } from '../client/transcript-groups.ts';
import { useSecondTicker } from '../hooks/use-second-ticker.ts';
import { liveDuration } from './labels.ts';
import { useLabels } from './labels-provider.tsx';

/**
 * The glyphs the row composer draws. Each one left out keeps Theorem's.
 * Text is in the labels (`@theorem.composer.pill.*`, `@theorem.composer.tray.*`); sizes, colours,
 * radii and spacing are the `--theorem-composer-*` CSS properties.
 */
export type ComposerRowIcons = {
  /** Before the working pill's text. Default: Astryx's Spinner. */
  working?: ReactNode;
  /** Before each background job's name. Default: Astryx's Spinner. */
  backgroundJob?: ReactNode;
  /** In the working pill's stop button. Default: a filled square. */
  stop?: ReactNode;
};

/** What waits to send: the count and label for the tray's header, and the content it folds. */
export type ComposerTray = { count: number; label: string; content: ReactNode };

/** What the row composer draws; the bar works each piece out, so both layouts share it. */
export type ComposerRowParts = {
  /** The pill row: the working pill while a reply runs, then the background jobs. */
  isWorking: boolean;
  /** When the reply in progress started; the working pill counts from it. */
  workingSince?: number;
  icons?: ComposerRowIcons;
  backgroundJobs: readonly BackgroundJob[];
  onStop: () => void;
  /** Contextual hint, at the end of the pill row. */
  hint?: ReactNode;
  /** What waits to send, in the tray above the surface. */
  tray?: ComposerTray;
  attach?: ReactNode;
  /** The text field; `false` when the profile takes no text. */
  input: ReactNode;
  /** The field's root, measured to know when the text wraps. */
  editorRef: RefObject<HTMLDivElement | null>;
  /** The draft; when it empties the row comes back from the stacked layout. */
  draftText: string;
  controls?: ReactNode;
  record?: ReactNode;
  /** The send button, or the send menu while a reply runs. */
  action: ReactNode;
  status?: ChatComposerStatus;
};

/**
 * A `--theorem-composer-*` property, or Theorem's value when the page sets none.
 * why: Inline styles beat Astryx's own, so every look the row has goes through one of these and
 * a builder sets it in CSS, on any element above the composer, or in their Astryx theme's
 * `localTokens`.
 */
const knob = (name: string, fallback: string) => `var(--theorem-composer-${name}, ${fallback})`;

const RADIUS = knob('radius', 'var(--radius-chat)');
const FILL = knob('fill', 'var(--color-background-popover)');
const SHADOW = knob('shadow', 'var(--shadow-low)');
const PADDING = knob('padding', 'var(--spacing-3)');
const GAP = knob('gap', 'var(--spacing-2)');
const INSET = knob('inset', '0px');
const TRAY_RADIUS = knob('tray-radius', `calc(${RADIUS} - var(--spacing-2))`);
const TRAY_PADDING = knob('tray-padding', 'var(--spacing-3)');
const PILL_HEIGHT = knob('pill-height', 'var(--size-element-lg)');
const PILL_RADIUS = knob('pill-radius', 'var(--radius-full)');
const PILL_FILL = knob('pill-fill', FILL);
const PILL_SHADOW = knob('pill-shadow', SHADOW);
const PILL_ALIGN = knob('pill-align', 'center');

/** The pill shape, kept whole when the row scrolls. */
const PILL: CSSProperties = {
  height: PILL_HEIGHT,
  flexShrink: 0,
  border: 'none',
  borderRadius: PILL_RADIUS,
  background: PILL_FILL,
  boxShadow: PILL_SHADOW,
  '--_button-radius': PILL_RADIUS,
} as CSSProperties;
/** why: The stop button sits in the pill's end with the same ring of space all round it. */
const WORKING_PILL: CSSProperties = {
  ...PILL,
  paddingInlineEnd: `calc((${PILL_HEIGHT} - var(--size-element-sm)) / 2)`,
};
/** invariant: The pill row keeps one pill's height whatever it holds, so the composer never moves. */
const PILL_ROW: CSSProperties = { paddingInline: INSET, minHeight: PILL_HEIGHT };
/** why: One pill sits where `pill-align` puts it; more start at the edge and scroll sideways. */
const PILLS_ONE: CSSProperties = { display: 'flex', justifyContent: PILL_ALIGN };
const PILLS_MANY: CSSProperties = {
  overflowX: 'auto',
  scrollbarWidth: 'none',
  // why: Pills that scroll fade out at the end instead of being cut against the hint.
  maskImage: 'linear-gradient(to right, black calc(100% - var(--spacing-6)), transparent)',
};
/** The tray: a card of its own over the surface, a gap between them. */
const TRAY: CSSProperties = {
  marginInline: INSET,
  border: 'none',
  borderRadius: TRAY_RADIUS,
  background: FILL,
  boxShadow: SHADOW,
  padding: TRAY_PADDING,
};
const TRAY_HEADER: CSSProperties = { cursor: 'pointer' };
/** why: Folding animates the row's height to zero, so the tray closes in place. */
const trayBody = (open: boolean): CSSProperties => ({
  display: 'grid',
  gridTemplateRows: open ? '1fr' : '0fr',
  transition: 'grid-template-rows var(--duration-medium) var(--ease-standard)',
});
const TRAY_BODY_INNER: CSSProperties = { overflow: 'hidden', minHeight: 0 };
const TRAY_CONTENT: CSSProperties = { paddingBlockStart: 'var(--spacing-3)' };

/**
 * The working pill: what runs and for how long, and its stop button.
 * why: It counts from the chat's turn clock, the one the transcript's status line reads, so the
 * two agree and a wait on approval does not count.
 */
function WorkingPill({
  since,
  icons,
  onStop,
}: {
  since?: number;
  icons?: ComposerRowIcons;
  onStop: () => void;
}) {
  const t = useLabels();
  const now = useSecondTicker(since !== undefined);
  const stop = t('@theorem.composer.pill.stop');
  const label =
    since === undefined
      ? t('@theorem.composer.pill.working')
      : t('@theorem.composer.pill.working_for', { duration: liveDuration(t, now - since) });
  return (
    <Token
      size="lg"
      className="theorem-composer-pill"
      data-pill="working"
      style={WORKING_PILL}
      label={label}
      icon={icons?.working ?? <Spinner size="sm" shade="inherit" aria-label={label} />}
      endContent={
        <IconButton
          label={stop}
          tooltip={stop}
          size="sm"
          variant="secondary"
          icon={icons?.stop ?? <IconPlayerStopFilled size={12} />}
          onClick={onStop}
        />
      }
    />
  );
}

/**
 * The pill row. One pill sits centred over the composer (see `pill-align`); with more, the working
 * pill leads and the rest follow it, scrolling sideways once they outgrow the row.
 */
function PillRow(
  props: Pick<
    ComposerRowParts,
    'isWorking' | 'workingSince' | 'icons' | 'backgroundJobs' | 'onStop' | 'hint'
  >,
) {
  const t = useLabels();
  const pills = [
    props.isWorking ? (
      <WorkingPill
        key="working"
        since={props.workingSince}
        icons={props.icons}
        onStop={props.onStop}
      />
    ) : null,
    ...props.backgroundJobs.map((job) => (
      <Token
        key={job.callId}
        size="lg"
        className="theorem-composer-pill"
        data-pill="background"
        style={PILL}
        label={job.label}
        description={t('@theorem.composer.pill.background')}
        icon={
          props.icons?.backgroundJob ?? (
            <Spinner
              size="sm"
              shade="inherit"
              aria-label={t('@theorem.composer.pill.background')}
            />
          )
        }
      />
    )),
  ].filter(Boolean);
  if (pills.length === 0 && !props.hint) return null;
  return (
    <HStack gap={2} vAlign="center" className="theorem-composer-pills" style={PILL_ROW}>
      <StackItem size="fill" style={pills.length > 1 ? PILLS_MANY : PILLS_ONE}>
        <HStack gap={1} vAlign="center">
          {pills}
        </HStack>
      </StackItem>
      {props.hint}
    </HStack>
  );
}

/**
 * What waits to send, on a card of its own above the surface: a header with the count, then the
 * content, which folds away under the header.
 */
function RowTray({ tray }: { tray: ComposerTray }) {
  const t = useLabels();
  const { isOpen, toggle } = useCollapsible({ isCollapsible: true });
  const contentId = useId();
  const Chevron = isOpen ? IconChevronDown : IconChevronUp;
  return (
    <Card elevation="none" className="theorem-composer-tray" data-open={isOpen} style={TRAY}>
      <HStack
        gap={2}
        vAlign="center"
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-controls={contentId}
        aria-label={t(
          isOpen ? '@theorem.composer.tray.collapse' : '@theorem.composer.tray.expand',
          {
            label: tray.label,
          },
        )}
        style={TRAY_HEADER}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggle();
        }}
      >
        <Badge variant="neutral" label={tray.count} />
        <StackItem size="fill">
          <Text size="sm" color="secondary">
            {tray.label}
          </Text>
        </StackItem>
        <Chevron size={16} aria-hidden />
      </HStack>
      <div id={contentId} style={trayBody(isOpen)} inert={!isOpen}>
        <div style={TRAY_BODY_INNER}>
          <div style={TRAY_CONTENT}>{tray.content}</div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Whether the field's text has wrapped past one line. Once it has, the row stays stacked until
 * the draft empties.
 * why: In the stacked layout the field is wider, so the same text may fit one line again; going
 * back then would flip the layout on every keystroke.
 */
function useWrapped(editorRef: RefObject<HTMLDivElement | null>, draftText: string): boolean {
  const [wrapped, setWrapped] = useState(false);
  const empty = draftText.trim() === '' && !draftText.includes('\n');
  if (empty && wrapped) setWrapped(false);
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root || wrapped) return;
    const field = root.querySelector<HTMLElement>('[contenteditable]') ?? root;
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(field).lineHeight);
      if (Number.isFinite(line) && field.scrollHeight > line * 1.5) setWrapped(true);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    return () => observer.disconnect();
  }, [editorRef, wrapped]);
  return wrapped && !empty;
}

/** The field's slot: it shares the row, or takes a line of its own once the text wraps. */
function RowField({ input, stacked }: { input: ReactNode; stacked: boolean }) {
  if (!input) return null;
  return (
    <StackItem
      size="fill"
      crossAlignSelf="center"
      style={stacked ? { flexBasis: '100%' } : { width: 0 }}
    >
      {input}
    </StackItem>
  );
}

/** The surface: Astryx's composer body, its look from the knobs above. */
const ROW_SURFACE: CSSProperties = {
  border: 'none',
  borderRadius: RADIUS,
  background: FILL,
  boxShadow: SHADOW,
  padding: PADDING,
  // why: As in ChatComposer: buttons follow the shell's curve, so send and the send menu are round.
  '--_button-radius': `max(var(--radius-element), calc(${RADIUS} - ${PADDING}))`,
} as CSSProperties;

/** The surface: attach, the field, then the controls, the mic, and send. */
function RowSurface(
  props: Pick<ComposerRowParts, 'attach' | 'input' | 'controls' | 'record' | 'action'> & {
    stacked: boolean;
  },
) {
  const attach = props.attach ? <StackItem>{props.attach}</StackItem> : null;
  return (
    <Card elevation="none" className="theorem-composer-surface" style={ROW_SURFACE}>
      {/* invariant: One flex row that wraps; stacking only changes the field's width, so the layout reshapes in place. */}
      <HStack gap={1} wrap="wrap" vAlign="end">
        {props.stacked ? null : attach}
        <RowField input={props.input} stacked={props.stacked} />
        {props.stacked ? attach : null}
        <StackItem size={props.stacked ? 'fill' : 'static'}>
          <HStack gap={1} vAlign="center" hAlign="end">
            {props.controls}
            {props.record}
            {props.action}
          </HStack>
        </StackItem>
      </HStack>
    </Card>
  );
}

function RowStatus({ status }: { status?: ChatComposerStatus }) {
  if (!status) return null;
  return (
    <Banner
      status={status.type}
      role={status.type === 'error' ? 'alert' : 'status'}
      title={status.message}
    />
  );
}

/**
 * Theorem's one-row composer: the field, then the controls, the mic, and send, on one line.
 * Text that wraps moves the field onto its own line above them, the stacked layout. Above
 * it, the pill row: the reply in progress (stop is on its pill) and the background jobs.
 */
export function ChatComposerRow(props: ComposerRowParts) {
  const stacked = useWrapped(props.editorRef, props.draftText);
  return (
    <VStack gap={0} width="100%" className="theorem-composer-row" style={{ gap: GAP }}>
      <PillRow
        isWorking={props.isWorking}
        workingSince={props.workingSince}
        icons={props.icons}
        backgroundJobs={props.backgroundJobs}
        onStop={props.onStop}
        hint={props.hint}
      />
      {props.tray ? <RowTray tray={props.tray} /> : null}
      <RowSurface
        stacked={stacked}
        attach={props.attach}
        input={props.input}
        controls={props.controls}
        record={props.record}
        action={props.action}
      />
      <RowStatus status={props.status} />
    </VStack>
  );
}
