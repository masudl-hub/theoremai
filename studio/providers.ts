/**
 * The providers a workspace's models are served by, and what each one's
 * adapter takes. A model names its provider; the provider's adapter decides
 * which kinds of agent it serves and what a model on it can do, as it does
 * for the kernel.
 *
 * @module
 */

import { z } from 'zod';
import { canonical } from './canonical.ts';
import { labelText } from '@theoremjs/agents/guardrails';
import {
  defineProvider,
  keySlotSchema,
  type ModelBinding,
  type ProviderAdapter,
  type ProviderCapabilities,
  type RegisteredProvider,
  resolveKeySlot,
} from '@theoremjs/agents/kernel';
import {
  googleAdapter,
  openAIChat,
  openRouterAdapter,
  typesafeAdapter,
} from '@theoremjs/agents/providers';

/** One provider the workspace's models can name. */
export interface StudioProvider {
  /** What a model's `provider` says. */
  id: string;
  /** The id of the adapter it is defined with: `google`, `openrouter`, `openai-chat`, `typesafe`, or a project's own. */
  adapter: string;
  /**
   * What it connects with. Left out for an adapter that is the project's own: what that one
   * connects with stays with the project.
   */
  connection?: Record<string, string>;
  /** The slot its models read their key from, unless a model names its own. */
  keySlot?: string;
  /** The slot they read when the first one's key is refused. */
  fallbackKeySlot?: string;
  /**
   * What its models support, for an adapter that is told (`declaresSupport`): as the project
   * registered it, or as the builder set it. Left out, it is the adapter's defaults, and it is
   * left out whenever it is them (`toldSupport`).
   */
  capabilities?: ProviderCapabilities;
}

/** The provider the studio reaches on the builder's own machine. */
export const LOCAL_PROVIDER_ID = 'local';

/**
 * Whether a model on `provider` runs on the studio's own local provider, which the tab's local
 * connection reaches. A project's providers are its own, whatever their ids.
 */
export function onStudioLocal(provider: string, inProject: boolean): boolean {
  return !inProject && provider === LOCAL_PROVIDER_ID;
}

/** Where the studio's local provider is reached, for a local server at `baseUrl`. */
export function localProviderAddress(baseUrl = 'http://localhost:11434'): string {
  return `${baseUrl.replace(/\/$/, '')}/v1`;
}

/** The providers the studio defines itself, for a workspace no project defines them for. */
export const STUDIO_PROVIDERS: readonly StudioProvider[] = [
  { id: 'google', adapter: 'google' },
  { id: 'openrouter', adapter: 'openrouter' },
  {
    id: LOCAL_PROVIDER_ID,
    adapter: 'openai-chat',
    connection: { baseURL: localProviderAddress() },
  },
  { id: 'typesafe', adapter: 'typesafe' },
];

/** The kinds of agent an adapter can be asked about. */
export type ServedProfileType = ProviderCapabilities['profileTypes'][number];

/** What an adapter says the model `apiId` can do, asked with nothing set on the provider or the model. */
type Asked = (apiId: string) => ProviderCapabilities;

function asked<C, O, K, S>(adapter: ProviderAdapter<C, O, K, S>): Asked {
  return (apiId) => adapter.capabilities({ apiId, connection: {} as C, providerOptions: {} as O });
}

/** A provider's two slots, as its definition takes them. */
function slotsOf(provider: StudioProvider): Pick<StudioProvider, 'keySlot' | 'fallbackKeySlot'> {
  return {
    ...(provider.keySlot === undefined ? {} : { keySlot: provider.keySlot }),
    ...(provider.fallbackKeySlot === undefined ? {} : { fallbackKeySlot: provider.fallbackKeySlot }),
  };
}

/** One kernel adapter as the studio holds it. */
interface HeldAdapter {
  asked: Asked;
  /** The kernel export that makes it. */
  factory: string;
  /** The kernel's own check of what a provider on it connects with. */
  connection: z.ZodType;
  /** The provider as the kernel defines it; throws what the kernel refuses. */
  define: (provider: StudioProvider) => RegisteredProvider;
  /** Whether it is called with what its models support. */
  declares: boolean;
}

function held<C, O, K, S>(
  adapter: ProviderAdapter<C, O, K, S>,
  factory: string,
  declared?: (capabilities: ProviderCapabilities) => ProviderAdapter<C, O, K, S>,
): HeldAdapter {
  return {
    asked: asked(adapter),
    factory,
    connection: adapter.connectionSchema,
    define: (provider) =>
      defineProvider({
        id: provider.id,
        connection: (provider.connection ?? {}) as C,
        adapter: declared && provider.capabilities ? declared(provider.capabilities) : adapter,
        ...slotsOf(provider),
      }) as RegisteredProvider,
    declares: declared !== undefined,
  };
}

