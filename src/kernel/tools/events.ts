/**
 * Tool event shapes and the preamble every executable tool path shares.
 *
 * Function, declarative HTTP, and remote MCP tools all announce themselves,
 * validate their input, and — for the remote kinds — clear their target against
 * the profile's SSRF policy. Keeping that here means the three paths cannot drift,
 * and it holds the event constructors both `execute.ts` and `remote.ts` need
 * without either importing the other.
 *
 * @module
 */

import type { z } from 'zod';
import { throwIfAborted } from '../../guardrails/error.ts';
import { assertSafeUrl } from '../../guardrails/network.ts';
import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import type { NetworkGuardrailSpec } from '../../guardrails/types.ts';
import type { TurnEvent } from '../types.ts';
import type { ToolCallEvent, ToolContext, ToolFailure } from './types.ts';

/** Identifying fields repeated on every event for one tool call. */
export type ToolCallBase = Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>;

export function toolEvent(base: ToolCallBase, patch: Partial<ToolCallEvent>): TurnEvent {
  return {
    type: 'tool',
    tool: { ...base, ...patch },
  };
}

export function failureEvent(base: ToolCallBase, failure: ToolFailure): TurnEvent {
  return toolEvent(base, { phase: 'error', failure });
}

/** Failure text for a thrown value, without leaking a stack. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Announce the call and validate its input.
 *
 * Returns `{ ok: false }` after emitting the failure event, so callers bail
 * without re-deciding what an invalid input means.
 */
export function* startToolExecution<T>(
  tool: { input: z.ZodType<T> },
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
): Generator<TurnEvent, { ok: true; data: T } | { ok: false }> {
  yield toolEvent(base, { phase: 'running' });
  throwIfAborted(ctx.signal);
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    yield failureEvent(base, {
      code: 'invalid_input',
      kind: 'bad_response',
      message: 'Tool input validation failed', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      details: parsed.error.flatten(),
    });
    return { ok: false };
  }
  return { ok: true, data: parsed.data };
}

/**
 * A remote request refused by the network policy — its target or a redirect
 * hop: the guardrail event, and the failure the call settles with.
 */
export function* networkBlocked(err: unknown): Generator<TurnEvent, ToolFailure> {
  yield {
    type: 'guardrail',
    guardrail: {
      stage: 'network',
      trust: 'untrusted',
      action: 'block',
      hits: [{ rule: 'network.blocked', severity: 'high' }],
    },
  };
  return { code: 'network_blocked', kind: 'blocked', message: messageOf(err) };
}

/**
 * Clear a remote target against the profile's network policy, so HTTP and
 * MCP cannot diverge on what SSRF enforcement means. A refused target comes
 * back as the failure to settle with; the settlement emits the terminal event.
 */
export function* guardToolTarget(
  url: string,
  ctx: ToolContext,
): Generator<TurnEvent, { ok: true; url: URL } | { ok: false; failure: ToolFailure }> {
  try {
    return { ok: true, url: assertSafeUrl(url, toolNetworkPolicy(ctx)) };
  } catch (err) {
    return { ok: false, failure: yield* networkBlocked(err) };
  }
}

/** The network policy remote tools and their OAuth refreshes clear. */
export function toolNetworkPolicy(ctx: ToolContext): NetworkGuardrailSpec | undefined {
  return resolveGuardrailPolicy(ctx.profile.guardrails).network;
}
