/**
 * The providers a workspace's models are served by. A model names a protocol and a provider; the
 * provider's definition says where it is, how it signs in, and which protocols it serves, as it
 * does for the kernel.
 *
 * @module
 */

import { labelText } from '@theoremjs/agents/guardrails';
import {
  createProviderRegistry,
  type JsonObject,
  type JsonValue,
  keySlotSchema,
  keySlotsOf,
  type ModelProfileType,
  type Protocol,
  type Provider,
  type ProviderRegistry,
  type RegisteredProvider,
} from '@theoremjs/agents/kernel';
import {
  geminiProvider,
  localProvider,
  openRouterProvider,
  typesafeProvider,
} from '@theoremjs/agents/providers';
import { z } from 'zod';

/** One provider the workspace's models can name. */
export interface StudioProvider {
  /** What a model's `provider` says. */
  id: string;
  /** The id of the definition it is registered from: `gemini`, `openrouter`, `local`, `typesafe`, or a project's own. */
  definition: string;
  /**
   * What it connects with. Left out for a definition that is the project's own: what that one
   * connects with stays with the project.
   */
  connection?: Record<string, string>;
  /** The slot its models read their key from, unless a model names its own. */
  keySlot?: string;
  /** The slot they read when the first one's key is refused. */
  fallbackKeySlot?: string;
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

/** The providers the studio registers itself, for a workspace no project registers them for. */
export const STUDIO_PROVIDERS: readonly StudioProvider[] = [
  { id: 'gemini', definition: 'gemini' },
  { id: 'openrouter', definition: 'openrouter' },
  {
    id: LOCAL_PROVIDER_ID,
    definition: 'local',
    connection: { baseUrl: localProviderAddress() },
  },
  { id: 'typesafe', definition: 'typesafe' },
];

/** The kernel's own definitions, by id, each with the export that names it in code. */
const DEFINITIONS: Record<string, { provider: Provider; factory: string }> = {
  gemini: { provider: geminiProvider as Provider, factory: 'geminiProvider' },
  openrouter: { provider: openRouterProvider as Provider, factory: 'openRouterProvider' },
  local: { provider: localProvider as Provider, factory: 'localProvider' },
  typesafe: { provider: typesafeProvider as Provider, factory: 'typesafeProvider' },
};

/** The kernel's definition `id`. Undefined for a project's own. */
export function kernelDefinition(id: string | undefined): Provider | undefined {
  return id === undefined ? undefined : DEFINITIONS[id]?.provider;
}

/** The ids of the kernel's own definitions: the ones a provider the studio adds can be registered from. */
export function kernelDefinitions(): string[] {
  return Object.keys(DEFINITIONS);
}

/** The kernel definition the export `factory` names. Undefined for any other name. */
export function definitionOfFactory(factory: string): string | undefined {
  return Object.keys(DEFINITIONS).find((id) => DEFINITIONS[id]?.factory === factory);
}

/** The kernel export that names the definition, for code the studio writes. Undefined for a project's own. */
export function definitionFactory(definition: string): string | undefined {
  return DEFINITIONS[definition]?.factory;
}

/** The definition the provider `id` is registered from, among `providers`. */
export function definitionOf(providers: readonly StudioProvider[], id: string): string | undefined {
  return providers.find((provider) => provider.id === id)?.definition;
}

/** What `provider` registers with: its id, connection, and slots. */
function registrationOf(provider: StudioProvider) {
  return {
    id: provider.id,
    ...(provider.connection === undefined ? {} : { connection: provider.connection }),
    ...(provider.keySlot === undefined ? {} : { keySlot: provider.keySlot }),
    ...(provider.fallbackKeySlot === undefined
      ? {}
      : { fallbackKeySlot: provider.fallbackKeySlot }),
  };
}

/**
 * Registers `provider` in `registry` from `definition`, else from the kernel's definition it
 * names. Throws what the kernel refuses, and for a project's own definition when none is given.
 */
export function registerStudioProvider(
  registry: ProviderRegistry,
  provider: StudioProvider,
  definition: Provider | undefined = kernelDefinition(provider.definition),
  how: 'register' | 'replace' = 'register',
): RegisteredProvider {
  if (!definition) {
    throw new Error(`The studio does not hold the provider definition '${provider.definition}'.`); // labels-exempt: developer contract error
  }
  return registry[how](definition, registrationOf(provider));
}

/** One setting a definition's connection takes. */
export interface ConnectionField {
  name: string;
  required: boolean;
  /** The setting is an address. */
  url: boolean;
  /** What the definition says the setting is. */
  description?: string;
}

/**
 * What a provider from the definition connects with, read from the kernel's own schema. Undefined
 * for a project's own definition: what that one connects with stays with the project.
 */
export function connectionFields(definition: string): ConnectionField[] | undefined {
  const provider = kernelDefinition(definition);
  if (!provider) return undefined;
  if (!provider.connection) return [];
  const shape = z.toJSONSchema(provider.connection, { io: 'input' }) as {
    properties?: Record<string, { format?: string; description?: string }>;
    required?: string[];
  };
  return Object.entries(shape.properties ?? {}).map(([name, property]) => ({
    name,
    required: shape.required?.includes(name) ?? false,
    url: property.format === 'uri',
    ...(property.description ? { description: property.description } : {}),
  }));
}

/** Whether a provider from the definition takes a key. A project's own is taken to. */
export function takesKey(definition: string): boolean {
  const provider = kernelDefinition(definition);
  return provider === undefined || provider.key !== undefined;
}

/** One thing the kernel refuses about a provider, at the setting it is about. */
export interface ProviderProblem {
  message: string;
  /** `id`, `keySlot`, `fallbackKeySlot`, or `connection.<name>`. */
  field?: string;
}

/**
 * Everything the kernel refuses about the provider, each at its setting: its id, what it connects
 * with by its definition's own schema, and its two slots.
 */
export function providerProblems(provider: StudioProvider): ProviderProblem[] {
  const problems: ProviderProblem[] = [];
  if (!provider.id.trim()) problems.push({ field: 'id', message: 'Provider id is required.' });
  const definition = kernelDefinition(provider.definition);
  const connection = provider.connection ?? {};
  const parsed = definition?.connection?.safeParse(connection);
  for (const issue of parsed?.error?.issues ?? []) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        problems.push({ field: `connection.${key}`, message: `This provider takes no '${key}'.` });
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
      problems.push({
        field,
        message: 'A key slot is 1 to 32 letters, digits, hyphens, or underscores.',
      });
    }
  }
  if (provider.keySlot && provider.keySlot === provider.fallbackKeySlot) {
    problems.push({ field: 'fallbackKeySlot', message: labelText('provider.fallback_slot') });
  }
  if ((provider.keySlot || provider.fallbackKeySlot) && definition && !definition.key) {
    problems.push({
      field: 'keySlot',
      message: labelText('protocol.no_key', { provider: provider.id }),
    });
  }
  return problems;
}

