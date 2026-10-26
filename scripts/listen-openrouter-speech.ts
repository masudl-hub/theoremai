#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-sys
/**
 * One-shot listen check: speech profiles through Theorem → OpenRouter → mp3 files.
 *
 *   OPENROUTER_API_KEY=… deno task listen:openrouter-speech
 *   OPENROUTER_API_KEY=… deno task listen:openrouter-speech -- fish
 *   OPENROUTER_API_KEY=… deno task listen:openrouter-speech -- elevenlabs
 */
import { runTurn } from '../src/kernel/default-scope.ts';
import { defineProfile } from '../src/kernel/registry/profiles.ts';
import type { SpeechProfile, TurnEvent } from '../src/kernel/types.ts';
import { hostOpenRouterKey, loadHostEnv, OPENROUTER_ENV } from './host-env.ts';
import { scriptProviderOptions } from './provider-options.ts';

loadHostEnv();
const key = hostOpenRouterKey();
if (!key) {
  console.error(`${OPENROUTER_ENV} missing`);
  Deno.exit(1);
}

const OUT_DIR = Deno.env.get('THEOREM_SPEECH_OUT')?.trim() || '/tmp/theorem-speech-listen';

type Run = {
  id: string;
  apiId: string;
  text: string;
  speech: { format: 'mp3'; voice?: string };
  file: string;
};

const ALL: readonly Run[] = [
  {
    id: 'fish',
    apiId: 'fish-audio/s2.1-pro-free:free',
    text: 'Your bonsai needs water today. The leaves look thirsty.',
    speech: { format: 'mp3' },
    file: '01-fish-s2.1-pro-free.mp3',
  },
  {
    id: 'elevenlabs',
    apiId: 'elevenlabs/eleven-v4-turbo',
    text: 'Hello from Theorem through OpenRouter. This is Eleven Labs reading aloud.',
    speech: { format: 'mp3', voice: 'george' },
    file: '02-elevenlabs-v4-turbo.mp3',
  },
];

const want = new Set(Deno.args.filter((a) => !a.startsWith('-')));
const runs = want.size ? ALL.filter((r) => want.has(r.id)) : ALL;
if (!runs.length) {
  console.error(
    `Unknown run id(s): ${[...want].join(', ')}. Known: ${ALL.map((r) => r.id).join(', ')}`,
  );
  Deno.exit(1);
}

async function collect(iter: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

function mediaFrom(events: TurnEvent[]): { mimeType: string; data: string } {
  for (const event of events) {
    if (event.type === 'media' && event.media?.data) return event.media;
  }
  const detail = events
    .filter((e) => e.type === 'error' || e.type === 'done')
    .map((e) => JSON.stringify(e));
  throw new Error(
    `no media; types=${events.map((e) => e.type).join(',')} detail=${detail.join(' | ')}`,
  );
}

await Deno.mkdir(OUT_DIR, { recursive: true });
console.log(`OpenRouter key present (len=${key.length}); out=${OUT_DIR}`);
console.log(`Runs: ${runs.map((r) => r.id).join(', ')}\n`);

let failed = 0;
for (const run of runs) {
  console.log(`── ${run.id}: ${run.apiId}`);
  try {
    const profile = defineProfile({
      type: 'speech',
      id: `listen_${run.id}_${crypto.randomUUID().slice(0, 8)}`,
      identity: { handle: 'speaker' },
      models: {
        tts: {
          protocol: 'openRouterOpenAi',
          provider: 'openrouter',
          apiId: run.apiId,
          efforts: { normal: 'none' },
        },
      },
      speech: run.speech,
    }) as SpeechProfile;

    const t0 = performance.now();
    const events = await collect(
      runTurn(
        { profile: profile.id, input: { text: run.text } },
        scriptProviderOptions(profile, {
          vault: { openrouter: key },
          openAiGateway: {
            siteUrl: 'https://theorem.agent',
            siteName: 'Theorem Speech Listen',
          },
        }),
      ),
    );
    const ms = Math.round(performance.now() - t0);
    const media = mediaFrom(events);
    const bytes = Uint8Array.from(atob(media.data), (c) => c.charCodeAt(0));
    const path = `${OUT_DIR}/${run.file}`;
    await Deno.writeFile(path, bytes);
    console.log(`  ✓ ${bytes.length} bytes mime=${media.mimeType} ${ms}ms → ${path}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${msg}`);
  }
}

if (failed) Deno.exit(1);
console.log('\nDone.');
