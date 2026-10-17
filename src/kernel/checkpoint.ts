import { z } from 'zod';
import { type JsonValue, jsonValueSchema } from './json.ts';
import type { TurnHistoryMessage } from './turn-events.ts';

/**
 * A protocol's saved continuation, and what it was saved for. It is used only when the next call
 * goes to the same protocol, provider registration, connection, model, key slot and keyed options.
 */
export interface ProviderCheckpoint {
  protocol: string;
  provider: string;
  /** The protocol's `continuation.version` the data was written under. */
  version: number;
  apiId: string;
  /** The slot whose key the saved state belongs to. */
  keySlot?: string;
  /** Hash of the provider's connection and the options the protocol keys its state on. */
  compatibilityKey: string;
  coveredHistoryLength: number;
  coveredHistoryHash: string;
  data: JsonValue;
  /** The wire's own id for each Theorem call id the saved state holds, sent back in its place. */
  wireCallIds?: Record<string, string>;
}
export const providerCheckpointSchema: z.ZodType<ProviderCheckpoint> = z.strictObject({
  protocol: z.string().min(1),
  provider: z.string().min(1),
  version: z.number().int().positive(),
  apiId: z.string().min(1),
  keySlot: z.string().min(1).optional(),
  compatibilityKey: z.string(),
  coveredHistoryLength: z.number().int().nonnegative(),
  coveredHistoryHash: z.string(),
  data: jsonValueSchema,
  wireCallIds: z.record(z.string().min(1), z.string().min(1)).optional(),
});

/** Why a saved continuation was dropped and the conversation sent from the transcript. */
export type ProviderStateRebuilt =
  | 'provider_changed'
  | 'model_changed'
  | 'connection_changed'
  | 'key_changed'
  | 'history_changed'
  | 'version_changed';
export interface ProviderWarning {
  code: 'provider_state_rebuilt';
  reason: ProviderStateRebuilt;
}
export const providerWarningSchema: z.ZodType<ProviderWarning> = z.strictObject({
  code: z.literal('provider_state_rebuilt'),
  reason: z.enum([
    'provider_changed',
    'model_changed',
    'connection_changed',
    'key_changed',
    'history_changed',
    'version_changed',
  ]),
});

export interface ProviderContinuationPolicy {
  /**
   * Who holds the conversation a checkpoint continues. `'host'` (unset) passes the covered
   * history back with the checkpoint. `'provider'` passes the checkpoint alone: the provider's
   * stored conversation is the history, and a turn that goes elsewhere needs the host's history.
   * `'stateless'` keeps no conversation: a request that carries history or a checkpoint is refused,
   * and completion carries no checkpoint.
   */
  history?: 'host' | 'stateless' | 'provider';
}
export const providerContinuationSchema: z.ZodType<ProviderContinuationPolicy> = z.strictObject({
  history: z.enum(['host', 'stateless', 'provider']).optional(),
});

export async function historyHash(history: readonly TurnHistoryMessage[]): Promise<string> {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      const ordered: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort())
        ordered[key] = stable((value as Record<string, unknown>)[key]);
      return ordered;
    }
    return value;
  };
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(
        stable(
          history.map((message) => {
            const canonicalText = (text: string) =>
              message.role === 'user'
                ? (text.match(/^<user_data>\n([\s\S]*)\n<\/user_data>$/)?.[1] ?? text)
                : text;
            const parts = [
              ...(message.content === undefined
                ? []
                : [{ type: 'text', text: canonicalText(message.content) }]),
              ...(message.parts ?? []).map((part) =>
                part.type === 'text' ? { ...part, text: canonicalText(part.text) } : part,
              ),
            ];
            const { content: _content, parts: _parts, ...rest } = message;
            return { ...rest, ...(parts.length ? { parts } : {}) };
          }),
        ),
      ),
    ),
  );
  let hex = '';
  for (const byte of new Uint8Array(hash)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