/**
 * The key slots a model reads, as the kernel resolves them: the ones it names, else the ones its
 * provider among `providers` was registered with. A slot left blank is one not named.
 */
export function modelSlots(
  providers: readonly StudioProvider[],
  binding: { provider: string; keySlot?: string; fallbackKeySlot?: string },
): { keySlot?: string; fallbackKeySlot?: string } {
  const provider = providers.find((held) => held.id === binding.provider) ?? {};
  return keySlotsOf(provider, {
    ...(binding.keySlot ? { keySlot: binding.keySlot } : {}),
    ...(binding.fallbackKeySlot ? { fallbackKeySlot: binding.fallbackKeySlot } : {}),
  });
}

/**
 * The protocols `provider` serves, with an endpoint for agents of `type` when it is named.
 * Undefined for a project's own definition: the studio then judges nothing about its models.
 */
export function servedProtocols(
  provider: StudioProvider,
  type?: ModelProfileType,
): Protocol[] | undefined {
  const definition = kernelDefinition(provider.definition);
  if (!definition) return undefined;
  let registered: RegisteredProvider;
  try {
    registered = registerStudioProvider(createProviderRegistry(), provider, definition);
  } catch {
    // why: a provider the kernel refuses serves nothing yet; its problems say why.
    return [];
  }
  return registered.serves
    .map((serve) => serve.protocol)
    .filter((protocol) => type === undefined || protocol.endpoints[type] !== undefined);
}

/**
 * Whether `provider` serves agents of `type` on some protocol, or on `protocol` when it is named.
 * A provider from a project's own definition is taken to.
 */
export function servesProfileType(
  provider: StudioProvider | undefined,
  type: ModelProfileType,
  protocol?: string,
): boolean {
  if (!provider) return false;
  const served = servedProtocols(provider, type);
  if (served === undefined) return true;
  return protocol === undefined ? served.length > 0 : served.some((each) => each.id === protocol);
}

/** A model as the studio's rules read it: its protocol, its provider, and that provider's definition, and whether it decides. */
export interface ModelRoute {
  /** The profile type this model serves. */
  profileType: ModelProfileType;
  protocol: string;
  provider: string;
  definition: string | undefined;
  apiId: string;
  /** The model is a decision agent's. */
  decision: boolean;
}

/** The route of `binding`, a model of an agent of `type` whose providers are `providers`. */
export function modelRoute(
  providers: readonly StudioProvider[],
  type: string,
  binding: { protocol: string; provider: string; apiId: string },
): ModelRoute {
  if (!isModelProfileType(type)) {
    throw new Error(`Cannot create a model route without a profile type.`); // labels-exempt: builder diagnostic
  }
  return {
    profileType: type,
    protocol: binding.protocol,
    provider: binding.provider,
    definition: definitionOf(providers, binding.provider),
    apiId: binding.apiId,
    decision: type === 'decision',
  };
}

