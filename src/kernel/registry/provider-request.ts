import { TheoremError } from '../../guardrails/error.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type {
  BuiltinToolId,
  ProviderBuiltin,
  ProviderCompleteRequest,
  ResolvedGeneration,
} from '../types.ts';

function providerBuiltins(tools: ToolRegistry, ids: readonly BuiltinToolId[]): ProviderBuiltin[] {
  return ids.map((id) => {
    const tool = tools.get(id);
    if (tool?.type !== 'builtin') {
      throw new TheoremError('config', `Builtin '${id}' is not registered`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    return { id, wire: tool.wire };
  });
}

/** Shared by execution and tracing. */
function providerCompleteRequest(
  tools: ToolRegistry,
  generation: ResolvedGeneration,
  system: string,
): ProviderCompleteRequest {
  const isInteractions = generation.transport === 'interactions';
  return {
    model: generation.model,
    apiId: generation.apiId,
    previousInteractionId: isInteractions ? generation.previousInteractionId : undefined,
    store: isInteractions ? generation.store : undefined,
    stream: generation.stream,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: providerBuiltins(tools, generation.builtins),
    googleMapsLocation: isInteractions ? generation.googleMapsLocation : undefined,
    cache: generation.cache,
    sessionId: generation.sessionId,
    system,
    input: generation.input,
    history: generation.history,
    continuation: isInteractions ? generation.continuation : undefined,
    wireTools: generation.tools.wire,
    structured: generation.structured,
    image: generation.image,
    speech: generation.speech,
    live: generation.live,
    sessionResumptionHandle: generation.sessionResumptionHandle,
    keySlot: generation.keySlot,
  };
}

export { providerBuiltins, providerCompleteRequest };
