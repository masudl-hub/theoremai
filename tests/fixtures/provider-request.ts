import { getStructured } from '../../src/kernel/default-scope.ts';
import type {
  BuiltinToolId,
  ModelRequest,
  ProviderBuiltin,
  ResolvedStructured,
  ThinkingLevel,
} from '../../src/kernel/types.ts';
import { GOOGLE_BUILTIN_TOOLS } from '../../studio/cookbooks/providers.ts';

export type StubOverrides = Partial<ModelRequest> & {
  model?: string;
  apiId?: string;
  thinking?: ThinkingLevel;
};

/** Minimal typed `ModelRequest` for protocol unit tests (no casts). */
export function stubCompleteRequest(overrides: StubOverrides = {}): ModelRequest {
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
    wireTools: overrides.wireTools,
    structured: overrides.structured ?? null,
    image: overrides.image ?? null,
    speech: overrides.speech,
    live: overrides.live,
    tapUpstream: overrides.tapUpstream,
    signal: overrides.signal,
    stream: overrides.stream,
  };
}

/** The Google preset's builtins `ids`, as a provider request carries them. */
export function googleBuiltins(...ids: BuiltinToolId[]): ProviderBuiltin[] {
  return ids.map((id) => {
    const tool = GOOGLE_BUILTIN_TOOLS.find((t) => t.name === id);
    if (!tool) throw new Error(`No Google builtin '${id}'`);
    return { id };
  });
}

/** The default scope's schema `id`, as a provider request carries it. */
export function resolvedStructured(id: string): ResolvedStructured {
  return { id, jsonSchema: getStructured(id).jsonSchema };
}
