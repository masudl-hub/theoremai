import { Banner } from '@astryxdesign/core/Banner';
import type { DecisionJson } from '@theoremjs/agents';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { type DecisionImages, inStateFields } from '../client/decision-images.ts';
import {
  createDecisionTransport,
  type DecisionInterface,
  type DecisionTransport,
} from '../client/decision-transport.ts';
import { useTheoremDecision } from '../hooks/use-theorem-decision.ts';
import {
  ConsoleFrame,
  type ConsolePageProps,
  type ConsoleView,
  JsonRequest,
  RequestCard,
  ResponseColumn,
  RunBar,
  useBytes,
} from './ConsoleFrame.tsx';
import { TheoremDecisionAnswers, type TheoremDecisionAnswersProps } from './DecisionAnswers.tsx';
import { ImagesField } from './DecisionImages.tsx';
import type { LabelText } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { PaneFailure, PaneLoading } from './PaneState.tsx';
import { StateFields, StateImages } from './StateFields.tsx';
import { useTraceInspector } from './TraceInspectorPanel.tsx';
import { TheoremThemeProvider } from './theme.tsx';

export type TheoremDecisionProps = ConsolePageProps & {
  /** Where `createTheoremDecisionHandler` is mounted. Default `/api/decision`. Ignored when `transport` is set. */
  endpoint?: string;
  /** Bring your own transport (tests, studios, non-HTTP hosts). */
  transport?: DecisionTransport;
  /** The JSON the state field starts with. Default `{}`. */
  defaultState?: string;
  /**
   * Images attached when the page opens, by the name the state refers to them by. The visitor
   * can add and remove more; they travel with each decision.
   */
  defaultImages?: DecisionImages;
};

type StateCheck =
  | { ok: true; state: Exclude<DecisionJson, null>; bytes: number }
  | {
      ok: false;
      reason: 'invalid_json' | 'null_state' | 'too_large';
      bytes?: number;
      state?: DecisionJson;
    };

