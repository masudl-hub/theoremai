import type { TraceFeed } from '@theoremjs/web/client';
import { useMemo } from 'react';
import type { StudioBrowserRuntime } from '../../browser.ts';
import type { StudioRunPayload } from '../../mod.ts';
import { noting } from './studio-activity.ts';

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

/** How a console is laid out, whatever its transport. */
export type ConsoleViewProps = Pick<
  StudioConsoleProps,
  'payload' | 'className' | 'trace' | 'flush' | 'columns'
>;

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
