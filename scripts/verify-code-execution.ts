#!/usr/bin/env -S deno run --allow-net --allow-read

/**
 * Host live harness for Interactions `codeExecution`.
 *
 * Uses the CLI matrix / test APIs (profiles + explicit ModelProvider) plus
 * asserted cases the matrix prompt does not guarantee (error, multi-exec,
 * media, batch, structured pairing).
 */

import { executeSingleTest, testProfileCommand } from '../src/cli/commands/test.ts';
import { synthesizeMatrixCombos } from '../src/cli/matrix/synthesizer.ts';
import { runTurn } from '../src/kernel/engine/runner.ts';
import { defineProfile, getProfile, registerProfile } from '../src/kernel/registry/profiles.ts';
import { registerStructured } from '../src/kernel/registry/schemas.ts';
import type {
  BuiltinToolId,
  ModelBinding,
  ModelProvider,
  TurnEvent,
  TurnRequest,
} from '../src/kernel/types.ts';
import { registerGooglePreset } from '../src/presets/google.ts';
import { createProvider } from '../src/providers/create-provider.ts';

function valueAfterFlag(flag: string): string | undefined {
  const idx = Deno.args.indexOf(flag);
  if (idx < 0) return undefined;
  return Deno.args[idx + 1];
}

const apiKey = valueAfterFlag('--api-key');
const modelId = valueAfterFlag('--model') ?? 'gemini-2.5-flash';
const thinkingLevel = valueAfterFlag('--thinking') ?? 'high';

if (!apiKey) {
  console.error('missing --api-key (host must pass credentials; THEOREM does not read env)');
  Deno.exit(1);
}

registerGooglePreset();

registerStructured('liveCodeAnswer', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: {
      answer: { type: 'number' },
      usedCode: { type: 'boolean' },
    },
    required: ['answer', 'usedCode'],
  },
});

const PROFILE = 'live.code_execution';
const PROFILE_STRUCTURED = 'live.code_execution.structured';

function effortAlias(level: string): string {
  if (level === 'high') return 'high';
  if (level === 'medium') return 'medium';
  if (level === 'low') return 'low';
  return 'normal';
}

const turnEffort = effortAlias(thinkingLevel);

function flashBinding(builtInTools: BuiltinToolId[]): ModelBinding {
  return {
    protocol: 'geminiInteractions',
    provider: 'google',
    apiId: modelId,
    efforts: { normal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
    defaultEffort: turnEffort,
    allowEffortSelect: true,
    summaries: true,
    maxOutputTokens: 4096,
    temperature: 0.2,
    builtInTools,
  };
}

registerProfile(
  defineProfile({
    type: 'text',
    id: PROFILE,
    identity: {
      handle: 'code-exec-live',
      system:
        'You have code_execution. Prefer executing Python for arithmetic, plots, and failures. Be concise.',
    },
    models: { flash: flashBinding(['codeExecution', 'googleSearch']) },
    defaultModel: 'flash',
    maxSteps: 3,
    key: 'slotA',
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 1000 } },
  }),
);

registerProfile(
  defineProfile({
    type: 'text',
    id: PROFILE_STRUCTURED,
    identity: {
      handle: 'code-exec-structured',
      system: 'Use code_execution, then answer only via the JSON schema.',
    },
    models: { flash: flashBinding(['codeExecution']) },
    defaultModel: 'flash',
    maxSteps: 1,
    key: 'slotA',
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { structured: 'liveCodeAnswer' },
    guardrails: { quota: { perDay: 1000 } },
  }),
);

const provider: ModelProvider = createProvider(getProfile(PROFILE), {
  gemini: {
    vault: { slotA: apiKey, slotB: apiKey, slotC: apiKey, paid: apiKey },
    wait: () => Promise.resolve(),
  },
});

interface CaseResult {
  name: string;
  passed: boolean;
  detail: string;
}

function collect(events: TurnEvent[]) {
  const evidence = events.filter((e) => e.type === 'evidence').map((e) => e.evidence);
  const calls = evidence.filter((e) => e?.kind === 'code_execution_call');
  const results = evidence.filter((e) => e?.kind === 'code_execution_result');
  const media = events.filter((e) => e.type === 'media');
  const errors = events.filter((e) => e.type === 'error');
  const structured = events.find((e) => e.type === 'structured')?.structured;
  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.text ?? '')
    .join('');
  return { calls, results, media, errors, structured, text, events };
}

