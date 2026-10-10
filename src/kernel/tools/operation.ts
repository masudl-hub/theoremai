import { z } from 'zod';
import { publicError, TheoremError } from '../../guardrails/error.ts';
import { errorKindSchema, guardrailHit, provenance } from '../../guardrails/event-schemas.ts';
import { jsonValueSchema } from '../provider-contract.ts';
import type { GateReference, TurnEventOf } from '../turn-events.ts';
import {
  interactionPartSchema,
  TURN_EVENT_SCHEMAS,
  turnHistoryMessageSchema,
} from '../turn-events.ts';
import type { TurnHistoryMessage } from '../types.ts';
import type { ModelToolResult, ToolFailure } from './types.ts';

export type TerminalToolEvent = TurnEventOf<'tool'> & {
  tool: Extract<TurnEventOf<'tool'>['tool'], { phase: 'complete' | 'error' }>;
};

export interface ToolOperationIdentity extends GateReference {
  profileId: string;
  toolId: string;
  invocationHash: string;
}

export interface ToolOperationClaim extends ToolOperationIdentity {
  claimToken: string;
}

export interface ToolOperationOutcome {
  event: TerminalToolEvent;
  effects: 'not_started' | 'completed' | 'unknown';
  replay: {
    modelResult?: ModelToolResult;
    outputRaw?: unknown;
    failure?: ToolFailure;
    awaiting?: boolean;
    denied?: true;
    callNotStarted?: boolean;
    aborted?: boolean | { reason?: string };
    pendingInject?: { id?: string; messages: TurnHistoryMessage[] }[];
  };
}

export type ToolOperationUncertainty =
  | 'execution_interrupted'
  | 'settlement_write_failed'
  | 'worker_lost';

export type BeginToolOperationResult =
  | { kind: 'acquired'; claimToken: string }
  | { kind: 'settled'; outcome: ToolOperationOutcome }
  | { kind: 'running' }
  | { kind: 'uncertain' };

export interface ToolExecutionCoordinator {
  begin(operation: ToolOperationIdentity): Promise<BeginToolOperationResult>;
  settle(claim: ToolOperationClaim, outcome: ToolOperationOutcome): Promise<void>;
  settleNotStarted(operation: ToolOperationIdentity, outcome: ToolOperationOutcome): Promise<void>;
  markUncertain(claim: ToolOperationClaim, reason: ToolOperationUncertainty): Promise<void>;
}

export function operationUnavailable(): TheoremError {
  const error = new TheoremError('unavailable', '');
  error.message = publicError(error);
  return error;
}

export async function toolInvocationHash(value: unknown): Promise<string> {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return item;
  };
  const data = jsonValueSchema.parse(ordered(operationWireValue(value)));
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const terminalSchema = TURN_EVENT_SCHEMAS.tool.transform((event, ctx) => {
  if (event.tool.phase === 'complete' || event.tool.phase === 'error') {
    return { ...event, tool: event.tool };
  }
  ctx.addIssue({ code: 'custom' });
  return z.NEVER;
});

export const toolOperationOutcomeSchema: z.ZodType<ToolOperationOutcome> = z.strictObject({
  event: terminalSchema,
  effects: z.enum(['not_started', 'completed', 'unknown']),
  replay: z.strictObject({
    modelResult: z
      .strictObject({
        finding: z.string(),
        data: jsonValueSchema.optional(),
        parts: z.array(interactionPartSchema).optional(),
        modelText: z.string().optional(),
        provenance: provenance.optional(),
        suspicious: z.array(guardrailHit).optional(),
      })
      .optional(),
    outputRaw: jsonValueSchema.optional(),
    failure: z
      .strictObject({
        code: z.string(),
        kind: errorKindSchema,
        message: z.string(),
        error: z.string().optional(),
        details: jsonValueSchema.optional(),
      })
      .optional(),
    awaiting: z.boolean().optional(),
    denied: z.literal(true).optional(),
    callNotStarted: z.boolean().optional(),
    aborted: z.union([z.boolean(), z.strictObject({ reason: z.string().optional() })]).optional(),
    pendingInject: z
      .array(
        z.strictObject({ id: z.string().optional(), messages: z.array(turnHistoryMessageSchema) }),
      )
      .optional(),
  }),
});

export function operationWireValue(value: unknown): unknown {
  const ancestors = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    if (ancestors.has(item)) throw operationUnavailable();
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw operationUnavailable();
    }
    if (Object.hasOwn(item, '__proto__')) throw operationUnavailable();
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map(normalize);
      const entries = Object.entries(Object.getOwnPropertyDescriptors(item));
      if (entries.some(([, descriptor]) => descriptor.get || descriptor.set))
        throw operationUnavailable();
      return Object.fromEntries(
        entries
          .filter(([, descriptor]) => descriptor.enumerable && descriptor.value !== undefined)
          .map(([key, descriptor]) => [key, normalize(descriptor.value)]),
      );
    } finally {
      ancestors.delete(item);
    }
  };
  return jsonValueSchema.parse(normalize(value));
}
