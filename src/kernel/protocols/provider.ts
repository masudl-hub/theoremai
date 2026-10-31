import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import { jsonValueSchema } from '../json.ts';
import type { KeySlot } from '../types.ts';
import {
  type DecisionModelBinding,
  decisionModelBindingSchema,
  keySlotSchema,
  type ModelBinding,
  modelBindingSchema,
} from './binding.ts';
import type { PriceTable } from './prices.ts';
import { modelOptions, type Protocol } from './protocol.ts';

/** One outgoing call or socket, for a sign-in to put its key on. `body` is final, for signing. */
export interface Outgoing {
  transport: 'http' | 'ws';
  url: URL;
  headers: Headers;
  /** WebSocket subprotocols, where some APIs sign in. */
  protocols: string[];
  readonly body?: string;
}

/** Signs outgoing calls for one key. `invalidate` drops a minted token after an `auth` refusal. */
export interface Signer {
  sign(outgoing: Outgoing): void | Promise<void>;
  invalidate?(): void;
}

/**
 * How a key is put on a request. Made once per registration and key, so a minted token is reused
 * until it expires. `webSocketHeaders` says it needs headers on a WebSocket, which a browser can't send.
 */
export interface Authorize<K = unknown> {
  (key: K): Signer;
  readonly webSocketHeaders?: boolean;
}

function authorizer<K>(
  sign: (key: K, outgoing: Outgoing) => void,
  webSocketHeaders: boolean,
): Authorize<K> {
  return Object.assign((key: K): Signer => ({ sign: (outgoing) => sign(key, outgoing) }), {
    webSocketHeaders,
  });
}

/** A service's address in a connection: HTTP(S), with no credentials in it. Keys go in the vault. */
export const endpointUrlSchema: z.ZodString = z
  .string()
  .url()
  .refine((value) => {
    // why: what is not a URL is refused by the check above, in its own words.
    if (!URL.canParse(value)) return true;
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ![...url.searchParams.keys()].some((key) => /key|auth|secret|token|password/i.test(key))
    );
  }, labelText('protocol.endpoint_url'));

/** `Authorization: Bearer <key>`. */
export function bearer(): Authorize<string> {
  return authorizer(
    (key, outgoing) => outgoing.headers.set('Authorization', `Bearer ${key}`),
    true,
  );
}

/** The key in a header of its own, e.g. `x-goog-api-key`, or `api-key` for Azure. */
export function header(name: string): Authorize<string> {
  return authorizer((key, outgoing) => outgoing.headers.set(name, key), true);
}

/** The key in the URL's query, e.g. `key` for Gemini Live's WebSocket. */
export function query(name: string): Authorize<string> {
  return authorizer((key, outgoing) => outgoing.url.searchParams.set(name, key), false);
}

/** One protocol a provider serves, and where. `K` is the provider's key. */
export interface Serve<K = unknown> {
  protocol: Protocol;
  baseUrl: string;
  /** Places the URL when the protocol's path isn't enough, e.g. the model in the path. */
  url?(at: { path: string; apiId: string; stream: boolean }): string;
  /** In place of the provider's sign-in, for this protocol only. */
  authorize?: Authorize<K>;
  headers?: Readonly<Record<string, string>>;
}

/** A provider: where a service is and how to sign in to it. Data plus one sign-in function. */
export interface ProviderDefinition<C = unknown, K = unknown> {
  /** The default id; a registration may rename it. */
  id: string;
  name: string;
  description: string;
  /** OpenTelemetry `gen_ai.provider.name`; else the id. */
  traceName?: string;
  /** What a builder sets when registering it, each field described. */
  connection?: z.ZodType<C>;
  /** Absent: no key. Optional: a key may be given. An object for e.g. a service account. */
  key?: z.ZodType<K | undefined>;
  authorize?: Authorize<K>;
  /** Only where the API reports no cost. */
  prices?: PriceTable;
  serves(connection: C): Serve<K>[];
  /**
   * How to ask the provider whether it takes a key: a GET to `path` on where it serves `protocol`,
   * signed as a call is. It must answer 2xx for a key that works and 400, 401 or 403 for one
   * that does not. `checkKey` sends it.
   */
  check?: { protocol: Protocol; path: string };
}

/** A provider as defined; register it to use it. */
export type Provider<C = unknown, K = unknown> = Readonly<ProviderDefinition<C, K>>;

const providerShape = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  traceName: z.string().min(1).optional(),
});

/** Defines a provider. Nothing in it can change a request or read a reply. */
export function defineProvider<C = undefined, K = undefined>(
  definition: ProviderDefinition<C, K>,
): Provider<C, K> {
  const parsed = providerShape.safeParse(definition);
  if (!parsed.success || typeof definition.serves !== 'function')
    throw new TheoremError(
      'config',
      labelText('protocol.definition', {
        id: String(definition.id),
        // labels-exempt: builder diagnostic
        issues: parsed.success ? 'serves is required' : z.prettifyError(parsed.error),
      }),
    );
  return Object.freeze({ ...definition });
}

/** What a builder sets when registering a provider. */
export interface Registration<C> {
  /** In place of the provider's id, e.g. two `local` servers. */
  id?: string;
  connection?: C;
  keySlot?: KeySlot;
  fallbackKeySlot?: KeySlot;
}

export type ModelSettings<O> = Omit<ModelBinding, 'protocol' | 'provider' | 'apiId' | 'options'> & {
  options?: O;
};
export type DecisionModelSettings<O> = Omit<
  DecisionModelBinding,
  'protocol' | 'provider' | 'apiId' | 'options'
