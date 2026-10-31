import type { DecisionEntry } from '@theoremjs/agents';
import { TheoremDecision, type TheoremDecisionProps } from '@theoremjs/react/ui';
import { use, useContext, useMemo } from 'react';
import { createBrowserStudioDecisionTransport } from '../browser.ts';
import {
  createStudioDecisionTransport,
  DECISION_EXAMPLE_AGENT_ID,
  DECISION_EXAMPLE_STATE,
  decisionExampleAssets,
  EXAMPLE_DECISION_STATE,
  EXAMPLE_SPAN_DECISION_STATE,
  RESEARCH_PAGE_READER_AGENT_ID,
  RESEARCH_PAGE_READER_STATE,
  type StudioRunPayload,
} from '../mod.ts';
import { QuestionLink } from './inspector-context.ts';
import {
  type ConsoleViewProps,
  type StudioConsoleProps,
  useStudioTransport,
} from './lib/studio-console.ts';

let exampleAssets: ReturnType<typeof decisionExampleAssets> | undefined;

/**
 * What a decision's form starts with: an example its model can be asked about, and the pictures the
 * example names. The example's pictures load the first time; until then the form suspends.
 */
function useDecisionSeed(payload: StudioRunPayload) {
  if (payload.agentId === DECISION_EXAMPLE_AGENT_ID) {
    exampleAssets ??= decisionExampleAssets();
    return { defaultState: DECISION_EXAMPLE_STATE, defaultImages: { ...use(exampleAssets) } };
  }
  if (payload.agentId === RESEARCH_PAGE_READER_AGENT_ID) {
    return { defaultState: RESEARCH_PAGE_READER_STATE };
  }
  const { profile } = payload;
  const model = profile.type === 'decision' ? Object.values(profile.models)[0] : undefined;
  return {
    defaultState: model?.apiId.startsWith('respan/')
      ? EXAMPLE_SPAN_DECISION_STATE
      : EXAMPLE_DECISION_STATE,
  };
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
  const transport = useStudioTransport(
    props,
    createStudioDecisionTransport,
    createBrowserStudioDecisionTransport,
  );
  return <DecisionView {...props} transport={transport} />;
}

/** A decision on `transport`, seeded for its profile, its questions linked to the editor. */
export function DecisionView({
  payload,
  transport,
  trace,
  flush,
  columns,
  className,
}: ConsoleViewProps & Pick<TheoremDecisionProps, 'transport'>) {
  const { open } = useContext(QuestionLink);
  const seed = useDecisionSeed(payload);
  const { questions } = payload;
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
      trace={trace}
      flush={flush}
      columns={columns}
      className={className}
      onQuestion={open}
      questionText={questionText}
    />
  );
}
