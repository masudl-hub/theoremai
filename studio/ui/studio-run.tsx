import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconActivity, IconKey } from '@tabler/icons-react';
import type { ModelBinding } from '@theoremjs/agents';
import { PaneState, TheoremThemeProvider, TracePlacement } from '@theoremjs/react/ui';
import { useEffect, useState } from 'react';
import { studioKeySlots } from '../browser.ts';
import {
  modelRoute,
  modelSlots,
  onStudioLocal,
  readStudioRunIdFromUrl,
  STUDIO_PROVIDERS,
  type StudioRunPayload,
} from '../mod.ts';
import { recordsTraces } from './lib/project-traces.ts';
import { askRunKeys } from './lib/run-keys.ts';
import { ProjectContext } from './lib/studio-project.ts';
import type { StudioRunOpened } from './lib/studio-run-open.ts';
import { type StudioConnectionState, useStudioConnection } from './studio-connection.tsx';
import type { StudioSupplies } from './studio-host.ts';
import { StudioRunner } from './studio-runner.tsx';
import { usePhone } from './use-phone.ts';
import './studio-run.css';

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
  const { payload } = opened;
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
  const keysFromStudio = useStudioKeys(
    !opened.project && payload.connectionMode === 'byok',
    connection.setVault,
  );
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
              <Button
                label={traceOpen ? 'Hide trace' : 'View trace'}
                isIconOnly={phone}
                icon={<Icon icon={IconActivity} size="sm" />}
                aria-pressed={traceOpen}
                onClick={() => {
                  setTraceOpen((open) => !open);
                }}
              />
            ) : null}
          </div>
          {keysFromStudio === 'gone' ? (
            <PaneState
              icon={<Icon icon={IconKey} size="lg" color="secondary" />}
              title="Set your keys in the studio"
              description="This tab takes its keys from the studio tab that opened it, and that tab is closed. Open the agent in a new tab from the studio again."
            />
          ) : (
            <ProjectContext.Provider value={opened.project}>
              <StudioRunner
                key={mode}
                payload={payload}
                mode={mode}
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
 * Fills the vault from the studio tab that opened this one, when the run reads this browser's
 * keys. `gone` when there is no studio tab left to ask.
 */
function useStudioKeys(
  needed: boolean,
  setVault: StudioConnectionState['setVault'],
): 'asked' | 'gone' | 'unneeded' {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!needed) return;
    const run = readStudioRunIdFromUrl();
    const stop = run ? askRunKeys(run, setVault) : null;
    if (!stop) {
      setGone(true);
      return;
    }
    return stop;
  }, [needed, setVault]);
  if (!needed) return 'unneeded';
  return gone ? 'gone' : 'asked';
}