// why: an adapter is made once; each answer is its own.
const ADAPTERS: Record<string, HeldAdapter> = {
  google: held(googleAdapter(), 'googleAdapter'),
  openrouter: held(openRouterAdapter(), 'openRouterAdapter'),
  'openai-chat': held(openAIChat(), 'openAIChat', (capabilities) => openAIChat({ capabilities })),
  typesafe: held(typesafeAdapter(), 'typesafeAdapter'),
};

/** Every kind of content a model can take and give, for an adapter that stands in for another. */
export const EVERY_MEDIA_KIND: Pick<ProviderCapabilities, 'inputKinds' | 'outputKinds'> = {
  inputKinds: ['text', 'image', 'audio', 'video', 'document'],
  outputKinds: ['text', 'image', 'audio'],
};

/**
 * An adapter the studio stands in for another with: a project's own, or a script's. It connects
 * with nothing, takes any options and serves every kind of agent, since the studio judges nothing
 * about its models. As it is, it runs nothing.
 */
export function standInAdapter(id: string): ProviderAdapter<Record<string, never>, Record<string, unknown>, string> {
  return {
    apiVersion: 1,
    id,
    connectionSchema: z.strictObject({}),
    optionsSchema: z.record(z.string(), z.json()),
    credentialSchema: z.string(),
    capabilities: () => ({
      profileTypes: ['text', 'image', 'speech', 'live', 'decision'],
      features: {
        streaming: 'unknown',
        clientTools: 'unknown',
        parallelTools: 'unknown',
        structuredOutput: 'unknown',
        thinking: 'unknown',
        summaries: 'unknown',
        storedContinuation: 'unknown',
      },
      ...EVERY_MEDIA_KIND,
      builtins: [],
    }),
    validateRequest() {},
    create: () => Promise.reject(new Error('A stand-in adapter runs nothing.')),
  };
}

/**
 * The provider as the kernel defines it, for a scope that checks the workspace's agents against
 * it. Throws what the kernel refuses. One on a project's own adapter is defined on a stand-in,
 * with its slots and nothing it connects with.
 */
export function providerDefinition(provider: StudioProvider): RegisteredProvider {
  const adapter = ADAPTERS[provider.adapter];
  if (adapter) return adapter.define(provider);
  return defineProvider({
    id: provider.id,
    connection: {},
    adapter: standInAdapter(provider.adapter),
    ...slotsOf(provider),
  }) as RegisteredProvider;
}

/** One setting an adapter's connection takes. */
export interface ConnectionField {
  name: string;
  required: boolean;
  /** The setting is an address. */
  url: boolean;
}

/**
 * What a provider on the adapter connects with, read from the kernel's own check. Undefined for a
 * project's own adapter: what that one connects with stays with the project.
 */
export function connectionFields(adapter: string): ConnectionField[] | undefined {
  const schema = ADAPTERS[adapter]?.connection;
  if (!schema) return undefined;
  const shape = z.toJSONSchema(schema, { io: 'input' }) as {
    properties?: Record<string, { format?: string }>;
    required?: string[];
  };
  return Object.entries(shape.properties ?? {}).map(([name, property]) => ({
    name,
    required: shape.required?.includes(name) ?? false,
    url: property.format === 'uri',
  }));
}

/** One thing the kernel refuses about a provider, at the setting it is about. */
export interface ProviderProblem {
  message: string;
  /** `id`, `keySlot`, `fallbackKeySlot`, or `connection.<name>`. */
  field?: string;
}

/**
 * Everything the kernel refuses about the provider, each at its setting: its id, what it connects
 * with by its adapter's own check, and its two slots.
 */
export function providerProblems(provider: StudioProvider): ProviderProblem[] {
  const problems: ProviderProblem[] = [];
  if (!provider.id.trim()) problems.push({ field: 'id', message: 'Provider id is required.' });
  const connection = provider.connection ?? {};
  const parsed = ADAPTERS[provider.adapter]?.connection.safeParse(connection);
  for (const issue of parsed?.error?.issues ?? []) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        problems.push({ field: `connection.${key}`, message: `This adapter takes no '${key}'.` });
      }
      continue;
    }
    const name = issue.path[0];
    if (typeof name !== 'string') {
      problems.push({ message: issue.message });
      continue;
    }
    const message = name in connection ? issue.message : `${name} is required.`;
    problems.push({ field: `connection.${name}`, message });
  }
  for (const field of ['keySlot', 'fallbackKeySlot'] as const) {
    const slot = provider[field];
    if (slot !== undefined && !keySlotSchema.safeParse(slot).success) {
      problems.push({ field, message: 'A key slot is 1 to 32 letters, digits, hyphens or underscores.' });
    }
  }
  if (provider.keySlot && provider.keySlot === provider.fallbackKeySlot) {
    problems.push({ field: 'fallbackKeySlot', message: labelText('provider.fallback_slot') });
  }
  return problems;
}

