import { type KeyVault, TheoremError, z } from '../mod.ts';
import type { PlaygroundBrowserRuntime } from './browser-transport.ts';

/** Browser-only host configuration. Never part of a compiled profile or persisted run payload. */
export interface PlaygroundBrowserConnection {
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

export function localPlaygroundConfig(
  local: PlaygroundBrowserConnection['local'],
): NonNullable<PlaygroundBrowserRuntime['providers']>['local'] {
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

export const PLAYGROUND_KEY_SLOT_CAP = 32;

const localModelList = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

/** The same localhost origin and transport used for inference; never a site proxy. */
export async function listLocalPlaygroundModels(local: PlaygroundBrowserConnection['local'], signal?: AbortSignal): Promise<string[]> {
  const config = localPlaygroundConfig(local);
  if (!config?.fetch) throw new TheoremError('config', 'Enter a local endpoint.'); // lexicon-exempt: builder diagnostic
  const response = await config.fetch(`${config.baseUrl}/v1/models`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new TheoremError('network', `Local model list returned HTTP ${response.status}.`); // lexicon-exempt: builder diagnostic
  const parsed = localModelList.safeParse(await response.json());
  if (!parsed.success) throw new TheoremError('request', 'The endpoint returned an invalid model list.'); // lexicon-exempt: builder diagnostic
  return [...new Set(parsed.data.data.map((model) => model.id))];
}

/** Slot references come from the compiled contract, including each model's overrides. */
export function playgroundKeySlots(profile: {
  type?: string;
  key?: string;
  fallbackKey?: string;
  models?: Record<string, { key?: string; fallbackKey?: string }>;
}): string[] {
  return [
    ...new Set(
      [
        profile.key,
        profile.fallbackKey,
        ...Object.values(profile.models ?? {}).flatMap((model) => [model.key, model.fallbackKey]),
      ].filter((slot): slot is string => Boolean(slot)),
    ),
  ];
}

/** Defines even empty referenced slots, so names such as `constructor` never read inherited values. */
export function playgroundVault(slots: readonly string[], vault: KeyVault): KeyVault {
  return Object.fromEntries(
    slots.map((slot) => [slot, Object.hasOwn(vault, slot) ? vault[slot] : undefined]),
  );
}
