import { assertEquals } from '@std/assert';
import { z } from 'zod';
import {
  defineProfile,
  defineProvider,
  openRouterAdapter,
  PROFILE_FIELDS,
  type ProviderAdapter,
  registerProfile,
  registerStructured,
  registerTool,
  typesafeAdapter,
} from '../../mod.ts';
import { compileDetect } from '../../src/guardrails/compile-egress.ts';
import { LABEL_KEYS, labelPlaceholders } from '../../src/guardrails/labels.ts';
import { catalogPathFor } from '../../src/kernel/schema.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { connectionFields, kernelAdapters } from '../../studio/providers.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';

/**
 * Profiles written as a project writes them, which between them set every profile field the
 * kernel has. They open in the studio as themselves: a field the studio does not hold, or holds
 * as something else, fails here by name. A new kernel field fails until a profile here sets it.
 */
const HOST = '127.0.0.1:4983';
registerFixtureProviders(defaultKernelScope);

/** Providers that between them set everything a provider on a kernel adapter can hold. */
function registerEveryProvider() {
  defaultKernelScope.providers.register(
    defineProvider({
      id: 'every-router',
      connection: {
        decisionURL: 'https://decide.example/v1',
        baseURL: 'https://router.example/v1',
        siteUrl: 'https://garden.example',
        siteName: 'Garden',
      },
      keySlot: 'slot_a',
      fallbackKeySlot: 'slot_b',
      adapter: openRouterAdapter(),
    }),
  );
  defaultKernelScope.providers.register(
    defineProvider({
      id: 'every-typesafe',
      connection: { baseURL: 'https://typesafe.example/v1' },
      adapter: typesafeAdapter(),
    }),
  );
}
registerEveryProvider();

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What only code can say: the studio shows where each is set and leaves it to the file. */
const CODE = [
  'tools.t1Policy',
  'outputs.validation.fields.*',
  'outputs.validation.items.*.check',
  'guardrails.disclosure.enforce',
  'guardrails.detect.*.find',
  'models.*.compaction.trigger',
  'observability.onWriteError',
];

const catalog = Object.keys(PROFILE_FIELDS);
const leaves = catalog.filter((path) => !catalog.some((child) => child.startsWith(`${path}.`)));

/** A `detect` block that sets every field the catalog has under it. */
function everyDetectField(): Json {
  const detect: Json = {};
  const set = (keys: string[], value: unknown) => {
    let at = detect;
    for (const key of keys.slice(0, -1)) {
      at[key] ??= {};
      at = at[key] as Json;
    }
    at[keys[keys.length - 1]] = value;
  };
  for (const path of leaves) {
    const keys = path.split('.').slice(2);
    if (
      !path.startsWith('guardrails.detect.') ||
      keys.includes('compiled') ||
      keys.includes('find')
    )
      continue;
    const named = keys.map((key, index) => (index === 0 && key === '*' ? 'house.rule' : key));
    const [, field, inner] = named;
    if (field === 'patterns') {
      set(
        [named[0], 'patterns'],
        [
          { name: 'ticket', pattern: 'T-\\d+', flags: 'i' },
          { name: 'word', words: ['ticket'] },
        ],
      );
    } else if (field === 'at' || field === 'action') set(named, 'flag');
    else if (field === 'theorem') set(named, true);
    else if (field === 'allow') set(named, inner === 'fromTools' ? true : ['example.com']);
    else set(named, 'A ticket number');
  }
  return detect;
}

const NOTE = {
  type: 'object',
  properties: { notes: { type: 'array', items: { type: 'string' } } },
  required: ['notes'],
};
registerStructured('every.note', { jsonSchema: NOTE });
registerTool({
  type: 'http',
  name: 'every_fetch',
  description: 'Fetches a page.',
  method: 'GET',
  endpoint: 'https://example.com/page',
  input: z.object({}),
  output: z.object({ page: z.string() }),
  access: 'read-only',
  category: 'studio',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
});

registerTool({
  type: 'function',
  name: 'every_load',
  description: 'Loads more tools.',
  access: 'read-only',
  category: 'studio',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({}),
  output: z.object({}),
  handler: () => ({}),
});

registerTool({
  type: 'builtin',
  name: 'googleSearch',
  description: 'Searches the web.',
  category: 'studio',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T2',
  permission: 'auto',
} as never);

const observability = {
  writeTo: 'traces',
  sampleRate: 0.5,
  include: {
    upstreamLog: false,
    outboundWire: true,
    evidenceRaw: true,
    usage: false,
    guardrailDecisions: false,
    guardrailMatchPreview: true,
  },
  resource: { team: 'desk' },
  scrub: { sensitive: false, injection: false, canary: false },
  retainForDays: 7,
  rotateAfterMiB: 8,
};