async function runCase(
  name: string,
  req: TurnRequest,
  assert: (got: ReturnType<typeof collect>) => string | undefined,
): Promise<CaseResult> {
  console.log(`\n▶ ASSERTED: ${name}`);
  const events: TurnEvent[] = [];
  try {
    for await (const event of runTurn(req, provider)) {
      events.push(event);
      if (event.type === 'evidence' && event.evidence?.kind?.startsWith('code_execution')) {
        const e = event.evidence;
        console.log(
          `  evidence ${e.kind} code=${(e.code ?? '').slice(0, 60)} result=${(e.result ?? '').slice(0, 60)} isError=${String(e.isError)}`,
        );
      } else if (event.type === 'media') {
        console.log(`  media ${event.media?.mimeType} len=${event.media?.data?.length ?? 0}`);
      } else if (event.type === 'structured') {
        console.log(`  structured ${JSON.stringify(event.structured)}`);
      } else if (event.type === 'error') {
        console.log(`  error ${event.error}`);
      } else if (event.type === 'text' && event.text) {
        console.log(`  text ${JSON.stringify(event.text).slice(0, 100)}`);
      }
    }
  } catch (err) {
    return { name, passed: false, detail: String(err) };
  }
  const got = collect(events);
  const fail = assert(got);
  if (fail) {
    console.log(`  ✗ ${fail}`);
    return { name, passed: false, detail: fail };
  }
  console.log('  ✓ passed');
  return { name, passed: true, detail: 'ok' };
}

const asserted: CaseResult[] = [];

// --- CLI matrix (host registers profile + passes provider) ---
console.log(`\n${'='.repeat(70)}\n CLI MATRIX via testProfileCommand\n${'='.repeat(70)}`);
console.log(
  'matrix combos:',
  synthesizeMatrixCombos(getProfile(PROFILE))
    .map((c) => c.name)
    .join(' | '),
);
const matrixOk = await testProfileCommand(PROFILE, {
  matrix: true,
  provider,
});
asserted.push({
  name: 'cli matrix (no provider error)',
  passed: matrixOk,
  detail: matrixOk ? 'all matrix rows completed without error events' : 'matrix failed',
});

// Prefer-tool stress with codeExecution forced on (search may also be on).
asserted.push(
  await (async () => {
    const req = {
      profile: PROFILE,
      model: 'flash',
      effort: turnEffort,
      input: {
        text: 'Use code_execution once: print(sum(range(1, 11))). Reply with only the number.',
      },
    };
    const res = await executeSingleTest(req, `${PROFILE} [CLI executeSingleTest happy]`, provider);
    return {
      name: 'cli executeSingleTest happy',
      passed: res.passed,
      detail: res.error || 'ok',
    };
  })(),
);

asserted.push(
  await runCase(
    'stream arithmetic',
    {
      profile: PROFILE,
      stream: true,
      effort: turnEffort,
      input: { text: 'Use code_execution: print(sum(range(1, 101))). Reply with only the number.' },
    },
    (got) => {
      if (got.errors.length) return `error event: ${got.errors[0]?.error}`;
      if (got.calls.length < 1) return 'missing code_execution_call';
      if (got.results.length < 1) return 'missing code_execution_result';
      if (got.results.some((r) => r?.isError === true)) return 'unexpected isError=true';
      if (!got.text.includes('5050') && !got.results.some((r) => r?.result?.includes('5050'))) {
        return `expected 5050, text=${JSON.stringify(got.text)}`;
      }
      return undefined;
    },
  ),
);

asserted.push(
  await runCase(
    'batch arithmetic',
    {
      profile: PROFILE,
      stream: false,
      effort: turnEffort,
      input: { text: 'Use code_execution: print(sum(range(1, 51))). Reply with only the number.' },
    },
    (got) => {
      if (got.errors.length) return `error event: ${got.errors[0]?.error}`;
      if (got.calls.length < 1) return 'missing call in batch';
      if (got.results.length < 1) return 'missing result in batch';
      if (!got.text.includes('1275') && !got.results.some((r) => r?.result?.includes('1275'))) {
        return `expected 1275, text=${JSON.stringify(got.text)}`;
      }
      return undefined;
    },
  ),
);

