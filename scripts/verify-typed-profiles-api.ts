#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env --allow-sys

/**
 * Real-provider pressure suite for typed profiles in THEOREM:
 *   - text profiles (OpenRouter & Gemini Interactions)
 *   - image profiles (OpenRouter /images & Gemini Interactions)
 *   - speech profiles (OpenRouter /audio/speech & Gemini TTS)
 *   - live profiles (`type: 'live'` / runSession over Gemini Live)
 *
 * Every test calls the real API and fails on any error event. Pass section
 * names to run a subset: `text`, `image`, `speech`, `live` (default: all).
 *
 * Exercises the entire THEOREM kernel:
 *   defineProfile -> registerProfile -> resolveTurn -> runTurn / runSession -> createProvider -> upstream API
 */

import { z } from 'zod';
import { runTurn } from '../src/kernel/engine/runner.ts';
import { runSession } from '../src/kernel/engine/session/mod.ts';
import { defineProfile, registerProfile } from '../src/kernel/registry/profiles.ts';
import { projectProfile, resolveTurn } from '../src/kernel/registry/resolve.ts';
import { registerStructured } from '../src/kernel/registry/schemas.ts';
import { registerTool } from '../src/kernel/tools/registry.ts';
import type {
  ImageProfile,
  LiveProfile,
  LiveSession,
  SpeechProfile,
  TextProfile,
  TurnEvent,
  TurnRequest,
} from '../src/kernel/types.ts';
import { memorySink } from '../src/observability/trace.ts';
import type { TraceRecord } from '../src/observability/trace-record.ts';
import { registerGooglePreset } from '../src/presets/google.ts';
import { createProvider } from '../src/providers/create-provider.ts';
import {
  hostOpenRouterKey,
  hostVault,
  loadHostEnv,
  OPENROUTER_ENV,
  VAULT_ENV,
} from './host-env.ts';

// ---------------------------------------------------------------------------
// Load Env
// ---------------------------------------------------------------------------

loadHostEnv();

const openRouterKey = hostOpenRouterKey();
const vault = hostVault();

console.log('════════════════════════════════════════════════════════════════════════');
console.log('  THEOREM TYPED PROFILES LIVE PRESSURE TEST');
console.log('════════════════════════════════════════════════════════════════════════');
console.log(
  `  OpenRouter Key: ${openRouterKey ? `Present (len=${openRouterKey.length})` : 'MISSING'}`,
);
console.log('════════════════════════════════════════════════════════════════════════\n');

registerGooglePreset();

// ---------------------------------------------------------------------------
// Register Test Tools and Schemas
// ---------------------------------------------------------------------------

registerTool({
  type: 'function',
  name: 'calculate_sum',
  description: 'Add two numbers together and return the result',
  category: 'math',
  access: 'read-only',
  loadTier: 'T0',
  permission: 'auto',
  paths: ['*'],
  input: z.object({
    a: z.number().describe('First number'),
    b: z.number().describe('Second number'),
  }),
  output: z.object({
    sum: z.number(),
  }),
  handler: (input) => {
    const args = input as { a: number; b: number };
    return { sum: args.a + args.b };
  },
});

registerStructured('sentimentAnalysis', {
  jsonSchema: {
    type: 'object',
    properties: {
      sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
      score: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string' },
    },
    required: ['sentiment', 'score', 'reasoning'],
  },
});

const SECTIONS = ['text', 'image', 'speech', 'live'] as const;
type Section = (typeof SECTIONS)[number];

function isSection(value: string): value is Section {
  return (SECTIONS as readonly string[]).includes(value);
}

const unknownSections = Deno.args.filter((arg) => !isSection(arg));
if (unknownSections.length > 0) {
  console.error(`Unknown sections: ${unknownSections.join(', ')} (known: ${SECTIONS.join(', ')})`);
  Deno.exit(2);
}
/** Sections named on the command line, or every section. */
const selected = new Set<Section>(Deno.args.length > 0 ? Deno.args.filter(isSection) : SECTIONS);

