/**
 * Host provider factory — the single public door for binding a profile to a transport.
 *
 * Routes from `profile.model.protocol` / `provider` (and whether the profile is
 * a speech or image role). Adapters under this folder are internal implementation.
 *
 * Every adapter graph is loaded only when that transport's first `complete` runs —
 * not when this module is imported.
 *
 * @module
 */

import { TheorumError } from '../guardrails/error.ts';
import { isValidPair } from '../kernel/schema.ts';
import type {
  ModelProvider,
  Profile,
  ProviderCompleteRequest,
  TurnEvent,
} from '../kernel/types.ts';
import type { GeminiTransport } from './google/keys.ts';
import { markModuleLoad } from './probe.ts';
import type { LocalProviderConfig, OpenAiGatewayConfig } from './types.ts';

/** Credentials supplied by the host when creating a provider. */
export interface CreateProviderOptions {
  /** Google Interactions (text, image, and speech when protocol is geminiInteractions). */
  gemini?: GeminiTransport;
  /**
   * OpenAI-gateway credentials for `openAi` profiles (OpenRouter or compatible).
   * Used for chat completions, `/images`, or `/audio/speech` depending on output role.
   * Optional `voice` is a fallback when `speech.voice` is omitted.
   */
  openAiGateway?: OpenAiGatewayConfig & { voice?: string };
  /** Local OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM Studio). */
  local?: LocalProviderConfig;
}

export function isSpeechRole(profile: Profile): boolean {
  return profile.type === 'speech';
}

export function isImageRole(profile: Profile): boolean {
  return profile.type === 'image';
}

/**
 * Lazy-load an adapter on first `complete`. When `THEORUM_IMPORT_PROBE=1`,
 * emits `LOADED:<label>` exactly once at load time (import-isolation tests).
 */
function lazyAdapter(label: string, load: () => Promise<ModelProvider>): ModelProvider {
  let pending: Promise<ModelProvider> | undefined;
  return {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
      pending ??= (async () => {
        markModuleLoad(label);
        return await load();
      })();
      yield* (await pending).complete(req);
    },
  };
}

function lazyOpenRouterChat(config: OpenAiGatewayConfig): ModelProvider {
  return lazyAdapter('openrouter-chat', () =>
    import('./openrouter/chat.ts').then((m) => m.createOpenRouterProvider(config)),
  );
}

function lazyGoogleInteractions(config: GeminiTransport): ModelProvider {
  return lazyAdapter('google-interactions-adapter', () =>
    import('./google/interactions/mod.ts').then((m) => m.createInteractionsProvider(config)),
  );
}

function lazyGoogleLive(config: GeminiTransport): ModelProvider {
  return lazyAdapter('google-live-stream', () =>
    import('./google/live/mod.ts').then((m) => m.createGoogleLiveProvider(config)),
  );
}

function lazySpeech(config: OpenAiGatewayConfig & { voice?: string }): ModelProvider {
  return lazyAdapter('openrouter-speech', () =>
    import('./openrouter/speech.ts').then((m) => m.createSpeechProvider(config)),
  );
}

function lazyImage(config: OpenAiGatewayConfig): ModelProvider {
  return lazyAdapter('openrouter-image', () =>
    import('./openrouter/image.ts').then((m) => m.createImageProvider(config)),
  );
}

function lazyLocal(config?: LocalProviderConfig): ModelProvider {
  return lazyAdapter('local-adapter', () =>
    import('./local/local.ts').then((m) => m.createLocalProvider(config)),
  );
}

/**
 * Create a `ModelProvider` for a profile.
 * One call: protocol/provider (and speech role) pick the transport.
 */
export function createProvider(
  profile: Profile,
  options: CreateProviderOptions = {},
): ModelProvider {
  const { protocol, provider } = profile.model;

  if (!isValidPair(protocol, provider)) {
    throw new TheorumError(
      `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
    );
  }

  if (protocol === 'geminiInteractions' && provider === 'google') {
    if (!options.gemini) {
      throw new TheorumError('createProvider requires gemini transport for google Interactions');
    }
    return lazyGoogleInteractions(options.gemini);
  }

  if (protocol === 'geminiLive' && provider === 'google') {
    if (!options.gemini) {
      throw new TheorumError('createProvider requires gemini transport for google Gemini Live');
    }
    return lazyGoogleLive(options.gemini);
  }

  if (protocol === 'openAi' && provider === 'openrouter') {
    if (!options.openAiGateway) {
      throw new TheorumError('createProvider requires openAiGateway config for openAi/openrouter');
    }
    if (isSpeechRole(profile)) {
      return lazySpeech(options.openAiGateway);
    }
    if (isImageRole(profile)) {
      return lazyImage(options.openAiGateway);
    }
    return lazyOpenRouterChat(options.openAiGateway);
  }

  if (protocol === 'openAi' && provider === 'local') {
    if (isImageRole(profile)) {
      throw new TheorumError(
        'createProvider: type image requires openrouter provider for openAi protocol',
      );
    }
    return lazyLocal(options.local);
  }

  // Exhaustiveness guard: isValidPair above already rejects unknown pairs, so
  // this throw is unreachable at runtime. It exists so TypeScript errors if a
  // new protocol/provider is added to PROTOCOL_PROVIDERS without a branch here.
  throw new TheorumError(
    `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
  );
}
