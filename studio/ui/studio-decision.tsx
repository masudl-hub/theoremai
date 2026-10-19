import type { TraceFeed } from '@theoremjs/react/client';
import { TheoremDecision } from '@theoremjs/react/ui';
import { useMemo } from 'react';
import { createBrowserStudioDecisionTransport, type StudioBrowserRuntime } from '../browser.ts';
import {
  createStudioDecisionTransport,
  EXAMPLE_DECISION_STATE,
  EXAMPLE_SPAN_DECISION_STATE,
  type StudioRunPayload,
} from '../mod.ts';
import { noting } from './lib/studio-activity.ts';

/** The state a decision's form starts with: an example its model can be asked about. */
export function decisionSeed(profile: StudioRunPayload['profile']) {
  const model = profile.type === 'decision' ? Object.values(profile.models)[0] : undefined;
  return model?.apiId.startsWith('respan/') ? EXAMPLE_SPAN_DECISION_STATE : EXAMPLE_DECISION_STATE;
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

/** The same decision runner in the builder preview and the standalone run tab. */
export function StudioDecision(props: StudioConsoleProps) {
  const transport = useStudioTransport(
    props,
    createStudioDecisionTransport,
    createBrowserStudioDecisionTransport,
  );
  return (
    <TheoremDecision
      transport={transport}
      defaultState={decisionSeed(props.payload.profile)}
      trace={props.trace}
      flush={props.flush}
      columns={props.columns}
      className={props.className}
    />
  );
}
