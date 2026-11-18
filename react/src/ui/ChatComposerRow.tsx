import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import type { ChatComposerStatus } from '@astryxdesign/core/Chat';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StackItem } from '@astryxdesign/core/Stack';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { IconClockPlay, IconPlayerStopFilled } from '@tabler/icons-react';
import { type ReactNode, type RefObject, useLayoutEffect, useState } from 'react';
import type { BackgroundJob } from '../client/transcript-groups.ts';
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

/** The pill for the reply in progress, with its stop button. */
function WorkingPill({ onStop }: { onStop: () => void }) {
  const t = useLabels();
  const stop = t('@theorem.composer.pill.stop');
  return (
    <Token
      label={t('@theorem.composer.pill.working')}
      icon={<Spinner size="sm" shade="inherit" aria-label={t('@theorem.composer.pill.working')} />}
      endContent={
        <IconButton
          label={stop}
          tooltip={stop}
          size="sm"
          variant="ghost"
          icon={<IconPlayerStopFilled size={12} />}
          onClick={onStop}
        />
      }
    />
  );
}

function PillRow(
  props: Pick<ComposerRowParts, 'isWorking' | 'backgroundJobs' | 'onStop' | 'hint'>,
) {
  const t = useLabels();
  if (!props.isWorking && props.backgroundJobs.length === 0 && !props.hint) return null;
  return (
    <HStack gap={1} wrap="wrap" vAlign="center" paddingInline={1}>
      {props.isWorking ? <WorkingPill onStop={props.onStop} /> : null}
      {props.backgroundJobs.map((job) => (
        <Token
          key={job.callId}
          label={job.label}
          description={t('@theorem.composer.pill.background')}
          icon={<IconClockPlay size={14} />}
        />
      ))}
      {props.hint ? (
        <StackItem size="fill">
          <HStack hAlign="end">{props.hint}</HStack>
        </StackItem>
      ) : null}
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

/** The surface: attach, the field, then the controls, the mic, and send. */
function RowSurface(
  props: Pick<ComposerRowParts, 'attach' | 'input' | 'controls' | 'record' | 'action'> & {
    stacked: boolean;
  },
) {
  const attach = props.attach ? <StackItem>{props.attach}</StackItem> : null;
  return (
    <Card elevation="low" padding={1.5}>
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
      {props.drawer}
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
