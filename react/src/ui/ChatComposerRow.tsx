import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import type { ChatComposerStatus } from '@astryxdesign/core/Chat';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { IconClockPlay, IconPlayerStopFilled } from '@tabler/icons-react';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useState,
} from 'react';
import type { BackgroundJob } from '../client/transcript-groups.ts';
import { useSecondTicker } from '../hooks/use-second-ticker.ts';
import { type LabelText, workDuration } from './labels.ts';
import { useLabels } from './labels-provider.tsx';

/** What the row composer draws; the bar works each piece out, so both layouts share it. */
export type ComposerRowParts = {
  /** The pill row: the working pill while a reply runs, then the background jobs. */
  isWorking: boolean;
  backgroundJobs: readonly BackgroundJob[];
  onStop: () => void;
  /** Contextual hint, at the end of the pill row. */
  hint?: ReactNode;
  drawer?: ReactNode;
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
 * The pill shape: round, a large element tall, kept whole when the row scrolls.
 * why: It holds the stop button with the same ring of space the surface leaves round send.
 */
const PILL: CSSProperties = {
  height: 'var(--size-element-lg)',
  flexShrink: 0,
  borderRadius: 'var(--radius-full)',
  '--_button-radius': 'var(--radius-full)',
} as CSSProperties;
/** invariant: The stop button is a small element, so the end padding centres it in the pill's curve. */
const WORKING_PILL: CSSProperties = {
  ...PILL,
  paddingInlineEnd: 'calc((var(--size-element-lg) - var(--size-element-sm)) / 2)',
};
/**
 * why: The pill row is inset like the drawer, past the surface's curved ends, and keeps one
 * pill's height whatever it holds, so a hint coming or going does not move the composer.
 */
const PILL_ROW: CSSProperties = {
  paddingInline: 'var(--radius-chat)',
  minHeight: 'var(--size-element-lg)',
};
/** why: More pills than fit scroll sideways rather than wrap, so the row keeps its height. */
const PILL_SCROLL: CSSProperties = { overflowX: 'auto', scrollbarWidth: 'none' };
/** why: The drawer is inset past the surface's curved ends, so it comes up from behind it. */
const DRAWER_INSET: CSSProperties = { marginInline: 'var(--radius-chat)' };

/** Whole seconds, so the timer ticks evenly instead of jumping between tenths and seconds. */
function elapsedLabel(t: LabelText, ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return seconds === 0
    ? t('@theorem.duration.seconds', { seconds: 0 })
    : workDuration(t, seconds * 1_000);
}

/**
 * The pill for the reply in progress: how long it has run, and its stop button.
 * why: It mounts when the reply starts, as the transcript's own clock starts on first sight.
 */
function WorkingPill({ onStop }: { onStop: () => void }) {
  const t = useLabels();
  const [startedAt] = useState(() => Date.now());
  const now = useSecondTicker(true);
  const stop = t('@theorem.composer.pill.stop');
  return (
    <Token
      size="lg"
      style={WORKING_PILL}
      label={t('@theorem.composer.pill.working')}
      icon={<Spinner size="sm" shade="inherit" aria-label={t('@theorem.composer.pill.working')} />}
      endContent={
        <HStack gap={1} vAlign="center">
          <Text size="sm" color="secondary" hasTabularNumbers>
            {elapsedLabel(t, now - startedAt)}
          </Text>
          <IconButton
            label={stop}
            tooltip={stop}
            size="sm"
            variant="ghost"
            icon={<IconPlayerStopFilled size={12} />}
            onClick={onStop}
          />
        </HStack>
      }
    />
  );
}

/**
 * The pill row. One pill sits centred over the composer; with more, the working pill leads and
 * the rest follow it, scrolling sideways once they outgrow the row.
 */
function PillRow(
  props: Pick<ComposerRowParts, 'isWorking' | 'backgroundJobs' | 'onStop' | 'hint'>,
) {
  const t = useLabels();
  const pills = [
    props.isWorking ? <WorkingPill key="working" onStop={props.onStop} /> : null,
    ...props.backgroundJobs.map((job) => (
      <Token
        key={job.callId}
        size="lg"
        style={PILL}
        label={job.label}
        description={t('@theorem.composer.pill.background')}
        icon={<IconClockPlay size={14} />}
      />
    )),
  ].filter(Boolean);
  if (pills.length === 0 && !props.hint) return null;
  const hint = props.hint ? <HStack hAlign="end">{props.hint}</HStack> : null;
  if (pills.length <= 1) {
    // invariant: Two equal sides keep the one pill centred whether or not a hint is shown.
    return (
      <HStack gap={2} vAlign="center" style={PILL_ROW}>
        <StackItem size="fill" />
        {pills}
        <StackItem size="fill">{hint}</StackItem>
      </HStack>
    );
  }
  return (
    <HStack gap={2} vAlign="center" style={PILL_ROW}>
      <StackItem size="fill" style={PILL_SCROLL}>
        <HStack gap={1} vAlign="center">
          {pills}
        </HStack>
      </StackItem>
      {hint}
    </HStack>
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

/**
 * The surface takes Astryx's composer body: the chat radius, the popover fill, no border.
 * invariant: It sits above the drawer, which tucks under it by the chat radius, as in ChatComposer.
 */
const ROW_SURFACE: CSSProperties = {
  position: 'relative',
  zIndex: 2,
  border: 'none',
  borderRadius: 'var(--radius-chat)',
  background: 'var(--color-background-popover)',
  // why: As in ChatComposer: buttons follow the shell's curve, so send and the send menu are round.
  '--_button-radius': 'max(var(--radius-element), calc(var(--radius-chat) - var(--spacing-3)))',
} as CSSProperties;
/** why: The drawer and the surface overlap, so their layering stays inside the composer. */
const DRAWER_AND_SURFACE: CSSProperties = { position: 'relative', zIndex: 0, isolation: 'isolate' };

/** The surface: attach, the field, then the controls, the mic, and send. */
function RowSurface(
  props: Pick<ComposerRowParts, 'attach' | 'input' | 'controls' | 'record' | 'action'> & {
    stacked: boolean;
  },
) {
  const attach = props.attach ? <StackItem>{props.attach}</StackItem> : null;
  return (
    <Card elevation="low" padding={3} style={ROW_SURFACE}>
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
    <VStack gap={2} width="100%">
      <PillRow
        isWorking={props.isWorking}
        backgroundJobs={props.backgroundJobs}
        onStop={props.onStop}
        hint={props.hint}
      />
      <VStack gap={0} width="100%" style={DRAWER_AND_SURFACE}>
        {props.drawer ? <StackItem style={DRAWER_INSET}>{props.drawer}</StackItem> : null}
        <RowSurface
          stacked={stacked}
          attach={props.attach}
          input={props.input}
          controls={props.controls}
          record={props.record}
          action={props.action}
        />
      </VStack>
      <RowStatus status={props.status} />
    </VStack>
  );
}