const GEMINI_TEXT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
] as const;
const GEMINI_IMAGE_MODELS = ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image'] as const;
const GEMINI_SPEECH_MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
] as const;
/** The default-guardrails speech case; 3.8 lite replaces 3.1-flash-tts-preview. */
const GEMINI_SPEECH_DEFAULT = 'gemini-3.8-flash-lite-tts';
/** Live models and the thinking level each accepts: extended-thinking rejects `none` and `minimal` (1007). */
const GEMINI_LIVE_MODELS = {
  'gemini-3.1-flash-live-preview': 'none',
  'gemini-3.8-live': 'none',
  'gemini-3.8-live-extended-thinking': 'low',
} as const;
type GeminiLiveModel = keyof typeof GEMINI_LIVE_MODELS;
const GEMINI_LIVE_IDS = Object.keys(GEMINI_LIVE_MODELS) as GeminiLiveModel[];

/** One Interactions text binding; the same knobs for every model under test. */
function geminiTextBinding(apiId: string) {
  return {
    protocol: 'geminiInteractions',
    provider: 'google',
    apiId,
    efforts: { normal: 'low' },
    maxOutputTokens: 1024,
    temperature: 0.1,
  } as const;
}
const OPENROUTER_TEXT_API_ID = 'openrouter/free';

let passed = 0;
let failed = 0;
let skipped = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`  ✗ FAIL: ${name}\n    ${msg}`);
    failed++;
  }
}

