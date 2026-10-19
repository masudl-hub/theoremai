import type { DecisionEntry } from '@theoremjs/agents';
import type { TraceFeed } from '@theoremjs/react/client';
import { TheoremDecision } from '@theoremjs/react/ui';
import { use, useContext, useMemo } from 'react';
import { createBrowserStudioDecisionTransport, type StudioBrowserRuntime } from '../browser.ts';
import {
  createStudioDecisionTransport,
  DECISION_EXAMPLE_AGENT_ID,
  DECISION_EXAMPLE_STATE,
  decisionExampleAssets,
  EXAMPLE_DECISION_STATE,
  EXAMPLE_SPAN_DECISION_STATE,
  type StudioRunPayload,
} from '../mod.ts';
import { QuestionLink } from './inspector-context.ts';
import { noting } from './lib/studio-activity.ts';

let exampleAssets: ReturnType<typeof decisionExampleAssets> | undefined;

/**
 * What a decision's form starts with: an example its model can be asked about, and the pictures the
 * example names. The example's pictures load the first time; until then the form suspends.
 */
export function useDecisionSeed(payload: StudioRunPayload) {
  if (payload.agentId === DECISION_EXAMPLE_AGENT_ID) {
    exampleAssets ??= decisionExampleAssets();
    return { defaultState: DECISION_EXAMPLE_STATE, defaultImages: { ...use(exampleAssets) } };
  }
  const { profile } = payload;
  const model = profile.type === 'decision' ? Object.values(profile.models)[0] : undefined;
  return {
    defaultState: model?.apiId.startsWith('respan/')
      ? EXAMPLE_SPAN_DECISION_STATE
      : EXAMPLE_DECISION_STATE,
  };
}

/** What the builder preview and the standalone run tab hand a one-call console. */
export interface StudioConsoleProps {
  payload: StudioRunPayload;
  className?: string;
  runtime?: StudioBrowserRuntime | null;
  /** The conversation's trace feed, kept across recompiles. */
  traces?: TraceFeed;
  /** Called before each call; stable, or the transport is rebuilt each render. */
  onActivity?: () => void;
  /** The page's own trace control. */
  trace?: boolean;
  /** The page is already the shell. The console sits in it. */
  flush?: boolean;
  /** The request on the left and the result on the right. */
  columns?: boolean;
}

/** A console's transport: in the browser's runtime when there is one, else through the studio's server. */
export function useStudioTransport<T extends object>(
  { payload, runtime = null, traces, onActivity }: StudioConsoleProps,
  onServer: (payload: StudioRunPayload, options: { traces?: TraceFeed }) => T,
  inBrowser: (
    payload: StudioRunPayload,
    runtime: StudioBrowserRuntime,
    options: { traces?: TraceFeed },
  ) => T,
): T {
  return useMemo(() => {
    const made = runtime ? inBrowser(payload, runtime, { traces }) : onServer(payload, { traces });
    return onActivity ? noting(made, onActivity) : made;
  }, [payload, runtime, traces, onActivity, onServer, inBrowser]);
}

/** An instruction as one line of text: its own words, with a structured one's parts in order. */
function entryText(entry: DecisionEntry): string {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) return entry.map(entryText).join(' ');
  return Object.entries(entry)
    .map(([key, value]) => `${key}: ${entryText(value)}`)
    .join(' ');
}

/** The same decision runner in the builder preview and the standalone run tab. */
export function StudioDecision(props: StudioConsoleProps) {
  const { open } = useContext(QuestionLink);
  const transport = useStudioTransport(
    props,
    createStudioDecisionTransport,
    createBrowserStudioDecisionTransport,
  );
  const seed = useDecisionSeed(props.payload);
  const { questions } = props.payload;
  const questionText = useMemo(
    () =>
      questions &&
      Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [id, entryText(question.instructions)]),
      ),
    [questions],
  );
  return (
    <TheoremDecision
      transport={transport}
      {...seed}
      trace={props.trace}
      flush={props.flush}
      columns={props.columns}
      className={props.className}
      onQuestion={open}
      questionText={questionText}
    />
  );
}
