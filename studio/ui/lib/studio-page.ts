/**
 * What the studio's page sends an agent: a value for each of its slots and its context
 * package. Kept in this tab beside the conversation, never in the profile.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { type SlotDraft, type StudioRunPayload, studioPageTools } from '../../mod.ts';
import { isRecord, session } from './studio-session.ts';

const PAGE_PREFIX = 'theorem.studio.v2.page:';

/** What the builder set: the value picked for each slot, and the context as typed. */
export interface PageValues {
  slots: Record<string, string>;
  contextJson: string;
}

/** What the agent takes from a page. */
export interface PageInputs {
  /** Allowed values per slot name (descriptions stay on the profile / chat UI). */
  slots: Record<string, readonly string[]>;
  takesContext: boolean;
  /** The tools the page answers. Only a call asks the page. */
  pageTools: string[];
}

const NO_PAGE_VALUES: PageValues = { slots: {}, contextJson: '' };

/** The context a blank preview box suggests. */
export const CONTEXT_PLACEHOLDER = `{
  "page": "Checkout"
}`;

function choiceValues(decl: unknown): string[] | undefined {
  if (
    Array.isArray(decl) &&
    decl.length > 0 &&
    decl.every((value) => typeof value === 'string' && value.trim() !== '')
  ) {
    return decl;
  }
  if (!isRecord(decl) || !Array.isArray(decl.choices) || decl.choices.length === 0) {
    return undefined;
  }
  const values: string[] = [];
  for (const choice of decl.choices) {
    if (!isRecord(choice) || typeof choice.value !== 'string' || choice.value.trim() === '') {
      return undefined;
    }
    values.push(choice.value);
  }
  return values;
}

/** The slots a draft has so far that a page can pick from: each named, with a value, once. */
export function draftSlots(
  slots: readonly SlotDraft[],
): { name: string; label: string; values: string[] }[] {
  const seen = new Set<string>();
  return slots.flatMap((slot) => {
    const name = slot.name.trim();
    const values = slot.choices.map((choice) => choice.value.trim()).filter(Boolean);
    if (!name || !values.length || seen.has(name)) return [];
    seen.add(name);
    return [{ name, label: slot.label.trim() || name, values }];
  });
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
  if (profile.type === 'decision' || profile.type === 'host' || profile.type === 'embedding') {
    return null;
  }
  const inputs = 'inputs' in profile ? profile.inputs : undefined;
  const raw = inputs?.slots ?? {};
  const slots = Object.fromEntries(
    Object.entries(raw).flatMap(([name, decl]) => {
      const values = choiceValues(decl);
      return values ? [[name, values] as const] : [];
    }),
  );
  const takesContext = inputs?.context?.from.includes('client') ?? false;
  const pageTools = Object.keys(studioPageTools(payload));
  if (!Object.keys(slots).length && !takesContext && !pageTools.length) return null;
  return { slots, takesContext, pageTools };
}

/** The value a slot sends: the one picked while the profile still lists it, else its first. */
function slotValue(inputs: PageInputs, values: PageValues, name: string): string {
  const allowed = inputs.slots[name] ?? [];
  const picked = allowed.find((value) => value === values.slots[name]);
  return picked ?? allowed.at(0) ?? '';
}

/** What goes with a turn or a call. Context that is not JSON is not sent, and says why. */
export function sentPageValues(
  inputs: PageInputs | null,
  values: PageValues,
): { slots?: Record<string, string>; context?: unknown; contextError?: string } {
  if (!inputs) return {};
  const names = Object.keys(inputs.slots);
  const slots = names.length
    ? Object.fromEntries(names.map((name) => [name, slotValue(inputs, values, name)]))
    : undefined;
  const typed = inputs.takesContext ? values.contextJson.trim() : '';
  if (!typed) return { slots };
  const contextError = contextErrorOf(typed);
  return contextError ? { slots, contextError } : { slots, context: JSON.parse(typed) as unknown };
}

function loadPageValues(agentKey: string): PageValues {
  try {
    const kept: unknown = JSON.parse(session()?.getItem(`${PAGE_PREFIX}${agentKey}`) ?? 'null');
    if (!isRecord(kept) || !isRecord(kept.slots) || typeof kept.contextJson !== 'string') {
      return NO_PAGE_VALUES;
    }
    const slots = Object.fromEntries(
      Object.entries(kept.slots).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    return { slots, contextJson: kept.contextJson };
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