function isModelProfileType(type: string): type is ModelProfileType {
  return ['text', 'image', 'speech', 'transcription', 'live', 'decision', 'embedding'].includes(
    type,
  );
}

/** One option a protocol takes, as a row edits it. */
export interface ProtocolOptionField {
  /** Where it sits under the model's `options`, dotted: `store`, `cache.mode`. */
  path: string;
  label: string;
  kind: 'boolean' | 'choice' | 'text' | 'number' | 'names';
  /** The protocol refuses the model without it. */
  required: boolean;
  /** What the protocol says the option is. */
  description?: string;
  /** The values a choice takes, each with the name and description the protocol gives it. */
  choices?: { value: string; label?: string; description?: string }[];
  /** Choice values are numbers in the protocol schema and must remain numbers in the draft. */
  choiceType?: 'number';
}

interface OptionSchema {
  type?: string;
  title?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: OptionSchema[];
  description?: string;
  items?: OptionSchema;
  properties?: Record<string, OptionSchema>;
  required?: string[];
}

/**
 * The options `protocol` takes, a field per setting, read from its own schema. A setting inside an
 * object is a field of its own; one a row cannot hold (a list of objects, a free record) is left to code. Given
 * the model, an option it refuses is left out, unless `options` already holds it: that row stays,
 * where its issue shows.
 */
export function protocolOptionFields(
  protocol: Protocol,
  model?: { apiId: string; options: JsonObject },
): ProtocolOptionField[] {
  const schema = z.toJSONSchema(protocol.options, {
    io: 'input',
    unrepresentable: 'any',
  }) as OptionSchema;
  const fields = fieldsOf(schema, '', true);
  const refused = model ? (protocol.refusedOptions?.(model.apiId.trim()) ?? []) : [];
  return fields.filter((field) => {
    const top = field.path.split('.')[0] ?? field.path;
    return !refused.includes(top) || model?.options[top] !== undefined;
  });
}

function fieldsOf(node: OptionSchema, prefix: string, held: boolean): ProtocolOptionField[] {
  return Object.entries(node.properties ?? {}).flatMap(([name, property]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    const required = held && (node.required?.includes(name) ?? false);
    if (property.type === 'object' && property.properties)
      return fieldsOf(property, path, required);
    const base = {
      path,
      label: optionLabel(name),
      required,
      ...(property.description ? { description: property.description } : {}),
    };
    const literals = property.anyOf?.filter(
      (choice): choice is OptionSchema & { const: string | number } =>
        typeof choice.const === 'string' || typeof choice.const === 'number',
    );
    const literalChoices = literals?.map((choice) => choice.const);
    if (property.enum?.every((value) => typeof value === 'string')) {
      return [
        {
          ...base,
          kind: 'choice' as const,
          choices: property.enum.map((value) => ({ value: value as string })),
        },
      ];
    }
    if (
      literalChoices &&
      literalChoices.length === property.anyOf?.length &&
      literalChoices.length > 0
    ) {
      const numeric = literalChoices.every((value) => typeof value === 'number');
      if (numeric || literalChoices.every((value) => typeof value === 'string')) {
        return [
          {
            ...base,
            kind: 'choice' as const,
            choices: (literals ?? []).map((choice) => ({
              value: String(choice.const),
              ...(choice.title ? { label: choice.title } : {}),
              ...(choice.description ? { description: choice.description } : {}),
            })),
            ...(numeric ? { choiceType: 'number' as const } : {}),
          },
        ];
      }
    }
    if (property.type === 'boolean') return [{ ...base, kind: 'boolean' as const }];
    if (property.type === 'array' && property.items?.type === 'string')
      return [{ ...base, kind: 'names' as const }];
    if (property.type === 'string') return [{ ...base, kind: 'text' as const }];
    if (property.type === 'number' || property.type === 'integer')
      return [{ ...base, kind: 'number' as const }];
    return [];
  });
}

/** An option's name as a row labels it: `persistViaInteractionId` is Persist via interaction id. */
function optionLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The value at `path` in `options`. */
export function optionAt(options: JsonObject, path: string): JsonValue | undefined {
  return path
    .split('.')
    .reduce<JsonValue | undefined>(
      (held, key) =>
        held && typeof held === 'object' && !Array.isArray(held) ? held[key] : undefined,
      options,
    );
}

/** `options` with `value` at `path`, or with it left out when `undefined`; an object left empty goes too. */
export function withOption(
  options: JsonObject,
  path: string,
  value: JsonValue | undefined,
): JsonObject {
  const [key = '', ...rest] = path.split('.');
  const { [key]: was, ...others } = options;
  const next = rest.length
    ? withOption(
        was && typeof was === 'object' && !Array.isArray(was) ? was : {},
        rest.join('.'),
        value,
      )
    : value;
  const empty =
    next === undefined ||
    (typeof next === 'object' &&
      next !== null &&
      !Array.isArray(next) &&
      !Object.keys(next).length);
  return empty ? others : { ...others, [key]: next };
}
