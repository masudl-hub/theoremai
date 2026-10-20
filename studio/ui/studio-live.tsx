import { LiveRunner, type LiveRunnerProps } from '@theoremjs/react/live';
import { useMemo } from 'react';
import { browserStudioLiveConnection, type StudioBrowserRuntime } from '../browser.ts';
import {
  type StudioRunPayload,
  studioInterface,
  studioLiveConnection,
  studioPageTools,
} from '../mod.ts';
import { STUDIO_LABELS } from './lib/studio-labels.ts';

/** What a live call is run with, wherever it runs. */
export type StudioLiveProps = Pick<LiveRunnerProps, 'trace' | 'slots' | 'context'> & {
  payload: StudioRunPayload;
  /** Called as each call starts. */
  note: () => void;
};

/** A live profile's call: in the browser's runtime when there is one, else through the studio's server. */
export function StudioLive({
  runtime,
  ...props
}: StudioLiveProps & { runtime: StudioBrowserRuntime | null }) {
  const { payload } = props;
  return (
    <LiveView
      {...props}
      connect={() =>
        runtime ? browserStudioLiveConnection(payload, runtime) : studioLiveConnection(payload)
      }
    />
  );
}

/** A project's live profile: the call runs in the project, through the studio's local server. */
export function ProjectLive({ endpoint, ...props }: StudioLiveProps & { endpoint: string }) {
  return (
    <LiveView
      {...props}
      connect={() => ({ createSocket: () => new WebSocket(endpoint.replace(/^http/, 'ws')) })}
    />
  );
}

function LiveView({
  payload,
  note,
  connect,
  trace,
  slots,
  context,
}: StudioLiveProps & { connect: LiveRunnerProps['connection'] }) {
  const iface = useMemo(() => studioInterface(payload), [payload]);
  /** The studio's page answers each page tool with the tool's stub. */
  const pageTools = useMemo(() => studioPageTools(payload), [payload]);
  if (iface.type !== 'live') return null;
  return (
    <LiveRunner
      labels={STUDIO_LABELS}
      iface={iface}
      connection={() => {
        note();
        return connect();
      }}
      trace={trace}
      slots={slots}
      context={context}
      pageTools={pageTools}
    />
  );
}