const PROFILES = [
  // The profile the writer's history is compacted with.
  defineProfile({
    type: 'text',
    id: 'every-compactor',
    identity: { handle: 'compactor' },
    models: { main: { provider: 'google', apiId: 'gemini-3.5-flash' } },
    defaultModel: 'main',
    inputs: {},
    tools: { allow: [] },
  } as never),
  // Every message a profile can word, on a profile that turns on nothing a message belongs to.
  defineProfile({
    type: 'text',
    id: 'every-label',
    identity: { handle: 'worded' },
    models: { main: { provider: 'google', apiId: 'gemini-3.5-flash' } },
    defaultModel: 'main',
    inputs: {},
    tools: { allow: [] },
    labels: Object.fromEntries(
      LABEL_KEYS.map((key) => [
        key,
        `Worded for ${key}. ${labelPlaceholders(key)
          .map((name) => `{${name}}`)
          .join(' ')}`.trim(),
      ]),
    ),
  } as never),
  defineProfile({
    type: 'text',
    id: 'every-text',
    identity: {
      handle: 'writer',
      system: ['You write.', { private: 'House rules.' }],
      systemByRole: { admin: 'You write for staff.' },
    },
    models: {
      main: {
        provider: 'google',
        apiId: 'gemini-3.5-flash',
        keySlot: 'slot_a',
        fallbackKeySlot: 'slot_b',
        providerOptions: { store: true, persistViaInteractionId: true },
        efforts: { quick: 'low', deep: 'high' },
        defaultEffort: 'quick',
        allowEffortSelect: true,
        summaries: true,
        maxOutputTokens: 2048,
        temperature: 0.4,
        builtInTools: ['googleSearch'],
        compaction: {
          maxTokens: 100_000,
          compactAt: 0.8,
          previousExchanges: 2,
          profile: 'every-compactor',
          timing: 'after',
          meter: 'input',
        },
      },
      cached: {
        provider: 'openrouter',
        apiId: 'anthropic/claude-sonnet-4.5',
        providerOptions: { cache: { mode: 'system', ttl: '1h' } },
      },
      second: {
        provider: 'local',
        apiId: 'local-model',
        providerOptions: { server: 'http://127.0.0.1:1234' },
      },
    },
    defaultModel: 'main',
    allowModelSelect: true,
    maxSteps: 12,
    providerContinuation: { onMismatch: 'error', history: 'provider' },
    tools: { allow: ['every_fetch', 'every_load'], t2Loader: 'every_load' },
    inputs: {
      text: false,
      attachments: { accept: ['image/png'] },
      voice: { accept: ['audio/wav'] },
      maxFiles: 3,
      maxBytes: 1_000_000,
      maxTurnBytes: 2_000_000,
      limitsByMime: { 'image/png': 500_000 },
      slots: { role: ['admin', 'guest'] },
      context: { from: ['client', 'server'], maxChars: 4000 },
    },
    outputs: {
      structured: 'every.note',
      validation: {
        maxRetries: 2,
        items: { notes: { check: () => ({ ok: true }), onFail: 'fix' } },
      },
      streaming: { mode: 'buffered', streamThoughts: false },
    },
    turnBehaviour: {
      resumption: {
        allowContinue: ['length'],
        autoContinue: ['stream_incomplete'],
        maxContinues: 2,
      },
      allowSteering: false,
      atStepLimit: 'answer',
    },
    guardrails: {
      quota: { perDay: 100 },
      detect: compileDetect(everyDetectField() as never),
      blockedReply: { onBlock: 'refuse', maxRetries: 2 },
      network: {
        allowPrivateNetworks: true,
        allowedHosts: ['example.com'],
        allowedSchemes: ['https'],
      },
      taint: { afterRemoteRead: 'write', remoteDestination: 'confirm' },
    },
    labels: { 'repair.default_guidance': 'Return the notes as JSON.' },
    observability,
  } as never),
  defineProfile({
    type: 'image',
    id: 'every-image',
    identity: { handle: 'painter', system: 'You paint.' },
    models: { main: { provider: 'google', apiId: 'gemini-3.1-flash-lite-image' } },
    defaultModel: 'main',
    tools: { allow: [] },
    inputs: {},
    image: {
      aspectRatio: '16:9',
      resolution: '2K',
      mimeType: 'image/png',
      quality: 'high',
      background: 'transparent',
      n: 2,
      seed: 7,
      outputCompression: 80,
      references: [
        { mimeType: 'image/png', uri: 'https://example.com/style.png', name: 'style.png' },
      ],
      includeText: true,
    },
  } as never),
  defineProfile({
    type: 'speech',
    id: 'every-speech',
    identity: { handle: 'reader' },
    models: { main: { provider: 'google', apiId: 'gemini-3.1-flash-tts-preview' } },
    defaultModel: 'main',
    speech: { voice: 'Kore', style: 'Warm and unhurried.', speed: 1.1, format: 'pcm' },
  } as never),
  defineProfile({
    type: 'live',
    id: 'every-live',
    identity: { handle: 'caller', system: 'You take calls.' },
    models: { main: { provider: 'google', apiId: 'gemini-3.1-flash-live-preview' } },
    defaultModel: 'main',
    tools: { allow: [] },
    live: {
      ingress: { audio: false, video: false, text: true },
      voice: 'Aoede',
      vad: {
        activityHandling: 'NO_INTERRUPTION',
        startSensitivity: 'START_SENSITIVITY_LOW',
        endSensitivity: 'END_SENSITIVITY_HIGH',
        prefixPaddingMs: 200,
        silenceDurationMs: 800,
      },
      sessionResumption: true,
      greeting: 'Hello, how can I help?',
      resumed: { prompt: 'Welcome back.', afterMs: 60_000 },
      contextCompression: { triggerTokens: 100_000, slidingWindow: { targetTokens: 40_000 } },
      transcription: { input: true, output: true },
    },
  } as never),
  defineProfile({
    type: 'decision',
    id: 'every-decision',
    identity: { handle: 'judge' },
    models: { main: { provider: 'typesafe', apiId: 'jev-latest', timeoutMs: 1000 } },
    inputs: { state: 'json', maxStateBytes: 1000 },
    decision: { contract: 'every.v1' },
  } as never),
  defineProfile({ type: 'host', id: 'every-host', tools: { allow: ['every_fetch'] } }),
];
for (const profile of PROFILES) registerProfile(profile);