> & {
  options?: O;
};

/** A provider registered in a scope, with its connection and slots. */
export interface RegisteredProvider {
  readonly id: string;
  readonly definition: Provider;
  readonly connection: unknown;
  readonly keySlot?: KeySlot;
  readonly fallbackKeySlot?: KeySlot;
  readonly serves: readonly Serve[];
  /** A binding for this provider, its options checked against the protocol's schema. */
  model<O>(
    protocol: Protocol<O> | string,
    apiId: string,
    settings?: ModelSettings<O>,
  ): ModelBinding;
  decisionModel<O>(
    protocol: Protocol<O> | string,
    apiId: string,
    settings?: DecisionModelSettings<O>,
  ): DecisionModelBinding;
}

export interface ProviderRegistry {
  /** Refuses an id already registered. */
  register<C, K>(provider: Provider<C, K>, registration?: Registration<C>): RegisteredProvider;
  /** Registers in place of the provider with the same id, for a tool that edits a project. */
  replace<C, K>(provider: Provider<C, K>, registration?: Registration<C>): RegisteredProvider;
  get(id: string): RegisteredProvider | undefined;
  require(id: string, apiId: string): RegisteredProvider;
  list(): RegisteredProvider[];
  /** Every protocol the registered providers serve, with the protocols they extend. */
  protocols(): Protocol[];
}

/** Where a provider serves a protocol; a config error when it does not. */
export function served(
  provider: { id: string; serves: readonly Serve[] },
  protocol: string,
): Serve {
  const serve = provider.serves.find((entry) => entry.protocol.id === protocol);
  if (!serve)
    throw new TheoremError(
      'config',
      labelText('protocol.not_served', { provider: provider.id, protocol }),
    );
  return serve;
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, RegisteredProvider>();
  const protocols = new Map<string, Protocol>();

  const claim = (protocol: Protocol): Protocol[] => {
    const lineage: Protocol[] = [];
    for (let at: Protocol | undefined = protocol; at; at = at.base) {
      const held = protocols.get(at.id);
      if (held && held !== at)
        throw new TheoremError('config', labelText('protocol.id_clash', { protocol: at.id }));
      lineage.push(at);
    }
    return lineage;
  };

  const add = <C, K>(
    provider: Provider<C, K>,
    registration: Registration<C>,
    replacing: boolean,
  ): RegisteredProvider => {
    const id = registration.id ?? provider.id;
    if (!replacing && providers.has(id))
      throw new TheoremError('config', labelText('protocol.provider_id_clash', { provider: id }));
    const parsed = provider.connection
      ? provider.connection.safeParse(registration.connection)
      : { success: true as const, data: undefined };
    if (!parsed.success)
      throw new TheoremError(
        'config',
        labelText('protocol.connection', { provider: id, issues: z.prettifyError(parsed.error) }),
      );
    if (parsed.data !== undefined) jsonValueSchema.parse(parsed.data);
    if (registration.keySlot !== undefined) keySlotSchema.parse(registration.keySlot);
    if (registration.fallbackKeySlot !== undefined)
      keySlotSchema.parse(registration.fallbackKeySlot);
    if (registration.keySlot && registration.keySlot === registration.fallbackKeySlot)
      throw new TheoremError('config', labelText('provider.fallback_slot'));
    if ((registration.keySlot || registration.fallbackKeySlot) && !provider.key)
      throw new TheoremError('config', labelText('protocol.no_key', { provider: id }));
    const serves = Object.freeze(
      provider.serves(parsed.data as never).map((serve) => Object.freeze({ ...serve }) as Serve),
    );
    const claimed = serves.flatMap((serve) => claim(serve.protocol));
    const optionsOf = (protocol: Protocol | string, apiId: string, options: unknown) => {
      const { protocol: spoken } = served(
        { id, serves },
        typeof protocol === 'string' ? protocol : protocol.id,
      );
      return { protocol: spoken.id, options: modelOptions(spoken, apiId, options) };
    };
    const registered: RegisteredProvider = Object.freeze({
      id,
      definition: provider as Provider,
      connection: parsed.data,
      ...(registration.keySlot ? { keySlot: registration.keySlot } : {}),
      ...(registration.fallbackKeySlot ? { fallbackKeySlot: registration.fallbackKeySlot } : {}),
      serves,
      model(protocol, apiId, settings = {}) {
        const { options, ...rest } = settings;
        return modelBindingSchema.parse({
          ...rest,
          provider: id,
          apiId,
          ...optionsOf(protocol, apiId, options),
        });
      },
      decisionModel(protocol, apiId, settings = {}) {
        const { options, ...rest } = settings;
        return decisionModelBindingSchema.parse({
          ...rest,
          provider: id,
          apiId,
          ...optionsOf(protocol, apiId, options),
        });
      },
    });
    for (const protocol of claimed) protocols.set(protocol.id, protocol);
    providers.set(id, registered);
    return registered;
  };

  return {
    register: (provider, registration = {}) => add(provider, registration, false),
    replace: (provider, registration = {}) => add(provider, registration, true),
    get: (id) => providers.get(id),
    require(id, apiId) {
      const provider = providers.get(id);
      if (!provider)
        throw new TheoremError(
          'config',
          labelText('protocol.provider_missing', { provider: id, apiId }),
        );
      return provider;
    },
    list: () => [...providers.values()],
    protocols: () => [...protocols.values()],
  };
}
