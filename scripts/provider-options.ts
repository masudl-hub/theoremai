import {
  defineProvider,
  getProfile,
  googleAdapter,
  type ModelProvider,
  openAIChat,
  openRouterAdapter,
  type Profile,
  type ProviderHostOptions,
  registerProfile,
  registerProvider,
  typesafeAdapter,
  z,
} from '../mod.ts';

interface ScriptConnections extends ProviderHostOptions {
  gemini?: {
    fetch?: typeof fetch;
    wait?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  };
  openAiGateway?: {
    baseUrl?: string;
    siteUrl?: string;
    siteName?: string;
    fetch?: typeof fetch;
    wait?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  };
  local?: { baseUrl: string; fetch?: typeof fetch };
}
export function registerScriptProviders(options: ScriptConnections = {}): void {
  registerProvider(
    defineProvider({ id: 'google', keySlot: 'slot_a', connection: {}, adapter: googleAdapter() }),
  );
  registerProvider(
    defineProvider({
      id: 'openrouter',
      keySlot: 'openrouter',
      connection: Object.fromEntries(
        Object.entries({
          baseURL: options.openAiGateway?.baseUrl,
          siteUrl: options.openAiGateway?.siteUrl,
          siteName: options.openAiGateway?.siteName,
        }).filter(([, value]) => value !== undefined),
      ),
      adapter: openRouterAdapter(),
    }),
  );
  registerProvider(
    defineProvider({
      id: 'local',
      connection: {
        baseURL: `${(options.local?.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`,
      },
      adapter: openAIChat(),
    }),
  );
  registerProvider(defineProvider({ id: 'typesafe', connection: {}, adapter: typesafeAdapter() }));
}
export function scriptProviderOptions(
  profile: Profile,
  options: ScriptConnections = {},
): ProviderHostOptions {
  registerScriptProviders(options);
  if (profile.type !== 'host') {
    registerProfile(profile);
  }
  return {
    vault: options.vault,
    fetch:
      options.fetch ??
      options.gemini?.fetch ??
      options.openAiGateway?.fetch ??
      options.local?.fetch,
    wait: options.wait ?? options.gemini?.wait ?? options.openAiGateway?.wait,
  };
}

export function scriptTurnOptions(
  profileId: string,
  provider: ProviderHostOptions | ModelProvider,
): ProviderHostOptions {
  if (!('complete' in provider)) return provider;
  const profile = getProfile(profileId);
  if (profile.type === 'host') throw new Error('Script model fixture requires a model profile');
  const id = `script:${profileId}`;
  registerProvider(
    defineProvider({
      id,
      connection: {},
      adapter: {
        apiVersion: 1,
        id: 'script-fixture',
        connectionSchema: z.strictObject({}),
        optionsSchema: z.record(z.string(), z.json()),
        credentialSchema: z.string(),
        capabilities: () => ({
          profileTypes: ['text', 'image', 'speech'],
          features: {
            streaming: 'supported',
            clientTools: 'supported',
            parallelTools: 'supported',
            structuredOutput: 'supported',
            thinking: 'supported',
            summaries: 'supported',
            storedContinuation: 'unsupported',
          },
          inputKinds: ['text', 'image', 'audio', 'video', 'document'],
          outputKinds: ['text', 'image', 'audio'],
          builtins: [],
        }),
        validateRequest() {},
        create(): Promise<import('../mod.ts').ProviderOperations> {
          return Promise.resolve({
            async *complete(request) {
              let terminal = false;
              let calls = false;
              for await (const event of provider.complete(request)) {
                if (event.type === 'tool' && event.tool.phase === undefined) {
                  calls = true;
                  yield { type: 'tool_call', call: event.tool };
                } else if (event.type === 'done') {
                  terminal = true;
                  yield event;
                } else if (
                  event.type === 'text' ||
                  event.type === 'tokens' ||
                  event.type === 'thought'
                )
                  yield event;
              }
              if (!terminal) yield { type: 'done', stop: { kind: calls ? 'tool' : 'completed' } };
            },
          });
        },
      },
    }),
  );
  registerProfile({
    ...profile,
    models: Object.fromEntries(
      Object.entries(profile.models).map(([name, binding]) => [name, { ...binding, provider: id }]),
    ),
  } as Profile);
  return {};
}
registerScriptProviders();