/** The catalog path of every setting a profile sets. A list of records is read through. */
function settingsOf(value: unknown, keys: string[] = [], found = new Set<string>()): Set<string> {
  if (Array.isArray(value) && value.some(isRecord))
    for (const item of value) settingsOf(item, [...keys, '*'], found);
  else if (isRecord(value)) {
    // A detector of the project's own has a dot in its key, and the catalog holds it as `*`.
    for (const [key, inner] of Object.entries(value))
      settingsOf(inner, [...keys, key.includes('.') ? '*' : key], found);
  } else found.add(catalogPathFor(keys));
  return found;
}

const matches = (pattern: string, path: string) => {
  const [held, keys] = [pattern.split('.'), path.split('.')];
  return held.length === keys.length && held.every((key, at) => key === '*' || key === keys[at]);
};

Deno.test('the profiles here set every profile field the kernel has, but for what only code says', () => {
  const set = new Set(PROFILES.flatMap((profile) => [...settingsOf(profile)]));
  const covered = (leaf: string) =>
    [...set].some((path) => path === leaf || matches(leaf, path) || path.startsWith(`${leaf}.`));
  const missing = leaves.filter(
    (leaf) => !covered(leaf) && !CODE.includes(leaf) && !leaf.endsWith('.compiled'),
  );
  assertEquals(missing, []);
});

Deno.test('every field opens in the studio as the project wrote it', async () => {
  const handler = createStudioHandler({ project: 'every', pageOrigins: [], listenHost: HOST });
  const request = new Request(`http://${HOST}/api/studio`, { headers: { host: HOST } });
  const { differences, unheld }: StudioDescription = await (await handler(request)).json();
  assertEquals(unheld, undefined);
  assertEquals(differences, undefined);
});

async function described(): Promise<StudioDescription> {
  const handler = createStudioHandler({ project: 'every', pageOrigins: [], listenHost: HOST });
  const request = new Request(`http://${HOST}/api/studio`, { headers: { host: HOST } });
  return (await handler(request)).json();
}

Deno.test('the providers here set everything a kernel adapter connects with', () => {
  const registered = defaultKernelScope.providers.list();
  const missing = kernelAdapters().flatMap((adapter) =>
    (connectionFields(adapter) ?? [])
      .filter(
        (field) =>
          !registered.some(
            (provider) =>
              provider.adapter.id === adapter &&
              field.name in (provider.connection as Record<string, unknown>),
          ),
      )
      .map((field) => `${adapter}.${field.name}`),
  );
  assertEquals(missing, []);
});

Deno.test('a provider the studio cannot hold whole is named with what it shows differently', async () => {
  // A project's own adapter under a kernel adapter's id, connecting with what is not text.
  defaultKernelScope.providers.register(
    defineProvider({
      id: 'wrapped',
      connection: { retries: 3 },
      adapter: {
        ...typesafeAdapter(),
        connectionSchema: z.strictObject({ retries: z.number() }),
      } as unknown as ProviderAdapter<{ retries: number }, Record<string, never>, string>,
    }),
  );
  try {
    const { differences } = await described();
    assertEquals(differences, [
      { kind: 'provider', of: 'wrapped', settings: ['connection.retries'] },
    ]);
  } finally {
    defaultKernelScope.providers.reset();
    registerFixtureProviders(defaultKernelScope);
    registerEveryProvider();
  }
});
