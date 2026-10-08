import { type KeyVault, TheoremError, z } from '../mod.ts';
import { GEMINI_MODELS_URL } from '../src/providers/google/urls.ts';
import type { StudioBrowserRuntime } from './browser-transport.ts';

/** Browser-only host configuration. Never part of a compiled profile or persisted run payload. */
export interface StudioBrowserConnection {
  /** One vault for every provider; each model reads the slot it names. */
  vault: KeyVault;
  /** A local model that needs a token names a slot, like any other model. */
  local: { baseUrl: string };
  remoteTools: boolean;
}

/** Which service a pasted key belongs to, from its published prefix; `undefined` when unknown. */
export function keyKind(secret: string | undefined): 'google' | 'openrouter' | undefined {
  const key = secret?.trim() ?? '';
  if (key.startsWith('AIza')) return 'google';
  if (key.startsWith('sk-or-')) return 'openrouter';
  return undefined;
}

export function localStudioConfig(
  local: StudioBrowserConnection['local'],
): NonNullable<StudioBrowserRuntime['providers']>['local'] {
  let url: URL;
  try {
    url = new URL(local.baseUrl);
  } catch {
    throw new TheoremError('config', 'Enter a valid localhost URL.');
  } // lexicon-exempt: builder diagnostic
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TheoremError(
      'config',
      'Use a localhost URL without credentials, query parameters or a fragment.',
    ); // lexicon-exempt: builder diagnostic
  }
  return {
    baseUrl: url.href.replace(/\/$/, ''),
    // A token, when the model names a slot, comes from the vault through the adapter.
    fetch: (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== url.origin) {
        return Promise.reject(
          new TheoremError('blocked', 'Local requests must stay on the configured origin.'),
        ); // lexicon-exempt: builder diagnostic
      }
      return fetch(input, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
      });
    },
  };
}

export const STUDIO_KEY_SLOT_CAP = 32;

const localModelList = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

/** The same localhost origin and transport used for inference; never a site proxy. */
export async function listLocalStudioModels(local: StudioBrowserConnection['local'], signal?: AbortSignal): Promise<string[]> {
  const config = localStudioConfig(local);
  if (!config?.fetch) throw new TheoremError('config', 'Enter a local endpoint.'); // lexicon-exempt: builder diagnostic
  const response = await config.fetch(`${config.baseUrl}/v1/models`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new TheoremError('network', `Local model list returned HTTP ${response.status}.`); // lexicon-exempt: builder diagnostic
  const parsed = localModelList.safeParse(await response.json());
  if (!parsed.success) throw new TheoremError('request', 'The endpoint returned an invalid model list.'); // lexicon-exempt: builder diagnostic
  return [...new Set(parsed.data.data.map((model) => model.id))];
}

/** The profile types a model runs for; a provider's list is filtered to the one being edited. */
export type ListedProfileType = 'text' | 'image' | 'speech' | 'live';

/** A model a provider lists, as the studio's picker shows it. */
export interface ProviderModel {
  /** What the profile's `apiId` is set to. */
  id: string;
  label: string;
}

/** The providers whose models the studio can list from the browser. */
export type ListedProvider = 'google' | 'openrouter';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/**
 * OpenRouter's `output_modalities` for each profile type: chat models for text, `/images` models
 * for image, `/audio/speech` models for speech. OpenRouter has no live models.
 */
const OPENROUTER_OUTPUT: Record<ListedProfileType, string | undefined> = {
  text: 'text',
  image: 'image',
  speech: 'speech',
  live: undefined,
};

const openRouterModelList = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      architecture: z.object({ output_modalities: z.array(z.string()).optional() }).optional(),
    }),
  ),
});

const geminiModelList = z.object({
  models: z
    .array(
      z.object({
        name: z.string().min(1),
        displayName: z.string().optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

/** Enough pages for every model a Gemini project lists; a runaway token stops here. */
const GEMINI_MODEL_PAGES = 5;

async function listedJson(provider: string, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', credentials: 'omit' });
  // Gemini answers a key it doesn't know with 400; the list's own query never earns one.
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new TheoremError('auth', `${provider} refused the key.`); // lexicon-exempt: builder diagnostic
  }
  if (!response.ok) {
    throw new TheoremError('network', `${provider} model list returned HTTP ${response.status}.`); // lexicon-exempt: builder diagnostic
  }
  return await response.json();
}

/**
 * The models a provider offers for a profile type, fetched from the browser with the key in this
 * tab, never through the site. OpenRouter lists without a key and says what each model returns, so
 * its list keeps only models of the profile's kind. Gemini needs the key and says only which calls
 * a model takes, so its list keeps the models that answer a turn (live models for live).
 */
export async function listProviderModels(
  provider: ListedProvider,
  profileType: ListedProfileType,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<ProviderModel[]> {
  const secret = key?.trim();
  if (provider === 'openrouter') {
    const output = OPENROUTER_OUTPUT[profileType];
    if (!output) return [];
    const parsed = openRouterModelList.safeParse(
      await listedJson('OpenRouter', `${OPENROUTER_MODELS_URL}?output_modalities=${output}`, {
        signal,
        headers: {
          Accept: 'application/json',
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
      }),
    );
    if (!parsed.success) throw new TheoremError('bad_response', 'OpenRouter returned an invalid model list.'); // lexicon-exempt: builder diagnostic
    return parsed.data.data
      .filter((model) => model.architecture?.output_modalities?.includes(output) ?? true)
      .map((model) => ({ id: model.id, label: model.name ?? model.id }));
  }
  if (!secret) throw new TheoremError('auth', 'Choose a key to list Gemini models.'); // lexicon-exempt: builder diagnostic
  const method = profileType === 'live' ? 'bidiGenerateContent' : 'generateContent';
  const models: ProviderModel[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < GEMINI_MODEL_PAGES; page++) {
    const url = new URL(GEMINI_MODELS_URL);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const parsed = geminiModelList.safeParse(
      await listedJson('Google', url.href, {
        signal,
        headers: { Accept: 'application/json', 'x-goog-api-key': secret },
      }),
    );
    if (!parsed.success) throw new TheoremError('bad_response', 'Google returned an invalid model list.'); // lexicon-exempt: builder diagnostic
    for (const model of parsed.data.models ?? []) {
      if (!model.supportedGenerationMethods?.includes(method)) continue;
      const id = model.name.replace(/^models\//, '');
      models.push({ id, label: model.displayName ?? id });
    }
    pageToken = parsed.data.nextPageToken;
    if (!pageToken) break;
  }
  return models;
}

/** Slot references come from the compiled contract, including each model's overrides. */
export function studioKeySlots(profile: {
  type?: string;
  key?: string;
  fallbackKey?: string;
  models?: Record<string, { keySlot?: string; fallbackKeySlot?: string }>;
}): string[] {
  return [
    ...new Set(
      [
        profile.key,
        profile.fallbackKey,
        ...Object.values(profile.models ?? {}).flatMap((model) => [model.keySlot, model.fallbackKeySlot]),
      ].filter((slot): slot is string => Boolean(slot)),
    ),
  ];
}

/** Defines even empty referenced slots, so names such as `constructor` never read inherited values. */
export function studioVault(slots: readonly string[], vault: KeyVault): KeyVault {
  return Object.fromEntries(
    slots.map((slot) => [slot, Object.hasOwn(vault, slot) ? vault[slot] : undefined]),
  );
}