/** The ids of the kernel's own adapters: the ones a provider the studio adds can be defined with. */
export function kernelAdapters(): string[] {
  return Object.keys(ADAPTERS);
}

/** The kernel adapter the export `factory` makes. Undefined for any other name. */
export function adapterOfFactory(factory: string): string | undefined {
  return Object.keys(ADAPTERS).find((adapter) => ADAPTERS[adapter]?.factory === factory);
}

/** The kernel export that makes the adapter, for code the studio writes. Undefined for a project's own adapter. */
export function adapterFactory(adapter: string): string | undefined {
  return ADAPTERS[adapter]?.factory;
}

/** The adapter the provider `id` is defined with, among `providers`. */
export function adapterOf(providers: readonly StudioProvider[], id: string): string | undefined {
  return providers.find((provider) => provider.id === id)?.adapter;
}

/**
 * The key slots a model reads, as the kernel resolves them: the ones it names, else the ones its
 * provider among `providers` was defined with. A slot left blank is one not named.
 */
export function modelSlots(
  providers: readonly StudioProvider[],
  binding: { provider: string; keySlot?: string; fallbackKeySlot?: string },
): { keySlot?: string; fallbackKeySlot?: string } {
  const provider = providers.find((held) => held.id === binding.provider) ?? {};
  // invariant: the resolution reads a model's two slots and nothing else of it.
  const named = {
    ...(binding.keySlot ? { keySlot: binding.keySlot } : {}),
    ...(binding.fallbackKeySlot ? { fallbackKeySlot: binding.fallbackKeySlot } : {}),
  } as ModelBinding;
  return resolveKeySlot(provider, named);
}

/**
 * What the adapter says the model `apiId` can do. Undefined for an adapter the studio does not
 * hold, a project's own: the studio then judges nothing about its models.
 */
export function modelCapabilities(adapter: string | undefined, apiId: string): ProviderCapabilities | undefined {
  return adapter === undefined ? undefined : ADAPTERS[adapter]?.asked(apiId.trim());
}

/**
 * Whether a provider on the adapter is told what its models support. The kernel's other adapters
 * know it for each model; a project's own adapter says it in the project's code.
 */
export function declaresSupport(adapter: string): boolean {
  return ADAPTERS[adapter]?.declares ?? false;
}

/** What the provider's models support: what it declares, else its adapter's defaults. */
export function providerSupport(provider: StudioProvider): ProviderCapabilities | undefined {
  return provider.capabilities ?? modelCapabilities(provider.adapter, '');
}

/**
 * What a provider on `adapter` is told its models support, when that is not the adapter's
 * defaults. The defaults are the same as being told nothing, so they are never held.
 */
export function toldSupport(adapter: string, capabilities: ProviderCapabilities | undefined): ProviderCapabilities | undefined {
  if (!capabilities || !declaresSupport(adapter)) return undefined;
  return canonical(capabilities) === canonical(modelCapabilities(adapter, '')) ? undefined : capabilities;
}

/** The features a provider declares, as the editor sets them. */
export type SupportFeatures = Omit<ProviderCapabilities['features'], 'streaming' | 'storedContinuation'>;

/**
 * The provider declaring `features`, over what it declares or its adapter's defaults. Set back to
 * the defaults, it declares nothing.
 */
export function withSupport(provider: StudioProvider, features: Partial<SupportFeatures>): StudioProvider {
  const base = providerSupport(provider);
  if (!base || !declaresSupport(provider.adapter)) return provider;
  const { capabilities: _was, ...rest } = provider;
  const told = toldSupport(provider.adapter, { ...base, features: { ...base.features, ...features } });
  return told ? { ...rest, capabilities: told } : rest;
}

/**
 * Whether the adapter serves agents of `type` with the model `apiId`, or with some model when
 * `apiId` is left out. An adapter the studio does not hold is taken to.
 */
export function servesProfileType(adapter: string | undefined, type: ServedProfileType, apiId = ''): boolean {
  const capabilities = modelCapabilities(adapter, apiId);
  return capabilities === undefined || capabilities.profileTypes.includes(type);
}

/** A model as the studio's rules read it: its provider, that provider's adapter, and whether it decides. */
export interface ModelRoute {
  provider: string;
  adapter: string | undefined;
  apiId: string;
  /** The model is a decision agent's. */
  decision: boolean;
}

/** The route of `binding`, a model of an agent of `type` whose providers are `providers`. */
export function modelRoute(
  providers: readonly StudioProvider[],
  type: string,
  binding: { provider: string; apiId: string },
): ModelRoute {
  return {
    provider: binding.provider,
    adapter: adapterOf(providers, binding.provider),
    apiId: binding.apiId,
    decision: type === 'decision',
  };
}