asserted.push(
  await runCase(
    'sandbox error isError=true',
    {
      profile: PROFILE,
      effort: turnEffort,
      input: {
        text:
          'Use code_execution exactly once to evaluate 1/0 in Python. ' +
          'Then briefly say whether the sandbox reported an error.',
      },
    },
    (got) => {
      if (got.errors.length) return `turn error: ${got.errors[0]?.error}`;
      if (got.calls.length < 1) return 'missing call';
      if (!got.results.some((r) => r?.isError === true)) {
        return `expected isError=true, results=${JSON.stringify(
          got.results.map((r) => ({ isError: r?.isError, result: r?.result?.slice(0, 80) })),
        )}`;
      }
      return undefined;
    },
  ),
);

asserted.push(
  await runCase(
    'multi-exec in one turn',
    {
      profile: PROFILE,
      effort: turnEffort,
      input: {
        text:
          'Use code_execution at least twice. First print(17*19). Then print(math.factorial(8)) ' +
          '(import math). Report both numbers.',
      },
    },
    (got) => {
      if (got.errors.length) return `error: ${got.errors[0]?.error}`;
      if (got.calls.length < 2) return `expected >=2 calls, got ${got.calls.length}`;
      if (got.results.length < 2) return `expected >=2 results, got ${got.results.length}`;
      const joined = `${got.text}\n${got.results.map((r) => r?.result ?? '').join('\n')}`;
      if (!joined.includes('323')) return `missing 323 in ${JSON.stringify(joined).slice(0, 200)}`;
      if (!joined.includes('40320'))
        return `missing 40320 in ${JSON.stringify(joined).slice(0, 200)}`;
      return undefined;
    },
  ),
);

asserted.push(
  await runCase(
    'matplotlib media',
    {
      profile: PROFILE,
      effort: turnEffort,
      input: {
        text:
          'Use code_execution with matplotlib to plot y=[1,3,2] and show the figure. ' +
          'Then say "plotted" in one word.',
      },
    },
    (got) => {
      if (got.errors.length) return `error: ${got.errors[0]?.error}`;
      if (got.calls.length < 1) return 'missing call';
      if (got.media.length < 1) {
        return `expected media image from plot, got media=${got.media.length} results=${got.results.length}`;
      }
      if (!got.media.some((m) => m.media?.mimeType?.startsWith('image/'))) {
        return `expected image/* media, got ${got.media.map((m) => m.media?.mimeType).join(',')}`;
      }
      return undefined;
    },
  ),
);

asserted.push(
  await runCase(
    'codeExecution + googleSearch',
    {
      profile: PROFILE,
      effort: turnEffort,
      input: {
        text:
          'Search for the atomic number of carbon, then use code_execution to print that number times 2. ' +
          'Reply with only the final number.',
      },
    },
    (got) => {
      if (got.errors.length) return `error: ${got.errors[0]?.error}`;
      if (got.calls.length < 1) return 'missing code call';
      // Search may appear as grounding/evidence; code result should include 12.
      const joined = `${got.text}\n${got.results.map((r) => r?.result ?? '').join('\n')}`;
      if (!joined.includes('12')) return `expected 12, got ${JSON.stringify(joined).slice(0, 200)}`;
      return undefined;
    },
  ),
);

asserted.push(
  await runCase(
    'structured + codeExecution (API may reject)',
    {
      profile: PROFILE_STRUCTURED,
      effort: turnEffort,
      input: {
        text: 'Use code_execution to compute 21*2. Return JSON with answer and usedCode=true.',
      },
    },
    (got) => {
      // Pairing is undocumented: fail only on turn errors or missing code entirely.
      if (got.errors.length) {
        return `API/turn error (pairing unsupported?): ${got.errors[0]?.error}`;
      }
      if (got.calls.length < 1) return 'no code call';
      if (got.structured && typeof got.structured === 'object') {
        return undefined;
      }
      return undefined; // code ran; structured optional for this probe
    },
  ),
);

console.log(`\n${'='.repeat(70)}\n LIVE CODE EXECUTION SUMMARY\n${'='.repeat(70)}`);
let failed = 0;
for (const r of asserted) {
  console.log(`  ${r.passed ? '✓' : '✗'} ${r.name.padEnd(42)} ${r.detail}`);
  if (!r.passed) failed += 1;
}
console.log(`${'='.repeat(70)}`);
console.log(`model=${modelId} thinking=${thinkingLevel} failed=${failed}/${asserted.length}`);
Deno.exit(failed > 0 ? 1 : 0);
