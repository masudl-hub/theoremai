import type { ProviderCompleteRequest, ResolvedGeneration } from '../types.ts';

/** Build the provider request projection shared by execution and tracing. */
function providerCompleteRequest(
  generation: ResolvedGeneration,
  system: string,
): ProviderCompleteRequest {
  const isInteractions = generation.transport === 'interactions';
  return {
    model: generation.model,
    apiId: generation.apiId,
    previousInteractionId: isInteractions ? generation.previousInteractionId : undefined,
    store: isInteractions ? generation.store : undefined,
    stream: isInteractions ? generation.stream : undefined,
    thinking: generation.thinking,
    summaries: isInteractions ? generation.summaries : undefined,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    googleMapsLocation: isInteractions ? generation.googleMapsLocation : undefined,
    system,
    input: generation.input,
    history: generation.history,
    interactionOnlyInput: isInteractions ? generation.interactionOnlyInput : undefined,
    wireTools: generation.tools.wire,
    structured: generation.structured,
    image: generation.image,
    speech: generation.speech,
    live: generation.live,
    sessionResumptionHandle: generation.sessionResumptionHandle,
    keySlot: generation.keySlot,
  };
}

export { providerCompleteRequest };
