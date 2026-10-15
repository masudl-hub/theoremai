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
  type DeclarableFeature,
  type DeclaredSupport,
  defineProvider,
  keySlotSchema,
  type ModelSupport,
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
   * What its models take, for an adapter that is told (`declaresSupport`): its models', and each
   * named model's own, as the project registered it or as the builder set it. Left out, it is the
   * adapter's defaults, and it holds nothing that is them (`toldSupport`).
   */
  support?: DeclaredSupport;
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
  /** For an adapter called with what its models take: the features it can be told, and it made again told `support`. */
  told?: { features: readonly DeclarableFeature[]; make: (support: DeclaredSupport) => ProviderAdapter };
}

function held<C, O, K, S>(
  adapter: ProviderAdapter<C, O, K, S>,
  factory: string,
  make?: (support: DeclaredSupport) => ProviderAdapter<C, O, K, S>,
): HeldAdapter {
  const told = make && adapter.declared
    ? { features: adapter.declared.features, make: (support: DeclaredSupport) => make(support) as unknown as ProviderAdapter }
    : undefined;
  return {
    asked: asked(adapter),
    factory,
    connection: adapter.connectionSchema,
    define: (provider) =>
      defineProvider({
        id: provider.id,
        connection: (provider.connection ?? {}) as C,
        adapter: make && provider.support ? make(provider.support) : adapter,
        ...slotsOf(provider),
      }) as RegisteredProvider,
    ...(told ? { told } : {}),
  };
}

// why: an adapter is made once; each answer is its own.
const ADAPTERS: Record<string, HeldAdapter> = {
  google: held(googleAdapter(), 'googleAdapter'),
  openrouter: held(openRouterAdapter(), 'openRouterAdapter'),
  'openai-chat': held(openAIChat(), 'openAIChat', openAIChat),
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
 * Whether a provider on the adapter is told what its models take. The kernel's other adapters
 * know it for each model; a project's own adapter says it in the project's code.
 */
export function declaresSupport(adapter: string): boolean {
  return ADAPTERS[adapter]?.told !== undefined;
}

/** What an adapter's one argument holds when it is told what its models take, and nothing else. */
export const SUPPORT_KEYS: ReadonlySet<string> = new Set(['capabilities', 'models'] satisfies (keyof DeclaredSupport)[]);

/** The features a provider on the adapter can be told its models take, as the kernel lists them. */
export function declarableFeatures(adapter: string): readonly DeclarableFeature[] {
  return ADAPTERS[adapter]?.told?.features ?? [];
}

/**
 * What the provider's models take, or the model `apiId`'s when it is named: as its adapter answers
 * told what the provider holds.
 */
export function providerSupport(provider: StudioProvider, apiId = ''): ProviderCapabilities | undefined {
  const told = ADAPTERS[provider.adapter]?.told;
  if (!told || !provider.support) return modelCapabilities(provider.adapter, apiId);
  return told.make(provider.support).capabilities({ apiId: apiId.trim(), connection: {}, providerOptions: {} });
}

/**
 * The model `apiId`'s own rows on `provider`: what it is told apart from the provider's other
 * models, and what those take. None for an adapter that is not told, or for a model that is told
 * nothing where the builder cannot change it: rows of the provider's would say more than it does.
 */
export function modelSupport(
  provider: StudioProvider,
  apiId: string,
  editable: boolean,
): { base: ProviderCapabilities; told: ModelSupport } | undefined {
  const base = providerSupport(provider);
  const told = provider.support?.models?.[apiId.trim()] ?? {};
  if (!base || !apiId.trim() || !declaresSupport(provider.adapter)) return undefined;
  return editable || Object.keys(told).length ? { base, told } : undefined;
}

/**
 * What a provider on `adapter` is told its models take, holding nothing that is the adapter's
 * defaults: capabilities that are them, and a model told nothing, are the same as left out.
 */
export function toldSupport(adapter: string, support: DeclaredSupport | undefined): DeclaredSupport | undefined {
  if (!support || !declaresSupport(adapter)) return undefined;
  const { capabilities } = support;
  const models = Object.entries(support.models ?? {}).flatMap(([apiId, model]) => {
    const said = Object.entries(model).filter(([, value]) => value !== undefined);
    return said.length ? [[apiId, Object.fromEntries(said) as ModelSupport] as const] : [];
  });
  const told: DeclaredSupport = {
    ...(capabilities && canonical(capabilities) !== canonical(modelCapabilities(adapter, '')) ? { capabilities } : {}),
    ...(models.length ? { models: Object.fromEntries(models) } : {}),
  };
  return Object.keys(told).length ? told : undefined;
}

/**
 * The provider told `features` of its models, or of the model `apiId` when it is named. A model's
 * feature set to undefined takes the provider's again; set back to the defaults, it is told nothing.
 */
export function withSupport(provider: StudioProvider, features: ModelSupport, apiId?: string): StudioProvider {
  if (!declaresSupport(provider.adapter)) return provider;
  const { support: was = {}, ...rest } = provider;
  let next: DeclaredSupport;
  if (apiId === undefined) {
    const base = was.capabilities ?? modelCapabilities(provider.adapter, '');
    if (!base) return provider;
    next = { ...was, capabilities: { ...base, features: { ...base.features, ...features } } };
  } else {
    next = { ...was, models: { ...was.models, [apiId]: { ...was.models?.[apiId], ...features } } };
  }
  const support = toldSupport(provider.adapter, next);
  return support ? { ...rest, support } : rest;
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