/** The field's text as the state a decision sends, measured the way the kernel measures it. */
function checkState(text: string, maxBytes: number | undefined): StateCheck {
  let state: DecisionJson;
  try {
    state = JSON.parse(text) as DecisionJson;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (state === null) return { ok: false, reason: 'null_state', state };
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (maxBytes !== undefined && bytes > maxBytes)
    return { ok: false, reason: 'too_large', bytes, state };
  return { ok: true, state, bytes };
}

function stateNote(
  t: LabelText,
  check: StateCheck,
  maxBytes: number | undefined,
  bytes: (n: number) => string,
): string | null {
  if (!check.ok) {
    if (check.reason === 'too_large')
      return t('@theorem.decision.too_large', { limit: bytes(maxBytes ?? 0) });
    return t(
      check.reason === 'invalid_json'
        ? '@theorem.decision.invalid_json'
        : '@theorem.decision.null_state',
    );
  }
  return maxBytes === undefined
    ? null
    : t('@theorem.decision.state_size', { size: bytes(check.bytes), limit: bytes(maxBytes) });
}

type BodyProps = Omit<
  TheoremDecisionProps,
  'endpoint' | 'http' | 'transport' | 'theme' | 'mode' | 'labels'
> & {
  transport: DecisionTransport;
  iface: DecisionInterface;
  decision: ReturnType<typeof useTheoremDecision>;
};

type Decision = BodyProps['decision'];

/** Where a decision stands: nothing asked, asked with nothing back yet, or answered or failed. */
function decisionPhase(decision: Decision): 'idle' | 'waiting' | 'settled' {
  if (decision.failure || decision.result) return 'settled';
  return decision.status === 'deciding' ? 'waiting' : 'idle';
}

/** The state a decision is asked about, held as text, and the view it is edited in. */
function useDecisionState(defaultState: string, maxStateBytes: DecisionInterface['maxStateBytes']) {
  const [text, setText] = useState(defaultState);
  const check = checkState(text, maxStateBytes);
  const [view, setView] = useState<ConsoleView>(() =>
    check.state === undefined ? 'json' : 'fields',
  );
  const shown: ConsoleView = check.state === undefined ? 'json' : view;
  return { text, setText, check, shown, setView };
}

/** The state, as fields or JSON, and Decide. */
function DecisionRequest({
  form,
  iface,
  images,
  onImages,
  note,
  isRunning,
  onRun,
  onStop,
}: {
  form: ReturnType<typeof useDecisionState>;
  iface: DecisionInterface;
  images: DecisionImages;
  onImages: (next: DecisionImages) => void;
  note: string | null;
  isRunning: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const t = useLabels();
  const { text, setText, check, shown, setView } = form;
  const withImages =
    iface.questions.some((question) => question.type === 'box') || Object.keys(images).length > 0;
  const fields = shown === 'fields' ? check.state : undefined;
  return (
    <RequestCard
      title={t('@theorem.decision.state')}
      view={shown}
      hasFields={check.state !== undefined}
      onView={setView}
      onRun={onRun}
    >
      {fields !== undefined ? (
        <StateImages value={images}>
          <StateFields
            label={t('@theorem.decision.state')}
            value={fields}
            onChange={(next) => {
              setText(JSON.stringify(next, null, 2));
            }}
          />
        </StateImages>
      ) : (
        <JsonRequest
          label={t('@theorem.decision.state')}
          text={text}
          isInvalid={!check.ok}
          onChange={setText}
        />
      )}
      {withImages ? (
        <ImagesField
          images={images}
          inFields={fields === undefined ? new Set() : inStateFields(images, fields)}
          onChange={onImages}
        />
      ) : null}
      <RunBar
        note={note}
        isReady={check.ok}
        isRunning={isRunning}
        runLabel={t('@theorem.decision.decide')}
        runningLabel={t('@theorem.decision.deciding')}
        stopLabel={t('@theorem.decision.stop')}
        onRun={onRun}
        onStop={onStop}
      />
    </RequestCard>
  );
}

/** What came back: the failure, the answers, or a spinner until the first of either. */
function DecisionAnswered({
  iface,
  decision,
  asked,
}: {
  iface: DecisionInterface;
  decision: Decision;
  asked?: TheoremDecisionAnswersProps['asked'];
}) {
  const t = useLabels();
  const deciding = decision.status === 'deciding';
  return (
    <>
      {decision.failure ? (
        <Banner status="error" role="alert" title={decision.failure.error} />
      ) : null}
      {deciding && !decision.result ? (
        <PaneLoading label={t('@theorem.decision.deciding')} since={decision.startedAt} />
      ) : null}
      {decision.result ? (
        <TheoremDecisionAnswers
          iface={iface}
          result={decision.result}
          asked={asked}
          elapsedMs={decision.elapsedMs}
          isStale={deciding}
        />
      ) : null}
    </>
  );
}

/**
 * The frame's second child. A call, not a component: the frame counts its
 * children to choose a layout, and no response yet has to count as none.
 */
function decisionResponse(
  columns: boolean,
  phase: ReturnType<typeof decisionPhase>,
  labels: { answers: string; deciding: string },
  since: number | null,
  answers: ReactNode,
): ReactNode {
  if (phase === 'idle') return null;
  if (!columns) return answers;
  const waiting = phase === 'waiting';
  return (
    <ResponseColumn label={labels.answers} fill={waiting}>
      {waiting ? <PaneLoading label={labels.deciding} since={since} /> : answers}
    </ResponseColumn>
  );
}

function DecisionBody({
  transport,
  iface,
  decision,
  defaultState = '{}',
  defaultImages,
  maxWidth = '960px',
  trace,
  flush,
  columns = false,
  className,
  style,
}: BodyProps) {
  const t = useLabels();
  const bytes = useBytes();
  const form = useDecisionState(defaultState, iface.maxStateBytes);
  const { check } = form;
  const [images, setImages] = useState<DecisionImages>(defaultImages ?? {});
  /** The images and state the answers were asked about, kept with them: later edits don't redraw them. */
  const [asked, setAsked] = useState<TheoremDecisionAnswersProps['asked']>();
  const inspector = useTraceInspector(iface, transport.traces, trace);

  const decide = () => {
    if (!check.ok) return;
    setAsked({ images, state: check.state });
    void decision.decide(check.state, Object.keys(images).length > 0 ? images : undefined);
  };

  return (
    <ConsoleFrame
      inspector={inspector}
      maxWidth={maxWidth}
      flush={flush}
      columns={columns}
      requestLabel={t('@theorem.decision.state')}
      className={className}
      style={style}
    >
      <DecisionRequest
        form={form}
        iface={iface}
        images={images}
        onImages={setImages}
        note={stateNote(t, check, iface.maxStateBytes, bytes)}
        isRunning={decision.status === 'deciding'}
        onRun={decide}
        onStop={decision.cancel}
      />
      {decisionResponse(
        columns,
        decisionPhase(decision),
        { answers: t('@theorem.decision.answers'), deciding: t('@theorem.decision.deciding') },
        decision.startedAt,
        <DecisionAnswered iface={iface} decision={decision} asked={asked} />,
      )}
    </ConsoleFrame>
  );
}

function DecisionForTransport(props: Omit<BodyProps, 'iface' | 'decision'>) {
  const t = useLabels();
  const decision = useTheoremDecision(props.transport);
  if (decision.describeFailure) return <PaneFailure title={decision.describeFailure.error} />;
  if (!decision.iface) return <PaneLoading label={t('@theorem.chat.loading')} />;
  return <DecisionBody {...props} iface={decision.iface} decision={decision} />;
}

/**
 * Drop-in surface for a decision profile served by `createTheoremDecisionHandler`:
 * the state as fields or JSON, a Decide button (⌘/Ctrl+Enter), and the answers.
 *
 * ```tsx
 * <TheoremDecision endpoint="/api/decision" />
 * ```
 */
export function TheoremDecision({
  endpoint,
  http,
  transport,
  theme,
  mode,
  labels,
  ...rest
}: TheoremDecisionProps) {
  const httpRef = useRef(http);
  httpRef.current = http;
  const resolved = useMemo(
    () => transport ?? createDecisionTransport({ ...httpRef.current, endpoint }),
    [transport, endpoint],
  );
  return (
    <TheoremThemeProvider theme={theme} mode={mode}>
      <TheoremLabelsProvider labels={labels}>
        <DecisionForTransport {...rest} transport={resolved} />
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}