/** A test whose key is missing is counted, never silently dropped. */
function skipTest(name: string, reason: string) {
  console.log(`  - SKIP: ${name} (${reason})`);
  skipped++;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const geminiTransport = { gemini: { vault, wait: () => Promise.resolve() } };

function gateway(key: string) {
  return {
    openAiGateway: {
      apiKey: key,
      siteUrl: 'https://theorem.agent',
      siteName: 'Theorem Live Pressure Test',
    },
  };
}

async function collect(iter: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

/** Every turn's trace record, in order; the routed model lives only in the trace. */
const traces: TraceRecord[] = [];
const traceSink = memorySink(traces);

/** The models the last turn's calls reported (`gen_ai.response.model`) and the text Theorem delivered. */
function turnDiagnostics(events: TurnEvent[]): string {
  const models = (traces.at(-1)?.spans ?? []).flatMap((span) => {
    const model = span.attributes['gen_ai.response.model'];
    return typeof model === 'string' ? [model] : [];
  });
  const routed = models.length > 0 ? models.join(', ') : 'not reported';
  return `routed model: ${routed}; delivered text: ${JSON.stringify(textOf(events).slice(0, 300))}`;
}

/** Fail on any error event, and on a turn that never reached `done`. */
function assertClean(events: TurnEvent[]): void {
  const errEvent = events.find((e) => e.type === 'error');
  if (errEvent) {
    throw new Error(
      `error event: ${errEvent.errorInternal ?? errEvent.error}\n    ${turnDiagnostics(events)}`,
    );
  }
  if (!events.some((e) => e.type === 'done')) throw new Error('Missing done event');
}

function textOf(events: TurnEvent[]): string {
  return events.flatMap((e) => (e.type === 'text' && e.text ? [e.text] : [])).join('');
}

/** The turn's media, which must carry the expected MIME family and non-empty bytes. */
function assertMedia(events: TurnEvent[], family: 'image' | 'audio'): void {
  const media = events.flatMap((e) => (e.type === 'media' && e.media ? [e.media] : []));
  if (media.length === 0) throw new Error(`No media event (${family})`);
  for (const item of media) {
    if (!item.mimeType.startsWith(`${family}/`)) {
      throw new Error(`Expected ${family}/*, got ${item.mimeType}`);
    }
    if (!item.data) throw new Error(`Empty ${family} data`);
  }
  console.log(
    `    Media: ${media.map((m) => `${m.mimeType} (${Math.round((m.data.length * 3) / 4 / 1024)} KiB)`).join(', ')}`,
  );
}

// ===========================================================================
// 1. TEXT PROFILES
// ===========================================================================

if (selected.has('text')) {
  console.log('─── 1. Text Profiles (type: "text") ───');

  if (openRouterKey) {
    await runTest('OpenRouter Text: SSE Streaming Text Turn', async () => {
      const profile = defineProfile({
        type: 'text',
        id: 'live_test_chat_or_sse',
        identity: { handle: 'assistant', system: 'You are a concise AI assistant.' },
        models: {
          'openrouter/free': {
            protocol: 'openAi',
            provider: 'openrouter',
            apiId: OPENROUTER_TEXT_API_ID,
            efforts: { normal: 'none' },
            maxOutputTokens: 100,
            temperature: 0.2,
          },
        },
        tools: { allow: [] },
        inputs: { text: true },
        outputs: { streaming: { mode: 'sse' } },
      }) as TextProfile;
      registerProfile(profile);

      const events = await collect(
        runTurn(
          { profile: profile.id, input: { text: 'Reply with "THEOREM_CHAT_OK" exactly.' } },
          createProvider(profile, gateway(openRouterKey)),
          traceSink,
        ),
      );
      assertClean(events);
      const fullText = textOf(events).trim();
      if (!fullText) throw new Error('Empty text response');
      console.log(`    Response preview: "${fullText.slice(0, 60)}"`);
    });

    await wait(4100);

    await runTest('OpenRouter Text: Structured JSON Output', async () => {
      const profile = defineProfile({
        type: 'text',
        id: 'live_test_chat_structured',
        identity: { handle: 'analyzer', system: 'Analyze sentiment in structured JSON.' },
        models: {
          'openrouter/free': {
            protocol: 'openAi',
            provider: 'openrouter',
            apiId: OPENROUTER_TEXT_API_ID,
            efforts: { normal: 'none' },
            maxOutputTokens: 200,
            temperature: 0.1,
          },
        },
        tools: { allow: [] },
        inputs: { text: true },
        outputs: { structured: 'sentimentAnalysis' },
      }) as TextProfile;
      registerProfile(profile);

      const events = await collect(
        runTurn(
          { profile: profile.id, input: { text: 'I love using this clean typed kernel!' } },
          createProvider(profile, gateway(openRouterKey)),
          traceSink,
        ),
      );
      assertClean(events);
      const structured = events.find((e) => e.type === 'structured')?.structured;
      const sentiment = (structured as { sentiment?: unknown } | undefined)?.sentiment;
      if (typeof sentiment !== 'string') {
        throw new Error(`No structured sentiment: ${JSON.stringify(structured)}`);
      }
      console.log(`    Structured Output: ${JSON.stringify(structured).slice(0, 100)}`);
    });

    await wait(4100);
  } else {
    skipTest('OpenRouter Text', `${OPENROUTER_ENV} missing`);
  }

  for (const apiId of GEMINI_TEXT_MODELS) {
    if (!vault.slotA) {
      skipTest(`Gemini Text ${apiId}`, `${VAULT_ENV.slotA} unset`);
      continue;
    }
    const models = { [apiId]: geminiTextBinding(apiId) };

    await runTest(`Gemini Text ${apiId}: tool calling through the kernel loop`, async () => {
      const profile = defineProfile({
        type: 'text',
        id: `live_test_tools_${apiId}`,
        identity: {
          handle: 'calculator',
          system:
            'You must use the calculate_sum tool to calculate any addition. Do not do mental math.',
        },
        models,
        maxSteps: 3,
        key: 'slotA',
        tools: { allow: ['calculate_sum'] },
        inputs: { text: true },
      }) as TextProfile;
      registerProfile(profile);

      const events = await collect(
        runTurn(
          { profile: profile.id, input: { text: 'Calculate the sum of 42 and 58.' } },
          createProvider(profile, geminiTransport),
          traceSink,
        ),
      );
      assertClean(events);
      const toolResults = events.filter((e) => e.type === 'tool' && e.tool?.phase === 'complete');
      if (toolResults.length === 0) throw new Error('calculate_sum never completed');
      const finalText = textOf(events).trim();
      if (!finalText.includes('100')) throw new Error(`Final text lacks 100: "${finalText}"`);
      console.log(`    Tool results: ${toolResults.length}, Final Text: "${finalText}"`);
    });
    await wait(4100);

    await runTest(`Gemini Text ${apiId}: structured output`, async () => {
      const profile = defineProfile({
        type: 'text',
        id: `live_test_structured_${apiId}`,
        identity: { handle: 'analyzer', system: 'Analyze sentiment in structured JSON.' },
        models,
        key: 'slotA',
        tools: { allow: [] },
        inputs: { text: true },
        outputs: { structured: 'sentimentAnalysis' },
      }) as TextProfile;
      registerProfile(profile);

      const events = await collect(
        runTurn(
          { profile: profile.id, input: { text: 'I love using this clean typed kernel!' } },
          createProvider(profile, geminiTransport),
          traceSink,
        ),
      );
      assertClean(events);
      const structured = events.find((e) => e.type === 'structured')?.structured;
      const sentiment = (structured as { sentiment?: unknown } | undefined)?.sentiment;
      if (typeof sentiment !== 'string') {
        throw new Error(`No structured sentiment: ${JSON.stringify(structured)}`);
      }
      console.log(`    Structured Output: ${JSON.stringify(structured).slice(0, 100)}`);
    });
    await wait(4100);

    await runTest(`Gemini Text ${apiId}: buffered streaming mode`, async () => {
      const profile = defineProfile({
        type: 'text',
        id: `live_test_buffered_${apiId}`,
        identity: { handle: 'assistant', system: 'Be concise.' },
        models,
        key: 'slotA',
        tools: { allow: [] },
        inputs: { text: true },
        outputs: { streaming: { mode: 'buffered' } },
      }) as TextProfile;
      registerProfile(profile);

      const turnReq: TurnRequest = { profile: profile.id, input: { text: 'Hello!' } };
      if (resolveTurn(turnReq).generation.stream !== false) {
        throw new Error('Expected generation.stream = false (buffered)');
      }
      const events = await collect(
        runTurn(turnReq, createProvider(profile, geminiTransport), traceSink),
      );
      assertClean(events);
      const text = textOf(events).trim();
      if (!text) throw new Error('Empty buffered response');
      console.log(`    Buffered Response: "${text}"`);
    });
    await wait(4100);
  }
}

// ===========================================================================
// 2. IMAGE PROFILES
// ===========================================================================

if (selected.has('image')) {
  console.log('\n─── 2. Image Profiles (type: "image") ───');

  if (openRouterKey) {
    await runTest('OpenRouter Image: /images generation', async () => {
      const profile = defineProfile({
        type: 'image',
        id: 'live_test_image_openrouter',
        identity: { handle: 'artist', system: 'Generate one image.' },
        models: {
          seedream: {
            protocol: 'openAi',
            provider: 'openrouter',
            apiId: 'bytedance-seed/seedream-4.5',
            efforts: { normal: 'none' },
          },
        },
        image: { mimeType: 'image/jpeg', aspectRatio: '1:1' },
        tools: { allow: [] },
        inputs: { text: true },
      }) as ImageProfile;
      registerProfile(profile);

      const projected = projectProfile(profile.id);
      if (projected.type !== 'image') throw new Error(`Expected image, got ${projected.type}`);

      const events = await collect(
        runTurn(
          { profile: profile.id, input: { text: 'A small green bonsai tree on a white table.' } },
          createProvider(profile, gateway(openRouterKey)),
          traceSink,
        ),
      );
      assertClean(events);
      assertMedia(events, 'image');
    });
  } else {
    skipTest('OpenRouter Image', `${OPENROUTER_ENV} missing`);
  }

  for (const apiId of GEMINI_IMAGE_MODELS) {
    if (!vault.paid) {
      skipTest(`Gemini Image ${apiId}`, `${VAULT_ENV.paid} unset`);
      continue;
    }
    await runTest(`Gemini Image ${apiId}: Interactions generation`, async () => {
      const profile = defineProfile({
        type: 'image',
        id: `live_test_image_${apiId}`,
        identity: { handle: 'artist', system: 'Generate exactly one image.' },
        models: {
          [apiId]: {
            protocol: 'geminiInteractions',
            provider: 'google',
            apiId,
            efforts: { normal: 'minimal' },
            maxOutputTokens: 4096,
            key: 'paid',
          },
        },
        image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/jpeg' },
        tools: { allow: [] },
        inputs: { text: true },
      }) as ImageProfile;
      registerProfile(profile);

      const events = await collect(
        runTurn(
          { profile: profile.id, input: { text: 'A small green bonsai tree on a white table.' } },
          createProvider(profile, geminiTransport),
          traceSink,
        ),
      );
      assertClean(events);
      assertMedia(events, 'image');
    });
  }
}

// ===========================================================================
// 3. SPEECH PROFILES
// ===========================================================================

if (selected.has('speech')) {
  console.log('\n─── 3. Speech Profiles (type: "speech") ───');

  if (openRouterKey) {
    await runTest('OpenRouter Speech: /audio/speech synthesis', async () => {
      const profile = defineProfile({
        type: 'speech',
        id: 'live_test_speech_openrouter',
        identity: { handle: 'speaker' },
        models: {
          fishTts: {
            protocol: 'openAi',
            provider: 'openrouter',
            apiId: 'fish-audio/s2.1-pro-free:free',
            efforts: { normal: 'none' },
          },
        },
        speech: { format: 'mp3' },
      }) as SpeechProfile;
      registerProfile(profile);

      const projected = projectProfile(profile.id);
      if (projected.type !== 'speech') throw new Error(`Expected speech, got ${projected.type}`);

      const events = await collect(
        runTurn(
          { profile: profile.id, input: { text: 'Your bonsai needs water today.' } },
          createProvider(profile, gateway(openRouterKey)),
          traceSink,
        ),
      );
      assertClean(events);
      assertMedia(events, 'audio');
    });
  } else {
    skipTest('OpenRouter Speech', `${OPENROUTER_ENV} missing`);
  }

  // Canary off: Gemini TTS rejects any system instruction, and the default
  // canary binds one. Open contract decision — the default-profile case below
  // keeps the break visible until it is settled.
  for (const apiId of GEMINI_SPEECH_MODELS) {
    for (const mode of ['sse', 'buffered'] as const) {
      if (!vault.slotA) {
        skipTest(`Gemini Speech ${apiId} ${mode}`, `${VAULT_ENV.slotA} unset`);
        continue;
      }
      await runTest(`Gemini Speech ${apiId} (${mode}): TTS synthesis`, async () => {
        const profile = defineProfile({
          type: 'speech',
          id: `live_test_speech_${apiId}_${mode}`,
          identity: { handle: 'speaker' },
          models: {
            [apiId]: {
              protocol: 'geminiInteractions',
              provider: 'google',
              apiId,
              efforts: { normal: 'minimal' },
              maxOutputTokens: 2048,
            },
          },
          key: 'slotA',
          speech: { voice: 'Kore', format: 'pcm' },
          outputs: { streaming: { mode } },
        }) as SpeechProfile;
        registerProfile(profile);

        const events = await collect(
          runTurn(
            { profile: profile.id, input: { text: 'Your bonsai needs water today.' } },
            createProvider(profile, geminiTransport),
            traceSink,
          ),
        );
        assertClean(events);
        assertMedia(events, 'audio');
      });
      await wait(4100);
    }
  }

  if (vault.slotA) {
    await runTest('Gemini Speech: default profile (guardrails default)', async () => {
      const profile = defineProfile({
        type: 'speech',
        id: 'live_test_speech_default',
        identity: { handle: 'speaker' },
        models: {
          [GEMINI_SPEECH_DEFAULT]: {
            protocol: 'geminiInteractions',
            provider: 'google',
            apiId: GEMINI_SPEECH_DEFAULT,
            efforts: { normal: 'minimal' },
            maxOutputTokens: 2048,
          },
        },
        key: 'slotA',
        speech: { voice: 'Kore', format: 'pcm' },
      }) as SpeechProfile;
      registerProfile(profile);

      const events = await collect(
        runTurn(
          { profile: profile.id, input: { text: 'Your bonsai needs water today.' } },
          createProvider(profile, geminiTransport),
          traceSink,
        ),
      );
      assertClean(events);
      assertMedia(events, 'audio');
    });
  }
}

// ===========================================================================
// 4. LIVE PROFILES
// ===========================================================================

const LIVE_TURN_TIMEOUT_MS = 60_000;
/** Quiet time after `turn_complete` before a model that reports no status is taken as done. */
const LIVE_SETTLE_MS = 3000;

/** The next event, or undefined once `ms` pass without one. */
async function nextWithin(
  iter: AsyncIterator<TurnEvent>,
  ms: number,
): Promise<IteratorResult<TurnEvent> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const quiet = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([iter.next(), quiet]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One Live cycle's events. `onEvent` may act on each (run a tool). The cycle
 * ends at `idle`, or — for a model that reports no status — on quiet after
 * `turn_complete` (docs/contracts/providers.md); either only once `settled()`.
 */
async function collectLiveCycle(
  session: LiveSession,
  onEvent: (event: TurnEvent) => Promise<void> = () => Promise.resolve(),
  settled: () => boolean = () => true,
): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  const iter = session.events()[Symbol.asyncIterator]();
  let turnComplete = false;
  while (true) {
    const quiet = turnComplete && settled() ? LIVE_SETTLE_MS : LIVE_TURN_TIMEOUT_MS;
    const next = await nextWithin(iter, quiet);
    if (!next || next.done) break;
    const event = next.value;
    events.push(event);
    await onEvent(event);
    if (event.type === 'error') break;
    if (event.type === 'session' && event.session?.kind === 'idle' && settled()) break;
    if (event.type === 'session' && event.session?.kind === 'turn_complete') turnComplete = true;
  }
  return events;
}

/**
 * Output transcript per model turn. Gemini's transcription deltas carry their
 * own spacing within a turn, and each turn starts fresh, so turns stay apart.
 */
function transcriptTurns(events: TurnEvent[]): string[] {
  const turns: string[] = [''];
  for (const e of events) {
    if (e.evidence?.kind === 'output_transcription' && e.text) {
      turns[turns.length - 1] += e.text;
    } else if (e.type === 'session' && e.session?.kind === 'turn_complete') {
      turns.push('');
    }
  }
  return turns.map((turn) => turn.trim()).filter(Boolean);
}

/** Throw on an error event; return the output transcript per turn and audio chunks. */
function liveOutput(events: TurnEvent[]): { transcript: string[]; audio: TurnEvent[] } {
  const errEvent = events.find((e) => e.type === 'error');
  if (errEvent) throw new Error(`error event: ${errEvent.errorInternal ?? errEvent.error}`);
  const sessionKinds = events.flatMap((e) =>
    e.type === 'session' && e.session
      ? [e.session.kind]
      : e.type === 'done'
        ? [`done:${e.stop?.kind}`]
        : e.type === 'tool' && e.tool
          ? [`tool:${e.tool.name}:${e.tool.phase ?? 'call'}`]
          : [],
  );
  console.log(`    Session events: ${sessionKinds.join(' → ')}`);
  return {
    transcript: transcriptTurns(events),
    audio: events.filter((e) => e.type === 'media' && e.media?.mimeType.startsWith('audio/')),
  };
}

if (selected.has('live')) {
  console.log('\n─── 4. Live Profiles (type: "live") ───');

  const liveProfile = (apiId: GeminiLiveModel, tools: string[] = []) =>
    defineProfile({
      type: 'live',
      id: `live_test_${apiId}${tools.length ? '_tools' : ''}`,
      identity: {
        handle: 'conversationalist',
        system: tools.length
          ? 'Real-time conversational agent. Be brief. Always use calculate_sum for addition.'
          : 'Real-time conversational agent. Be brief.',
      },
      models: {
        [apiId]: {
          protocol: 'geminiLive',
          provider: 'google',
          apiId,
          efforts: { normal: GEMINI_LIVE_MODELS[apiId] },
          summaries: false,
          builtInTools: [],
          key: 'slotA',
        },
      },
      live: {
        voice: 'Aoede',
        sessionResumption: true,
        transcription: { input: true, output: true },
        ingress: { text: true },
      },
      tools: { allow: tools },
    }) as LiveProfile;

  await runTest('Live Profile: createProvider rejects live (session door only)', () => {
    const profile = liveProfile(GEMINI_LIVE_IDS[0]);
    let rejected = false;
    try {
      createProvider(profile, {
        gemini: { vault: { slotA: 'k', slotB: undefined, slotC: undefined, paid: undefined } },
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('createProvider should reject geminiLive profiles');
  });

  for (const apiId of GEMINI_LIVE_IDS) {
    if (!vault.slotA) {
      skipTest(`Live ${apiId}`, `${VAULT_ENV.slotA} unset`);
      continue;
    }
    await runTest(`Live ${apiId}: runSession text turn`, async () => {
      const profile = liveProfile(apiId);
      registerProfile(profile);
      const session = await runSession({ profile: profile.id }, geminiTransport);
      const timer = setTimeout(() => void session.close('live turn timeout'), LIVE_TURN_TIMEOUT_MS);
      try {
        await session.sendText('Say hello in five words or fewer.');
        const { transcript, audio } = liveOutput(await collectLiveCycle(session));
        if (audio.length === 0) throw new Error('No audio returned');
        if (transcript.length === 0) throw new Error('No output transcription returned');
        console.log(
          `    Audio: ${audio.length} chunk(s) ${audio[0]?.media?.mimeType}, Transcript: ${JSON.stringify(transcript)}`,
        );
      } finally {
        clearTimeout(timer);
        await session.close('test complete');
      }
    });

    await runTest(`Live ${apiId}: tool call through executeTool`, async () => {
      const profile = liveProfile(apiId, ['calculate_sum']);
      registerProfile(profile);
      const session = await runSession({ profile: profile.id }, geminiTransport);
      const timer = setTimeout(() => void session.close('live turn timeout'), LIVE_TURN_TIMEOUT_MS);
      const results: unknown[] = [];
      let answer = '';
      try {
        await session.sendText('Use calculate_sum to add 42 and 58, then say the result.');
        const events = await collectLiveCycle(
          session,
          async (event) => {
            if (event.type === 'tool' && event.tool && !event.tool.phase) {
              const settled = await session.executeTool({
                name: event.tool.name,
                callId: event.tool.id ?? event.tool.name,
                input: event.tool.arguments,
              });
              if (settled.failure) throw new Error(`tool failed: ${settled.failure.message}`);
              results.push(settled.outputRaw);
            }
            if (results.length > 0 && event.evidence?.kind === 'output_transcription') {
              answer += event.text ?? '';
            }
          },
          () => results.length > 0 && answer.trim().length > 0,
        );
        const { transcript } = liveOutput(events);
        if (results.length === 0) throw new Error('calculate_sum was never called');
        if (JSON.stringify(results[0]) !== JSON.stringify({ sum: 100 })) {
          throw new Error(`Unexpected tool output: ${JSON.stringify(results[0])}`);
        }
        if (!/100|hundred/i.test(answer)) throw new Error(`Answer lacks 100: "${answer}"`);
        console.log(
          `    Tool results: ${results.length}, Transcript: ${JSON.stringify(transcript)}`,
        );
      } finally {
        clearTimeout(timer);
        await session.close('test complete');
      }
    });
  }
}

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log('\n════════════════════════════════════════════════════════════════════════');
console.log(
  `  PRESSURE TEST SUMMARY:  TOTAL: ${passed + failed + skipped}  |  PASSED: ${passed}  |  FAILED: ${failed}  |  SKIPPED: ${skipped}`,
);
console.log('════════════════════════════════════════════════════════════════════════\n');

if (failed > 0) {
  Deno.exit(1);
}
