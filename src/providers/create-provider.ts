import { TheoremError } from '../guardrails/error.ts';
import { requireModelProfile } from '../kernel/registry/resolve.ts';
import { isValidPair } from '../kernel/schema.ts';
import type {
  ModelBinding,
  ModelId,
  ModelProvider,
  Profile,
  ProviderCompleteRequest,
  ProviderEvent,
} from '../kernel/types.ts';
import type { GeminiTransport } from './google/keys.ts';
import { markModuleLoad } from './probe.ts';
import type { LocalProviderConfig, OpenAiGatewayConfig } from './types.ts';

export interface CreateProviderOptions {
  gemini?: GeminiTransport;
  /** `voice` is the fallback when a speech profile omits `speech.voice`. */
  openAiGateway?: OpenAiGatewayConfig & { voice?: string };
  /** Required for `local` profiles. */
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
  const id = modelId ?? profile.defaultModel;
  const binding = profile.models[id];
  if (!binding) {
    throw new TheoremError(
      'config',
      `createProvider: profile '${profile.id}' has no model '${id}'`,
    );
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
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<ProviderEvent> {
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

function lazyLocal(config: LocalProviderConfig): ModelProvider {
  return lazyAdapter('local-adapter', () =>
    import('./local/local.ts').then((m) => m.createLocalProvider(config)),
  );
}

/** Live profiles use `runSession`. `modelId` picks the binding; default `defaultModel`. */
export function createProvider(
  profile: Profile,
  options: CreateProviderOptions = {},
  modelId?: ModelId,
): ModelProvider {
  const { protocol, provider } = bindingForProvider(profile, modelId);

  if (!isValidPair(protocol, provider)) {
    throw new TheoremError(
      'config',
      `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
    );
  }

  if (protocol === 'geminiInteractions' && provider === 'google') {
    if (!options.gemini) {
      throw new TheoremError(
        'config',
        'createProvider requires gemini transport for google Interactions',
      );
    }
    return lazyGoogleInteractions(options.gemini);
  }

  if (protocol === 'geminiLive' && provider === 'google') {
    throw new TheoremError(
      'request',
      "createProvider does not support type 'live' / geminiLive — use runSession(req, { gemini })",
    );
  }

  if (protocol === 'openAi' && provider === 'openrouter') {
    if (!options.openAiGateway) {
      throw new TheoremError(
        'config',
        'createProvider requires openAiGateway config for openAi/openrouter',
      );
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
        'config',
        'createProvider: type image requires openrouter provider for openAi protocol',
      );
    }
    // A profile can name `local`; only the host can say a local server is there to reach.
    if (!options.local) {
      throw new TheoremError(
        'config',
        'createProvider requires local config for openAi/local', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return lazyLocal(options.local);
  }

  throw new TheoremError(
    'config',
    `createProvider: unsupported protocol/provider pair '${protocol}'/'${provider}'`,
  );
}
