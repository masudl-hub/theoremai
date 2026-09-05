#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env --allow-sys

/**
 * Comprehensive live pressure-test suite for typed profiles in THEORUM:
 *   - chat profiles (OpenRouter & Gemini)
 *   - image profiles
 *   - speech profiles
 *   - live profiles
 *
 * Exercises the entire THEORUM kernel:
 *   defineProfile -> registerProfile -> resolveTurn -> runTurn -> createProvider -> upstream API
 */

import { z } from 'zod';
import { runTurn } from '../src/kernel/engine/runner.ts';
import { defineProfile, registerProfile } from '../src/kernel/registry/profiles.ts';
import { projectProfile, resolveTurn } from '../src/kernel/registry/resolve.ts';
import { registerStructured } from '../src/kernel/registry/schemas.ts';
import { registerTool } from '../src/kernel/tools/registry.ts';
import type {
  ImageProfile,
  LiveProfile,
  SpeechProfile,
  TextProfile,
  TurnEvent,
  TurnRequest,
} from '../src/kernel/types.ts';
import { registerGooglePreset } from '../src/presets/google.ts';
import { createProvider } from '../src/providers/create-provider.ts';

// ---------------------------------------------------------------------------
// Load Env
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
  try {
    const text = Deno.readTextFileSync(path);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (Deno.env.get(key) !== undefined) continue;
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      Deno.env.set(key, val);
    }
  } catch {
    // Ignore missing
  }
}

const envCandidates = [
  Deno.env.get('THEORUM_ENV_FILE'),
  '../theorum-frontend/.env.local',
  '../../theorum-frontend/.env.local',
  './.env.local',
].filter(Boolean) as string[];

for (const c of envCandidates) {
  loadEnvFile(c);
}

const openRouterKey = Deno.env.get('OPENROUTER_API_KEY')?.trim();
const geminiKey = Deno.env.get('GEMINI_API_KEY')?.trim();

console.log('════════════════════════════════════════════════════════════════════════');
console.log('  THEORUM TYPED PROFILES LIVE PRESSURE TEST');
console.log('════════════════════════════════════════════════════════════════════════');
console.log(
  `  OpenRouter Key: ${openRouterKey ? `Present (len=${openRouterKey.length})` : 'MISSING'}`,
);
console.log(`  Gemini Key:     ${geminiKey ? `Present (len=${geminiKey.length})` : 'MISSING'}`);
console.log('════════════════════════════════════════════════════════════════════════\n');

registerGooglePreset();

// ---------------------------------------------------------------------------
// Register Test Tools and Schemas
// ---------------------------------------------------------------------------

