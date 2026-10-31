import { type KeyVault, TheoremError, z } from '@theoremjs/agents';
import type { StudioBrowserRuntime } from './browser-transport.ts';
import { GEMINI_MODELS_URL } from './cookbooks/providers.ts';

/** Browser-only host configuration. Never part of a compiled profile or persisted run payload. */
export interface StudioBrowserConnection {
  /** One vault for every provider; each model reads the slot it names. */
  vault: KeyVault;
  /** A local model that needs a token names a slot, like any other model. */
  local: { baseUrl: string };
  remoteTools: boolean;
}

/** Which service a pasted key belongs to, from its published prefix; `undefined` when unknown. */
export function keyKind(secret: string | undefined): 'gemini' | 'openrouter' | undefined {
  const key = secret?.trim() ?? '';
  if (key.startsWith('AIza')) return 'gemini';
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
  } // labels-exempt: builder diagnostic
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
    ); // labels-exempt: builder diagnostic
  }
  return {
    baseUrl: url.href.replace(/\/$/, ''),
    // A token, when the model names a slot, comes from the vault through the adapter.
    fetch: (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== url.origin) {
        return Promise.reject(
          new TheoremError('blocked', 'Local requests must stay on the configured origin.'),
        ); // labels-exempt: builder diagnostic
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
export async function listLocalStudioModels(
  local: StudioBrowserConnection['local'],
  signal?: AbortSignal,
): Promise<string[]> {
  const config = localStudioConfig(local);
  if (!config?.fetch) throw new TheoremError('config', 'Enter a local endpoint.'); // labels-exempt: builder diagnostic
  const response = await config.fetch(`${config.baseUrl}/v1/models`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok)
    throw new TheoremError('network', `Local model list returned HTTP ${response.status}.`); // labels-exempt: builder diagnostic
  const parsed = localModelList.safeParse(await response.json());
  if (!parsed.success)
    throw new TheoremError('request', 'The endpoint returned an invalid model list.'); // labels-exempt: builder diagnostic
  return [...new Set(parsed.data.data.map((model) => model.id))];
}

/** The profile types a model runs for; a provider's list is filtered to the one being edited. */
export type ListedProfileType =
  | 'text'
  | 'image'
  | 'speech'
  | 'transcription'
  | 'live'
  | 'embedding';

/** A model a provider lists, as the studio's picker shows it. */
export interface ProviderModel {
  /** What the profile's `apiId` is set to. */
  id: string;
  label: string;
}

/** The providers whose models the studio can list from the browser. */
export type ListedProvider = 'gemini' | 'openrouter';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_EMBEDDING_MODELS_URL = 'https://openrouter.ai/api/v1/embeddings/models';

export const KNOWN_GEMINI_EMBEDDING_MODELS: readonly ProviderModel[] = [
  { id: 'gemini-embedding-2-preview', label: 'Gemini Embeddings 2 (preview)' },
  { id: 'gemini-embedding-001', label: 'Gemini Embedding 001' },
];
export const KNOWN_OPENROUTER_EMBEDDING_MODELS: readonly ProviderModel[] = [
  { id: 'liquid/lfm-2.5-embedding-350m:free', label: 'Liquid LFM 2.5 Embedding 350M (free)' },
  { id: 'nvidia/nemotron-3-embed-1b:free', label: 'NVIDIA Nemotron 3 Embed 1B (free)' },
  {
    id: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    label: 'NVIDIA Llama Nemotron Embed VL 1B v2 (free)',
  },
];

/**
 * OpenRouter's `output_modalities` for each profile type: chat models for text, `/images` models
 * for image, `/audio/speech` models for speech, `/audio/transcriptions` models for transcription.
 * OpenRouter has no live models.
 */
const OPENROUTER_OUTPUT: Record<ListedProfileType, string | undefined> = {
  text: 'text',
  image: 'image',
  speech: 'speech',
  transcription: 'transcription',
  live: undefined,
  embedding: undefined,
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
const openRouterEmbeddingModelList = z.object({
  data: z.array(z.object({ id: z.string().min(1), name: z.string().optional() })),
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
    throw new TheoremError('auth', `${provider} refused the key.`); // labels-exempt: builder diagnostic
  }
  if (!response.ok) {
    throw new TheoremError('network', `${provider} model list returned HTTP ${response.status}.`); // labels-exempt: builder diagnostic
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
  if (profileType === 'embedding' && !secret) {
    return [
      ...(provider === 'openrouter'
        ? KNOWN_OPENROUTER_EMBEDDING_MODELS
        : KNOWN_GEMINI_EMBEDDING_MODELS),
    ];
  }
  if (provider === 'openrouter') return await listOpenRouterModels(profileType, secret, signal);
  if (!secret) throw new TheoremError('auth', 'Choose a key to list Gemini models.'); // labels-exempt: builder diagnostic
  return await listGeminiModels(profileType, secret, signal);
}

/** OpenRouter's models of the profile's kind; the key is optional. */
async function listOpenRouterModels(
  profileType: ListedProfileType,
  secret: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ProviderModel[]> {
  const init = {
    signal,
    headers: {
      Accept: 'application/json',
      ...(secret ? { Authorization: ['Bearer', secret].join(' ') } : {}),
    },
  };
  if (profileType === 'embedding') {
    const parsed = openRouterEmbeddingModelList.safeParse(
      await listedJson('OpenRouter', OPENROUTER_EMBEDDING_MODELS_URL, init),
    );
    if (!parsed.success)
      throw new TheoremError(
        'bad_response',
        'OpenRouter returned an invalid embedding model list.',
      ); // labels-exempt: builder diagnostic
    return parsed.data.data.map((model) => ({ id: model.id, label: model.name ?? model.id }));
  }
  const output = OPENROUTER_OUTPUT[profileType];
  if (!output) return [];
  const parsed = openRouterModelList.safeParse(
    await listedJson('OpenRouter', `${OPENROUTER_MODELS_URL}?output_modalities=${output}`, init),
  );
  if (!parsed.success)
    throw new TheoremError('bad_response', 'OpenRouter returned an invalid model list.'); // labels-exempt: builder diagnostic
  return parsed.data.data
    .filter((model) => model.architecture?.output_modalities?.includes(output) ?? true)
    .map((model) => ({ id: model.id, label: model.name ?? model.id }));
}

/** The Gemini method a profile type's models must take. */
const GEMINI_METHOD: Partial<Record<ListedProfileType, string>> = {
  live: 'bidiGenerateContent',
  embedding: 'embedContent',
};

/** The key's Gemini models that take the profile type's method, page by page. */
async function listGeminiModels(
  profileType: ListedProfileType,
  secret: string,
  signal: AbortSignal | undefined,
): Promise<ProviderModel[]> {
  const method = GEMINI_METHOD[profileType] ?? 'generateContent';
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
    if (!parsed.success)
      throw new TheoremError('bad_response', 'Google returned an invalid model list.'); // labels-exempt: builder diagnostic
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
        ...Object.values(profile.models ?? {}).flatMap((model) => [
          model.keySlot,
          model.fallbackKeySlot,
        ]),
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
