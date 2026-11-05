import { Icon } from '@astryxdesign/core/Icon';
import { IconKey } from '@tabler/icons-react';
import type { ModelBinding } from '@theoremjs/agents';
import { PaneState, TheoremThemeProvider, TracePlacement } from '@theoremjs/react/ui';
import { useEffect, useMemo, useState } from 'react';
import { studioKeySlots } from '../browser.ts';
import {
  modelRoute,
  modelSlots,
  onStudioLocal,
  readStudioRunIdFromUrl,
  STUDIO_PROVIDERS,
  type StudioRunCredentials,
  type StudioRunPayload,
  withStudioRunCredentials,
} from '../mod.ts';
import { recordsTraces } from './lib/project-traces.ts';
import { askRunKeys, type RunKeys } from './lib/run-keys.ts';
import { ProjectContext } from './lib/studio-project.ts';
import type { StudioRunOpened } from './lib/studio-run-open.ts';
import { useStudioConnection } from './studio-connection.tsx';
import type { StudioSupplies } from './studio-host.ts';
import { StudioRunner } from './studio-runner.tsx';
import { usePhone } from './use-phone.ts';
import './studio-run.css';
import { TraceButton } from './trace-button.tsx';

/** A model binding as the connection reads it. */
type ConnectionModel = Parameters<typeof useStudioConnection>[0][number];

/** The name the page and the document title use. A host has no handle: it's named by its id. */
export function studioRunTitle(payload: StudioRunPayload): string {
  return 'identity' in payload.profile ? payload.profile.identity.handle : payload.agentId;
}

/** The providers a run's models name: the ones its agent compiled with, else the studio's own. */
function providersOf(payload: StudioRunPayload) {
  return payload.providers ?? STUDIO_PROVIDERS;
}

/**
 * An agent opened in a tab of its own: the runner fills the page, with View trace above it.
 * Its keys come from the studio tab that opened it.
 * `opened` is what `openStudioRun` returned for this tab.
 */
export function StudioRunScreen({
  opened,
  supplies,
}: {
  opened: StudioRunOpened;
  /** What the page gives the run, as it gives the studio. */
  supplies?: StudioSupplies;
}) {
  const fromStudio = useFromStudio(opened.masked);
  const payload = useMemo(
    () =>
      fromStudio.tools
        ? withStudioRunCredentials(opened.payload, fromStudio.tools)
        : opened.payload,
    [opened.payload, fromStudio.tools],
  );
  // The agent and the agents it calls each read their own key slots.
  const profiles = [
    payload.profile,
    ...(payload.dependencies ?? []).map((dependency) => dependency.profile),
  ];
  const models = profiles.flatMap((profile) =>
    profile.type === 'host'
      ? []
      : Object.values<ModelBinding>(profile.models).map(
          (binding): ConnectionModel => ({
            ...modelRoute(providersOf(payload), profile.type, binding),
            builtInTools: binding.builtInTools,
            local: onStudioLocal(binding.provider, payload.providers !== undefined),
          }),
        ),
  );
  const connection = useStudioConnection(
    models,
    payload.localBaseUrl,
    [
      ...profiles.flatMap((profile) => studioKeySlots(profile)),
      ...profiles.flatMap((profile) =>
        profile.type === 'host'
          ? []
          : Object.values<ModelBinding>(profile.models).flatMap((binding) =>
              Object.values(modelSlots(providersOf(payload), binding)),
            ),
      ),
    ],
    supplies,
  );
  const needsKeys = !opened.project && payload.connectionMode === 'byok';
  const { setVault } = connection;
  useEffect(() => {
    if (needsKeys && fromStudio.keys) setVault(fromStudio.keys);
  }, [needsKeys, fromStudio.keys, setVault]);
  const isGone = fromStudio.gone && (needsKeys || opened.masked);
  // why: a tool called before its credentials arrive would go out with them masked.
  const isWaiting = opened.masked && !fromStudio.tools && !fromStudio.gone;
  const traced = recordsTraces(payload);
  const [traceOpen, setTraceOpen] = useState(false);
  const phone = usePhone();
  const { mode, runtime } = connection;
  const title = studioRunTitle(payload);

  return (
    <TheoremThemeProvider mode="dark">
      {/* The draft exists only in the browser, so the title is set after hydration. */}
      <title>{`${title} · theorem studio`}</title>
      <TracePlacement value="panel">
        <div className="run-page">
          <div className="run-controls">
            {traced ? (
              <TraceButton
                open={traceOpen}
                isIconOnly={phone}
                onToggle={() => {
                  setTraceOpen((open) => !open);
                }}
              />
            ) : null}
          </div>
          {isGone ? (
            <PaneState
              icon={<Icon icon={IconKey} size="lg" color="secondary" />}
              title="Open the agent from the studio again"
              description="This tab takes its keys and its tools' credentials from the studio tab that opened it, and that tab no longer holds them: it was closed, reloaded, or left the studio. Open the agent in a new tab from the studio again."
            />
          ) : isWaiting ? null : (
            <ProjectContext.Provider value={opened.project}>
              <StudioRunner
                key={mode}
                payload={payload}
                runtime={runtime}
                trace={traced ? traceOpen : undefined}
                flush
                columns
                className="run-chat"
              />
            </ProjectContext.Provider>
          )}
        </div>
      </TracePlacement>
    </TheoremThemeProvider>
  );
}

/**
 * What the studio tab that opened this one answers: its keys, and the credentials the kept copy of
 * this run masked. `gone` when no studio tab holds them for it.
 */
function useFromStudio(masked: boolean): {
  keys?: RunKeys;
  tools?: StudioRunCredentials;
  gone: boolean;
} {
  const [answer, setAnswer] = useState<{ keys: RunKeys; tools: StudioRunCredentials }>();
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const run = readStudioRunIdFromUrl();
    const stop = run
      ? askRunKeys(
          run,
          (keys, tools) => {
            setAnswer({ keys, tools });
          },
          () => {
            setGone(true);
          },
        )
      : null;
    if (!stop) {
      setGone(true);
      return;
    }
    return stop;
  }, []);
  return { ...answer, tools: masked ? answer?.tools : undefined, gone };
}