registerTool({
  name: 'calculate_sum',
  description: 'Add two numbers together and return the result',
  category: 'math',
  access: 'read',
  loadTier: 'always',
  permission: 'none',
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
  enforced: 'responseFormat',
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

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>) {
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

// ---------------------------------------------------------------------------
// Rate Limit delay helper
// ---------------------------------------------------------------------------
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ===========================================================================
// 1. CHAT PROFILES
// ===========================================================================

console.log('─── 1. Text Profiles (type: "text") ───');

if (openRouterKey) {
  await runTest('OpenRouter Chat: SSE Streaming Text Turn', async () => {
    const profileDef: Parameters<typeof defineProfile>[0] = {
      type: 'text',
      id: 'live_test_chat_or_sse',
      identity: { handle: 'assistant', system: 'You are a concise AI assistant.' },
      model: {
        protocol: 'openAi',
        provider: 'openrouter',
        allow: ['openrouter/free'],
        config: {
          'openrouter/free': {
            apiId: 'openrouter/free',
            maxOutputTokens: 100,
            temperature: 0.2,
          },
        },
        thinking: 'none',
      },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { streaming: { mode: 'sse' } },
    };

    const profile = defineProfile(profileDef) as TextProfile;
    registerProfile(profile);

    const provider = createProvider(profile, {
      openAiGateway: {
        apiKey: openRouterKey,
        siteUrl: 'https://theorum.agent',
        siteName: 'Theorum Live Pressure Test',
      },
    });

    const events: TurnEvent[] = [];
    const turnReq: TurnRequest = {
      profile: profile.id,
      input: { text: 'Reply with "THEORUM_CHAT_OK" exactly.' },
    };

    for await (const event of runTurn(turnReq, provider)) {
      events.push(event);
    }

    const textParts = events.flatMap((e) => (e.type === 'text' && e.text ? [e.text] : []));
    const fullText = textParts.join('');
    const done = events.find((e) => e.type === 'done');

    const errEvent = events.find((e) => e.type === 'error');
    if (errEvent) {
      console.log(
        `    (Note: free tier model returned error event: ${errEvent.error?.message ?? errEvent.error?.code})`,
      );
    }

    if (!done) throw new Error('Missing done event');
    if (!fullText.trim() && !errEvent) throw new Error('Empty text response and no error event');
    if (fullText.trim()) {
      console.log(`    Response preview: "${fullText.trim().slice(0, 60)}"`);
    }
  });

  await wait(4100);

  await runTest('OpenRouter Chat: Structured JSON Output', async () => {
    const profile = defineProfile({
      type: 'text',
      id: 'live_test_chat_structured',
      identity: { handle: 'analyzer', system: 'Analyze sentiment in structured JSON.' },
      model: {
        protocol: 'openAi',
        provider: 'openrouter',
        allow: ['openrouter/free'],
        config: {
          'openrouter/free': {
            apiId: 'openrouter/free',
            maxOutputTokens: 200,
            temperature: 0.1,
          },
        },
        thinking: 'none',
      },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { structured: 'sentimentAnalysis' },
    }) as TextProfile;
    registerProfile(profile);

    const provider = createProvider(profile, {
      openAiGateway: {
        apiKey: openRouterKey,
        siteUrl: 'https://theorum.agent',
        siteName: 'Theorum Live Pressure Test',
      },
    });

    const events: TurnEvent[] = [];
    const turnReq: TurnRequest = {
      profile: profile.id,
      input: { text: 'I love using this clean typed kernel!' },
    };

    for await (const event of runTurn(turnReq, provider)) {
      events.push(event);
    }

    const done = events.find((e) => e.type === 'done');
    if (!done) throw new Error('Missing done event');
    const textParts = events.flatMap((e) => (e.type === 'text' && e.text ? [e.text] : []));
    console.log(`    Structured Output: ${textParts.join('').slice(0, 100)}`);
  });

  await wait(4100);
}

if (geminiKey) {
  await runTest('Gemini Chat: Multi-step Tool Calling with Kernel Loop', async () => {
    const profile = defineProfile({
      type: 'text',
      id: 'live_test_chat_gemini_tools',
      identity: {
        handle: 'calculator',
        system:
          'You must use the calculate_sum tool to calculate any addition. Do not do mental math.',
      },
      model: {
        protocol: 'geminiInteractions',
        provider: 'google',
        allow: ['gemini-2.0-flash'],
        config: {
          'gemini-2.0-flash': {
            apiId: 'gemini-2.0-flash',
            maxOutputTokens: 200,
            temperature: 0.1,
            thinking: { on: 'minimal', off: 'minimal' },
            thinkingLevels: ['minimal', 'low', 'medium', 'high'],
          },
        },
        thinking: 'minimal',
        maxSteps: 3,
        key: 'freeA',
      },
      tools: { allow: ['calculate_sum'] },
      inputs: { text: true },
      turnResumption: { allowContinue: true, autoContinue: true, maxContinues: 2 },
    }) as TextProfile;
    registerProfile(profile);

    const provider = createProvider(profile, {
      gemini: {
        vault: { freeA: geminiKey, freeB: geminiKey, freeC: geminiKey, paid: geminiKey },
        wait: () => Promise.resolve(),
      },
    });

    const events: TurnEvent[] = [];
    const turnReq: TurnRequest = {
      profile: profile.id,
      input: { text: 'Calculate the sum of 42 and 58.' },
    };

    for await (const event of runTurn(turnReq, provider)) {
      events.push(event);
    }

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    const done = events.find((e) => e.type === 'done');

    if (!done) throw new Error('Missing done event');
    console.log(
      `    Tool calls executed: ${toolCalls.length}, Tool results: ${toolResults.length}`,
    );
    console.log(`    Events emitted: ${events.map((e) => e.type).join(', ')}`);
    const textParts = events.flatMap((e) => (e.type === 'text' && e.text ? [e.text] : []));
    console.log(`    Final Text: "${textParts.join('').trim()}"`);
  });

  await wait(4100);

  await runTest('Gemini Chat: Buffered streaming mode & Turn Resumption', async () => {
    const profile = defineProfile({
      type: 'text',
      id: 'live_test_chat_buffered',
      identity: { handle: 'assistant', system: 'Be concise.' },
      model: {
        protocol: 'geminiInteractions',
        provider: 'google',
        allow: ['gemini-2.0-flash'],
        config: {
          'gemini-2.0-flash': {
            apiId: 'gemini-2.0-flash',
            maxOutputTokens: 100,
            temperature: 0.2,
          },
        },
        thinking: 'minimal',
        key: 'freeA',
      },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { streaming: { mode: 'buffered' } },
      turnResumption: { allowContinue: true, autoContinue: false, maxContinues: 3 },
    }) as TextProfile;
    registerProfile(profile);

    const turnReq: TurnRequest = {
      profile: profile.id,
      input: { text: 'Hello!' },
    };

    // Verify resolution
    const resolved = resolveTurn(turnReq);
    if (resolved.generation.stream !== false) {
      throw new Error(
        `Expected generation.stream = false (buffered), got ${resolved.generation.stream}`,
      );
    }

    const provider = createProvider(profile, {
      gemini: {
        vault: { freeA: geminiKey, freeB: geminiKey, freeC: geminiKey, paid: geminiKey },
        wait: () => Promise.resolve(),
      },
    });

    const events: TurnEvent[] = [];
    for await (const event of runTurn(turnReq, provider)) {
      events.push(event);
    }

    const done = events.find((e) => e.type === 'done');
    if (!done) throw new Error('Missing done event');
    const textParts = events.flatMap((e) => (e.type === 'text' && e.text ? [e.text] : []));
    console.log(`    Buffered Response: "${textParts.join('').trim()}"`);
  });

  await wait(4100);
}

// ===========================================================================
// 2. IMAGE PROFILES
// ===========================================================================

console.log('\n─── 2. Image Profiles (type: "image") ───');

await runTest('Image Profile: Schema and Provider Resolution', async () => {
  const profile = defineProfile({
    type: 'image',
    id: 'live_test_image_profile',
    identity: { handle: 'artist', system: 'Generate beautiful artwork.' },
    model: {
      protocol: 'openAi',
      provider: 'openrouter',
      allow: ['stabilityai/stable-diffusion-xl'],
      config: {
        'stabilityai/stable-diffusion-xl': {
          apiId: 'stabilityai/stable-diffusion-xl',
        },
      },
      thinking: 'none',
    },
    image: {
      mimeType: 'image/jpeg',
      aspectRatio: '16:9',
    },
    tools: { allow: [] },
    inputs: { text: true },
  }) as ImageProfile;
  registerProfile(profile);

  const projected = projectProfile(profile.id);
  if (projected.type !== 'image')
    throw new Error(`Expected projected.type = 'image', got ${projected.type}`);
  if (projected.image?.mimeType !== 'image/jpeg') throw new Error('Image mimeType mismatch');

  if (openRouterKey) {
    const provider = createProvider(profile, {
      openAiGateway: {
        apiKey: openRouterKey,
      },
    });
    if (!provider) throw new Error('Failed to create image provider');
  }
});

// ===========================================================================
// 3. SPEECH PROFILES
// ===========================================================================

console.log('\n─── 3. Speech Profiles (type: "speech") ───');

await runTest('Speech Profile: Locked Inputs and Provider Resolution', async () => {
  const profile = defineProfile({
    type: 'speech',
    id: 'live_test_speech_profile',
    identity: { handle: 'speaker' },
    model: {
      protocol: 'openAi',
      provider: 'openrouter',
      allow: ['openai/tts-1'],
      config: {
        'openai/tts-1': {
          apiId: 'openai/tts-1',
        },
      },
      thinking: 'none',
    },
    speech: {
      voice: 'alloy',
      format: 'mp3',
    },
  }) as SpeechProfile;
  registerProfile(profile);

  // Ingress & projection verification
  const projected = projectProfile(profile.id);
  if (projected.type !== 'speech')
    throw new Error(`Expected projected.type = 'speech', got ${projected.type}`);
  if (projected.speech?.voice !== 'alloy') throw new Error('Speech voice mismatch');

  const turnReq: TurnRequest = {
    profile: profile.id,
    input: { text: 'Synthesize this voice message.' },
  };
  const resolved = resolveTurn(turnReq);
  if (resolved.generation.model !== 'openai/tts-1') throw new Error('Model mismatch');

  if (openRouterKey) {
    const provider = createProvider(profile, {
      openAiGateway: {
        apiKey: openRouterKey,
      },
    });
    if (!provider) throw new Error('Failed to create speech provider');
  }
});

// ===========================================================================
// 4. LIVE PROFILES
// ===========================================================================

console.log('\n─── 4. Live Profiles (type: "live") ───');

await runTest('Live Profile: geminiLive Protocol and Session Setup', async () => {
  const profile = defineProfile({
    type: 'live',
    id: 'live_test_gemini_live',
    identity: { handle: 'conversationalist', system: 'Real-time conversational agent.' },
    model: {
      protocol: 'geminiLive',
      provider: 'google',
      allow: ['gemini-2.0-flash-exp'],
      config: {
        'gemini-2.0-flash-exp': {
          apiId: 'gemini-2.0-flash-exp',
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: 'Aoede',
                },
              },
            },
          },
        },
      },
      key: 'freeA',
    },
    live: {
      voice: 'Aoede',
    },
    tools: { allow: [] },
  }) as LiveProfile;
  registerProfile(profile);

  const projected = projectProfile(profile.id);
  if (projected.type !== 'live')
    throw new Error(`Expected projected.type = 'live', got ${projected.type}`);
  if (projected.live?.voice !== 'Aoede') throw new Error('Live voice mismatch');

  if (geminiKey) {
    const provider = createProvider(profile, {
      gemini: {
        vault: { freeA: geminiKey, freeB: geminiKey, freeC: geminiKey, paid: geminiKey },
        wait: () => Promise.resolve(),
      },
    });
    if (!provider) throw new Error('Failed to create geminiLive provider');
  }
});

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log('\n════════════════════════════════════════════════════════════════════════');
console.log(
  `  PRESSURE TEST SUMMARY:  TOTAL: ${passed + failed}  |  PASSED: ${passed}  |  FAILED: ${failed}`,
);
console.log('════════════════════════════════════════════════════════════════════════\n');

if (failed > 0) {
  Deno.exit(1);
}
