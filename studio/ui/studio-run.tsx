import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Popover } from '@astryxdesign/core/Popover';
import { IconActivity, IconKey } from '@tabler/icons-react';
import type { ModelBinding } from '@theoremjs/agents';
import { TheoremThemeProvider, TracePlacement } from '@theoremjs/react/ui';
import { useState, useSyncExternalStore } from 'react';
import { studioKeySlots } from '../browser.ts';
import {
  modelRoute,
  modelSlots,
  onStudioLocal,
  STUDIO_PROVIDERS,
  type StudioRunPayload,
} from '../mod.ts';
import { recordsTraces } from './lib/project-traces.ts';
import { ProjectContext } from './lib/studio-project.ts';
import type { StudioRunOpened } from './lib/studio-run-open.ts';
import { StudioKeys, useStudioConnection } from './studio-connection.tsx';
import type { StudioSupplies } from './studio-host.ts';
import { StudioRunner } from './studio-runner.tsx';
import './studio-run.css';

/** A model binding as the connection reads it. */
type ConnectionModel = Parameters<typeof useStudioConnection>[0][number];

/** The width below which these controls keep only their icon. */
const PHONE = '(width < 768px)';

function usePhone() {
  return useSyncExternalStore(
    (change) => {
      const query = globalThis.matchMedia(PHONE);
      query.addEventListener('change', change);
      return () => {
        query.removeEventListener('change', change);
      };
    },
    () => globalThis.matchMedia(PHONE).matches,
    () => false,
  );
}

/** The name the page and the document title use. A host has no handle: it's named by its id. */
export function studioRunTitle(payload: StudioRunPayload): string {
  return 'identity' in payload.profile ? payload.profile.identity.handle : payload.agentId;
}

/** `payload` with each `from` slot, on its agent and the agents it calls, renamed to `to`. */
function withRenamedSlot(current: StudioRunPayload, from: string, to: string): StudioRunPayload {
  const rename = <T extends { keySlot?: string; fallbackKeySlot?: string }>(value: T): T => ({
    ...value,
    ...(value.keySlot === from ? { keySlot: to } : {}),
    ...(value.fallbackKeySlot === from ? { fallbackKeySlot: to } : {}),
  });
  const renamed = (profile: StudioRunPayload['profile']): StudioRunPayload['profile'] =>
    profile.type === 'host'
      ? profile
      : {
          ...profile,
          models: Object.fromEntries(
            Object.entries<ModelBinding>(profile.models).map(([id, model]) => [id, rename(model)]),
          ),
        };
  return {
    ...current,
    profile: renamed(current.profile),
    ...(current.dependencies
      ? {
          dependencies: current.dependencies.map((dependency) => ({
            ...dependency,
            profile: renamed(dependency.profile),
          })),
        }
      : {}),
  };
}

/** The providers a run's models name: the ones its agent compiled with, else the studio's own. */
function providersOf(payload: StudioRunPayload) {
  return payload.providers ?? STUDIO_PROVIDERS;
}

/** `payload` with `slot` as the key of each model that reads none, unless it is a host. */
function withAddedSlot(current: StudioRunPayload, slot: string): StudioRunPayload {
  if (current.profile.type === 'host') return current;
  return {
    ...current,
    profile: {
      ...current.profile,
      models: Object.fromEntries(
        Object.entries<ModelBinding>(current.profile.models).map(([id, binding]) => [
          id,
          modelSlots(providersOf(current), binding).keySlot
            ? binding
            : { ...binding, keySlot: slot },
        ]),
      ),
    },
  };
}

/** The Keys button and the popover it opens. */
function KeysPopover({
  connection,
  isOpen,
  onOpenChange,
  onAddSlot,
  onRenameSlot,
  phone,
}: {
  connection: ReturnType<typeof useStudioConnection>;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onAddSlot: (slot: string) => void;
  onRenameSlot: (from: string, to: string) => void;
  phone: boolean;
}) {
  return (
    <Popover
      label="Keys"
      placement="below"
      alignment="end"
      width={360}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      content={
        <StudioKeys connection={connection} onAddSlot={onAddSlot} onRenameSlot={onRenameSlot} />
      }
    >
      <Button
        label="Keys"
        isIconOnly={phone}
        icon={<Icon icon={IconKey} size="sm" />}
        aria-pressed={isOpen}
      />
    </Popover>
  );
}

/**
 * An agent opened in a tab of its own: the runner fills the page, with View trace and Keys above it.
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
  const [payload, setPayload] = useState(opened.payload);
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
  const [keysOpen, setKeysOpen] = useState(payload.connectionMode === 'byok');
  const traced = recordsTraces(payload);
  const [traceOpen, setTraceOpen] = useState(false);
  const phone = usePhone();
  const { mode, runtime } = connection;
  const title = studioRunTitle(payload);
  const renameSlot = (from: string, to: string) => {
    setPayload((current) => withRenamedSlot(current, from, to));
  };

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
            <KeysPopover
              connection={connection}
              isOpen={keysOpen}
              onOpenChange={setKeysOpen}
              onAddSlot={(slot) => {
                setPayload((current) => withAddedSlot(current, slot));
              }}
              onRenameSlot={renameSlot}
              phone={phone}
            />
          </div>
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
        </div>
      </TracePlacement>
    </TheoremThemeProvider>
  );
}
