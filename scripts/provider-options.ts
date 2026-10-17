import {
  geminiProvider,
  getProfile,
  getProvider,
  localProvider,
  openRouterProvider,
  type Profile,
  type ProviderHostOptions,
  registerProfile,
  registerProvider,
  type TurnModel,
} from '../mod.ts';
import { scriptedFetch, scriptedProvider } from '../tests/fixtures/scripted.ts';

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
/** Registers the providers the scripts' profiles bind to, once. */
export function registerScriptProviders(options: ScriptConnections = {}): void {
  if (getProvider('gemini')) return;
  registerProvider(geminiProvider, { keySlot: 'slot_a' });
  registerProvider(openRouterProvider, {
    keySlot: 'openrouter',
    connection: Object.fromEntries(
      Object.entries({
        baseUrl: options.openAiGateway?.baseUrl,
        siteUrl: options.openAiGateway?.siteUrl,
        siteName: options.openAiGateway?.siteName,
      }).filter(([, value]) => value !== undefined),
    ),
  });
  registerProvider(localProvider, {
    connection: {
      baseUrl: `${(options.local?.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`,
    },
  });
  registerProvider(scriptedProvider, { keySlot: 'scripted' });
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

/** A scripted `TurnModel` answers `profileId`'s calls; real host options pass through. */
export function scriptTurnOptions(
  profileId: string,
  provider: ProviderHostOptions | TurnModel,
): ProviderHostOptions {
  if (!('complete' in provider)) return provider;
  const profile = getProfile(profileId);
  if (profile.type === 'host') throw new Error('Script model fixture requires a model profile');
  registerProfile({
    ...profile,
    models: Object.fromEntries(
      Object.entries(profile.models).map(([name, binding]) => {
        const { keySlot: _slot, fallbackKeySlot: _fallback, ...settings } = binding;
        return [name, { ...settings, protocol: 'scripted', provider: 'scripted', options: {} }];
      }),
    ),
  } as Profile);
  const slot = getProvider('scripted')?.keySlot ?? 'scripted';
  return { fetch: scriptedFetch(provider), vault: { [slot]: 'scripted' } };
}
registerScriptProviders();
