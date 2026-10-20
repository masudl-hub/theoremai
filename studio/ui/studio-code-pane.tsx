import { PaneFailure } from '@theoremjs/react/ui';
import { useCallback, useRef } from 'react';
import {
  agentDraft,
  definitionFactory,
  providerSource,
  readProviderSource,
  readStudioSource,
  type StudioIssue,
  type StudioProvider,
  withAgentDraft,
  withProvider,
} from '../mod.ts';
import { StudioCode } from './code/studio-code.tsx';
import type { CodeApply } from './studio-host.ts';
import type { StudioWorkspaceState } from './studio-screen.tsx';

/** The open agent's TypeScript. A failed compile keeps the text and marks the issues. */
export function CodeBody({
  source,
  blocked,
  issues,
  state,
}: {
  source: string | null;
  blocked: string | undefined;
  issues: StudioIssue[];
  state: StudioWorkspaceState;
}) {
  const seen = useRef(source);
  if (source) seen.current = source;
  const apply = useCallback(
    (text: string): CodeApply => {
      const current = agentDraft(state.workspace, state.focus);
      if (!current) {
        return { errors: [{ message: 'No agent is open.', line: 1, column: 1 }], spans: [] };
      }
      const read = readStudioSource(
        text,
        { ...current, toolSpecs: state.workspace.toolSpecs },
        (agentId) =>
          state.workspace.agents.find((agent) => agent.identity.agentId.trim() === agentId)?.key,
      );
      if (!read.ok) return { errors: read.errors, spans: [] };
      state.update((workspace) =>
        withAgentDraft(workspace, state.focus, read.draft, read.registered),
      );
      return { errors: [], spans: read.spans };
    },
    [state],
  );
  if (!seen.current) {
    return (
      <PaneFailure
        title="No code yet"
        description={`${blocked ?? ''} to generate the TypeScript.`}
      />
    );
  }
  return (
    <div className="studio-fill">
      <StudioCode
        text={source ?? seen.current}
        hold={source == null}
        issues={issues}
        onApply={apply}
      />
    </div>
  );
}

/**
 * An open provider's definition. On a project it is edited here as in its editor; the studio's own,
 * and one on an adapter the project made, only show.
 */
export function ProviderCode({
  provider,
  issues,
  state,
  isEditable,
}: {
  provider: StudioProvider;
  issues: StudioIssue[];
  state: StudioWorkspaceState;
  isEditable: boolean;
}) {
  const apply = useCallback(
    (text: string): CodeApply => {
      const current = state.workspace.providers.find((each) => each.id === provider.id);
      if (!current) {
        return { errors: [{ message: 'No provider is open.', line: 1, column: 1 }], spans: [] };
      }
      const read = readProviderSource(text, current);
      if (!read.ok) return { errors: read.errors, spans: [] };
      state.update((workspace) => withProvider(workspace, read.provider));
      return { errors: [], spans: read.spans };
    },
    [state, provider.id],
  );
  return (
    <div className="studio-fill">
      <StudioCode
        key={provider.id}
        text={providerSource(provider)}
        hold={false}
        isReadOnly={!isEditable || definitionFactory(provider.definition) === undefined}
        issues={issues}
        onApply={apply}
      />
    </div>
  );
}
