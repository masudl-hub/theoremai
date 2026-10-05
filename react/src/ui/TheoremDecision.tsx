import { Banner } from '@astryxdesign/core/Banner';
import { useLocale } from '@astryxdesign/core/i18n';
import { Spinner } from '@astryxdesign/core/Spinner';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import type { DecisionJson } from '@theoremjs/agents';
import { type CSSProperties, useMemo, useRef, useState } from 'react';
import {
  createDecisionTransport,
  type DecisionInterface,
  type DecisionTransport,
} from '../client/decision-transport.ts';
import type { HttpOptions } from '../client/transport.ts';
import { useTheoremDecision } from '../hooks/use-theorem-decision.ts';
import {
  ConsoleFrame,
  type ConsoleView,
  JsonRequest,
  RequestCard,
  RunBar,
} from './ConsoleFrame.tsx';
import { TheoremDecisionAnswers } from './DecisionAnswers.tsx';
import type { LabelText, TheoremLabels } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { StateFields } from './StateFields.tsx';
import { useTraceInspector } from './TraceInspectorPanel.tsx';
import { TheoremThemeProvider } from './theme.tsx';

export type TheoremDecisionProps = {
  /** Where `createTheoremDecisionHandler` is mounted. Default `/api/decision`. Ignored when `transport` is set. */
  endpoint?: string;
  /** Extra fetch options for the default HTTP transport (auth headers, custom fetch). */
  http?: HttpOptions;
  /** Bring your own transport (tests, playgrounds, non-HTTP hosts). */
  transport?: DecisionTransport;
  /** The JSON the state field starts with. Default `{}`. */
  defaultState?: string;
  theme?: DefinedTheme;
  mode?: 'system' | 'light' | 'dark';
  /** Replacement lines by locale, for any `@theorem.*` or `@astryx.*` key. */
  labels?: TheoremLabels;
  /** Widest the column may grow, as a CSS length. Default `960px`. */
  maxWidth?: string;
  /**
   * Show the trace in place of the decision, from the host's own control; the
   * built-in trace toggle then hides. Omit to keep the toggle. Needs a profile
   * that records traces.
   */
  trace?: boolean;
  className?: string;
  style?: CSSProperties;
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

function useBytes(): (bytes: number) => string {
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
    ? bytes(check.bytes)
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

function DecisionBody({
  transport,
  iface,
  decision,
  defaultState = '{}',
  maxWidth = '960px',
  trace,
  className,
  style,
}: BodyProps) {
  const t = useLabels();
  const bytes = useBytes();
  const [text, setText] = useState(defaultState);
  const check = checkState(text, iface.maxStateBytes);
  const note = stateNote(t, check, iface.maxStateBytes, bytes);
  const [view, setView] = useState<ConsoleView>(() =>
    check.state === undefined ? 'json' : 'fields',
  );
  const shown = check.state === undefined ? 'json' : view;
  const inspector = useTraceInspector(iface, transport.traces, trace);
  const deciding = decision.status === 'deciding';

  const decide = () => {
    if (check.ok) void decision.decide(check.state);
  };

  return (
    <ConsoleFrame inspector={inspector} maxWidth={maxWidth} className={className} style={style}>
      <RequestCard
        title={t('@theorem.decision.state')}
        view={shown}
        hasFields={check.state !== undefined}
        onView={setView}
        onRun={decide}
      >
        {shown === 'fields' && check.state !== undefined ? (
          <StateFields
            label={t('@theorem.decision.state')}
            value={check.state}
            onChange={(next) => {
              setText(JSON.stringify(next, null, 2));
            }}
          />
        ) : (
          <JsonRequest
            label={t('@theorem.decision.state')}
            text={text}
            isInvalid={!check.ok}
            onChange={setText}
          />
        )}
        <RunBar
          note={note}
          isReady={check.ok}
          isRunning={deciding}
          runLabel={t('@theorem.decision.decide')}
          runningLabel={t('@theorem.decision.deciding')}
          stopLabel={t('@theorem.decision.stop')}
          onRun={decide}
          onStop={decision.cancel}
        />
      </RequestCard>
      {decision.failure ? <Banner status="error" title={decision.failure.error} /> : null}
      {decision.result ? (
        <TheoremDecisionAnswers
          iface={iface}
          result={decision.result}
          elapsedMs={decision.elapsedMs}
          isStale={deciding}
        />
      ) : null}
    </ConsoleFrame>
  );
}

function DecisionForTransport(props: Omit<BodyProps, 'iface' | 'decision'>) {
  const t = useLabels();
  const decision = useTheoremDecision(props.transport);
  if (decision.describeFailure)
    return <Banner status="error" title={decision.describeFailure.error} />;
  if (!decision.iface) return <Spinner size="lg" label={t('@theorem.chat.loading')} />;
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
