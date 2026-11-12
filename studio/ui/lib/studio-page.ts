/**
 * What the studio's page sends an agent: a value for each of its options and its context
 * package. Kept in this tab beside the conversation, never in the profile.
 */

import type { ProfileOptions } from '@theoremjs/agents';
import type { StatedTurn } from '@theoremjs/web/client';
import { useCallback, useSyncExternalStore } from 'react';
import { type StudioRunPayload, studioPageTools } from '../../mod.ts';
import { isRecord, session } from './studio-session.ts';

const PAGE_PREFIX = 'theorem.studio.v2.page:';

/** What the builder set: the value picked for each option, and the context as typed. */
export interface PageValues {
  options: Record<string, string>;
  contextJson: string;
}

/** What the agent takes from a page. */
export interface PageInputs {
  /** The options a person picks, by name, with their values. */
  person: Record<string, readonly string[]>;
  /** The options the host's code states, by name, with their values. */
  code: Record<string, readonly string[]>;
  takesContext: boolean;
  /** The tools the page answers. Only a call asks the page. */
  pageTools: string[];
}

const NO_PAGE_VALUES: PageValues = { options: {}, contextJson: '' };

/** The context a blank preview box suggests. */
export const CONTEXT_PLACEHOLDER = `{
  "page": "Checkout"
}`;

/** Each option's values, by name. */
function namedValues(options: ProfileOptions | undefined): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(options ?? {}).map(([name, decl]) => [
      name,
      decl.choices.map(({ value }) => value),
    ]),
  );
}

/** Why typed context is not sent, when it is not JSON. */
export function contextErrorOf(contextJson: string): string | undefined {
  const typed = contextJson.trim();
  if (!typed) return undefined;
  try {
    JSON.parse(typed);
    return undefined;
  } catch {
    return 'Context must be JSON.';
  }
}

/** What the compiled agent takes from a page, or null when it takes nothing. */
export function pageInputsOf(payload: StudioRunPayload): PageInputs | null {
  const { profile } = payload;
  if (
    profile.type === 'decision' ||
    profile.type === 'host' ||
    profile.type === 'embedding' ||
    profile.type === 'speech' ||
    profile.type === 'transcription'
  ) {
    return null;
  }
  const inputs = 'inputs' in profile ? profile.inputs : undefined;
  const person = namedValues(inputs?.options);
  const code = namedValues(profile.identity.options);
  const takesContext = inputs?.context?.from.includes('client') ?? false;
  const pageTools = Object.keys(studioPageTools(payload));
  const takesNothing = !Object.keys(person).length && !Object.keys(code).length && !takesContext;
  if (takesNothing && !pageTools.length) return null;
  return { person, code, takesContext, pageTools };
}

/**
 * The value an option states. One the code states goes unset until picked, as code may leave it;
 * one a person picks holds its first value until picked, as the chat's own picker does.
 */
export function pickedValue(
  allowed: readonly string[],
  picked: string | undefined,
  isPersonsPick: boolean,
): string | undefined {
  const value = allowed.find((each) => each === picked);
  return value ?? (isPersonsPick ? allowed.at(0) : undefined);
}

/** Each option's value; one left unset is not sent. */
function picksOf(
  declared: Record<string, readonly string[]>,
  values: PageValues,
  isPersonsPick: boolean,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(declared).flatMap(([name, allowed]) => {
      const value = pickedValue(allowed, values.options[name], isPersonsPick);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

/** The turn's path and options as picked: the `path` option is the turn's own path. */
function statedTurn(inputs: PageInputs, values: PageValues): StatedTurn | undefined {
  if (!Object.keys(inputs.code).length) return undefined;
  const { path, ...options } = picksOf(inputs.code, values, false);
  return { ...(path === undefined ? {} : { path }), options };
}

/** What goes with a turn or a call. Context that is not JSON is not sent, and says why. */
export function sentPageValues(
  inputs: PageInputs | null,
  values: PageValues,
): {
  options?: Record<string, string>;
  stated?: StatedTurn;
  context?: unknown;
  contextError?: string;
} {
  if (!inputs) return {};
  const options = Object.keys(inputs.person).length
    ? picksOf(inputs.person, values, true)
    : undefined;
  const stated = statedTurn(inputs, values);
  const sent = { options, ...(stated ? { stated } : {}) };
  const typed = inputs.takesContext ? values.contextJson.trim() : '';
  if (!typed) return sent;
  const contextError = contextErrorOf(typed);
  return contextError
    ? { ...sent, contextError }
    : { ...sent, context: JSON.parse(typed) as unknown };
}

function loadPageValues(agentKey: string): PageValues {
  try {
    const kept: unknown = JSON.parse(session()?.getItem(`${PAGE_PREFIX}${agentKey}`) ?? 'null');
    if (!isRecord(kept) || !isRecord(kept.options) || typeof kept.contextJson !== 'string') {
      return NO_PAGE_VALUES;
    }
    const options = Object.fromEntries(
      Object.entries(kept.options).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    return { options, contextJson: kept.contextJson };
  } catch {
    return NO_PAGE_VALUES;
  }
}

function savePageValues(agentKey: string, values: PageValues): void {
  session()?.setItem(`${PAGE_PREFIX}${agentKey}`, JSON.stringify(values));
}

/** Each agent's values as last read or set, so the editor and the preview show the same ones. */
const held = new Map<string, PageValues>();
const listeners = new Set<() => void>();

function heldValues(agentKey: string): PageValues {
  let values = held.get(agentKey);
  if (!values) {
    values = loadPageValues(agentKey);
    held.set(agentKey, values);
  }
  return values;
}

function listen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the studio's page sends `agentKey`, kept in this tab; the editor sets it and the preview sends it. */
export function usePageValues(agentKey: string): [PageValues, (next: PageValues) => void] {
  const values = useSyncExternalStore(
    listen,
    () => heldValues(agentKey),
    () => NO_PAGE_VALUES,
  );
  const set = useCallback(
    (next: PageValues) => {
      held.set(agentKey, next);
      savePageValues(agentKey, next);
      for (const listener of listeners) listener();
    },
    [agentKey],
  );
  return [values, set];
}
