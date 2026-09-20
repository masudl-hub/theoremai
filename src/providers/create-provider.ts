/**
 * Host provider factory — the single public door for binding a profile to a transport.
 *
 * Routes from the selected model binding's `protocol` / `provider` (and whether the
 * profile is a speech or image role). Adapters under this folder are internal implementation.
 *
 * Every adapter graph is loaded only when that transport's first `complete` runs —
 * not when this module is imported.
 *
 * @module
 */

import { TheoremError } from '../guardrails/error.ts';
import { requireModelProfile } from '../kernel/registry/resolve.ts';
import { soleModelId } from '../kernel/registry/sole-model.ts';
import { isValidPair } from '../kernel/schema.ts';
import type {
  ModelBinding,
  ModelId,
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

function bindingForProvider(input: Profile, modelId?: ModelId): ModelBinding {
  const profile = requireModelProfile(input, 'createProvider');
  const id = modelId ?? profile.defaultModel ?? soleModelId(profile.models);
  if (!id) {
    throw new TheoremError(
      `createProvider: profile '${profile.id}' must set defaultModel when multiple models are declared`,
    );
  }
  const binding = profile.models[id];
  if (!binding) {
    throw new TheoremError(`createProvider: profile '${profile.id}' has no model '${id}'`);
  }
  return binding;
}

/**
 * Lazy-load an adapter on first `complete`. When `THEOREM_IMPORT_PROBE=1`,
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
 * Create a `ModelProvider` for a turn-based profile (text / image / speech).
 * Live profiles use `runSession` — `createProvider` rejects geminiLive.
 *
 * When a profile declares multiple models, pass `modelId` to pick the binding used
 * for adapter selection (defaults to `defaultModel` or the sole model key).
 */
export function createProvider(
  profile: Profile,
  options: CreateProviderOptions = {},
  modelId?: ModelId,
): ModelProvider {
  const { protocol, provider } = bindingForProvider(profile, modelId);

  if (!isValidPair(protocol, provider)) {
    throw new TheoremError(
      `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
    );
  }

  if (protocol === 'geminiInteractions' && provider === 'google') {
    if (!options.gemini) {
      throw new TheoremError('createProvider requires gemini transport for google Interactions');
    }
    return lazyGoogleInteractions(options.gemini);
  }

  if (protocol === 'geminiLive' && provider === 'google') {
    throw new TheoremError(
      "createProvider does not support type 'live' / geminiLive — use runSession(req, { gemini })",
    );
  }

  if (protocol === 'openAi' && provider === 'openrouter') {
    if (!options.openAiGateway) {
      throw new TheoremError('createProvider requires openAiGateway config for openAi/openrouter');
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
      throw new TheoremError(
        'createProvider: type image requires openrouter provider for openAi protocol',
      );
    }
    return lazyLocal(options.local);
  }

  throw new TheoremError(
    `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
  );
}
