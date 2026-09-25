import type { ProviderCompleteRequest, ThinkingLevel } from '../../src/kernel/types.ts';

export type StubOverrides = Partial<ProviderCompleteRequest> & {
  model?: string;
  apiId?: string;
  thinking?: ThinkingLevel;
};

/** Minimal typed `ProviderCompleteRequest` for adapter unit tests (no casts). */
export function stubCompleteRequest(overrides: StubOverrides = {}): ProviderCompleteRequest {
  return {
    model: overrides.model ?? 'test-model',
    apiId: overrides.apiId ?? 'test-api-id',
    thinking: overrides.thinking ?? 'none',
    summaries: overrides.summaries,
    maxOutputTokens: overrides.maxOutputTokens ?? 256,
    temperature: overrides.temperature ?? 0.2,
    builtins: overrides.builtins ?? [],
    system: overrides.system ?? 'Be brief.',
    input: overrides.input ?? [{ type: 'text', text: 'Hello' }],
    history: overrides.history,
    continuation: overrides.continuation,
    wireTools: overrides.wireTools,
    structured: overrides.structured ?? null,
    image: overrides.image ?? null,
    speech: overrides.speech,
    live: overrides.live,
    sessionResumptionHandle: overrides.sessionResumptionHandle,
    keySlot: overrides.keySlot,
    tapUpstream: overrides.tapUpstream,
    signal: overrides.signal,
    previousInteractionId: overrides.previousInteractionId,
    store: overrides.store,
    stream: overrides.stream,
  };
}
