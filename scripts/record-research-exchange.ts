#!/usr/bin/env -S deno run --allow-net --allow-sys --allow-env --allow-read --allow-write
/**
 * Runs the research cookbook for real until the turn is worth shipping as the Goals opener,
 * then writes its Studio `.trace.json` fixture.
 *
 *   THEOREM_ENV_FILE=path/to/keys.env deno run -A scripts/record-research-exchange.ts
 *
 * Uses {@link judgeResearchOpening}. Runs the cookbook profile as compiled (Gemini
 * `gemini-3.8-flash`, medium default). Override with `THEOREM_RECORD_MODEL`. Theorem
 * itself never reads env; this script alone fills the vault.
 */
import type { ProfileDefinition } from '@theoremjs/agents';
import type { TranscriptBlock } from '@theoremjs/agents/interface';
import type { TraceRecord } from '../src/observability/trace-record.ts';
import { judgeResearchOpening } from '../studio/cookbooks/research-opening.ts';
import { ON_OWN_KEYS } from '../studio/lent-keys.ts';
import {
  COOKBOOK_TOOL_HANDLERS,
  compileWorkspace,
  createResearchWorkspace,
  openingFromRecords,
  RESEARCH_FIRST_TURN_PROMPT,
  workspaceRunAgent,
} from '../studio/mod.ts';
import { runtimeProvider, type StudioRuntime, studioScope } from '../studio/runtime-scope.ts';
import { loadHostEnv } from './host-env.ts';

const OUT = new URL('../studio/cookbooks/fixtures/research.trace.json', import.meta.url);
const RECORD_MODEL = Deno.env.get('THEOREM_RECORD_MODEL')?.trim() || 'gemini-3.8-flash';
/** OpenRouter slug (`vendor/model`) or explicit `openrouter` / `openrouter/…`. */
function viaOpenRouter(apiId: string): boolean {
  const flag = Deno.env.get('THEOREM_RECORD_PROVIDER')?.trim().toLowerCase();
  if (flag === 'openrouter') return true;
  if (flag === 'gemini') return false;
  return apiId.includes('/') || apiId.startsWith('openrouter');
}
const ATTEMPTS = Math.max(1, Number(Deno.env.get('THEOREM_RECORD_ATTEMPTS') ?? 10));
const BUSY_WAIT_MS = Math.max(0, Number(Deno.env.get('THEOREM_RECORD_BUSY_WAIT_MS') ?? 20_000));

loadHostEnv();

function envKey(...names: string[]): string | undefined {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

const geminiKeys = [
  'GEMINI_API_KEY_FREE_A',
  'GEMINI_API_KEY_FREE_B',
  'GEMINI_API_KEY_FREE_C',
  'GEMINI_API_KEY_FREE_D',
  'GEMINI_API_KEY_FREE_E',
  'GEMINI_API_KEY',
  'THEOREM_VAULT_GEMINI',
]
  .map((name) => Deno.env.get(name)?.trim())
  .filter((key): key is string => !!key);

const openrouter = envKey('OPENROUTER_API_KEY', 'THEOREM_VAULT_OPENROUTER');
const typesafe = envKey('theoremai.typesafe_api_key', 'TYPESAFE_API_KEY', 'THEOREM_VAULT_TYPESAFE');
const useOpenRouter = viaOpenRouter(RECORD_MODEL);

if (useOpenRouter && !openrouter) {
  console.error('Need OPENROUTER_API_KEY (or THEOREM_VAULT_OPENROUTER) for this record model.');
  Deno.exit(1);
}
if (!useOpenRouter && !geminiKeys.length) {
  console.error('Need a Gemini key in the env file or shell.');
  Deno.exit(1);
}

const workspace = createResearchWorkspace();
const compiled = compileWorkspace(workspace, ON_OWN_KEYS);
if (!compiled.ok) {
  console.error('Research workspace did not compile:', compiled.issues);
  Deno.exit(1);
}
const scout = workspaceRunAgent(compiled, 'research.scout');
if (!scout) {
  console.error('No research.scout in the compiled workspace.');
  Deno.exit(1);
}
const run = scout;

function withRecordModel(definition: ProfileDefinition, apiId: string): ProfileDefinition {
  if (definition.type !== 'text') return definition;
  const current = definition.defaultModel ? definition.models[definition.defaultModel] : undefined;
  if (
    current &&
    'apiId' in current &&
    current.apiId === apiId &&
    !Deno.env.get('THEOREM_RECORD_MODEL')?.trim()
  ) {
    return definition;
  }
  const open = Object.values(definition.models).find(
    (binding) =>
      binding &&
      'apiId' in binding &&
      (binding.apiId === apiId ||
        binding.apiId === 'openrouter/free' ||
        binding.apiId.startsWith('google/')),
  );
  const gemini = Object.values(definition.models).find(
    (binding) => binding && 'provider' in binding && binding.provider === 'gemini',
  );
  const openRoute = viaOpenRouter(apiId);
  const template = openRoute ? (open ?? gemini) : (gemini ?? open);
  if (!template || !('apiId' in template)) return definition;
  const record = {
    ...template,
    apiId,
    keySlot: openRoute ? (template.keySlot ?? 'openrouter') : (template.keySlot ?? 'gemini'),
  };
  return {
    ...definition,
    defaultModel: definition.defaultModel ?? 'gemini',
    models: {
      ...definition.models,
      [definition.defaultModel ?? 'gemini']: record,
    },
  };
}

function runtimeFor(attempt: number): StudioRuntime {
  return {
    mode: 'byok',
    toolHandlers: COOKBOOK_TOOL_HANDLERS,
    providers: {
      vault: {
        ...(useOpenRouter
          ? { openrouter }
          : { gemini: geminiKeys[(attempt - 1) % Math.max(geminiKeys.length, 1)] }),
        typesafe,
      },
    },
  };
}

function toolCalls(opening: readonly TranscriptBlock[]) {
  return opening.flatMap((block) => (block.kind === 'tool' ? [block] : []));
}

async function recordOnce(
  attempt: number,
): Promise<{ records: TraceRecord[]; opening: TranscriptBlock[] }> {
  const definition = withRecordModel(run.profile, RECORD_MODEL);
  const runtime = runtimeFor(attempt);
  const { scope, profile: registered } = await studioScope(
    definition,
    run.customTools,
    run.structured,
    runtime,
    run.dependencies,
  );
  const records: TraceRecord[] = [];
  const via = useOpenRouter ? 'openrouter' : 'gemini';
  const keyN = useOpenRouter ? 1 : ((attempt - 1) % Math.max(geminiKeys.length, 1)) + 1;
  console.log(
    `\nAttempt ${String(attempt)}/${String(ATTEMPTS)} on ${RECORD_MODEL} via ${via} (key ${String(keyN)}): ${RESEARCH_FIRST_TURN_PROMPT.slice(0, 56)}…`,
  );
  for await (const event of scope.runTurn(
    { profile: registered.id, input: { text: RESEARCH_FIRST_TURN_PROMPT } },
    runtimeProvider(runtime, scope, registered),
    {
      write: (record) => {
        records.push(record);
        return Promise.resolve();
      },
    },
  )) {
    if (event.type === 'tool' && event.tool.phase === 'running') {
      console.log(`  tool ${event.tool.name}`);
    }
    if (
      event.type === 'tool' &&
      (event.tool.phase === 'complete' || event.tool.phase === 'error')
    ) {
      console.log(`    → ${event.tool.phase}`);
    }
    if (event.type === 'error') {
      console.error(`  error ${event.errorKind}: ${event.error}`);
    }
    if (event.type === 'done') console.log(`  stop ${event.stop.kind}`);
  }
  return { records, opening: openingFromRecords(records) };
}

let bestWhy = 'no attempts';
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const { records, opening } = await recordOnce(attempt);
  if (records.length === 0) {
    bestWhy = 'no trace records';
    continue;
  }
  const calls = toolCalls(opening);
  const complete = calls.filter((b) => b.tool.state?.phase === 'complete').length;
  const failed = calls.filter((b) => b.tool.state?.phase === 'error').length;
  console.log(
    `  blocks: ${opening.map((b) => b.kind).join(', ')} | tools ${String(complete)} ok / ${String(failed)} err`,
  );
  const providerBusy = opening.some(
    (block) =>
      block.kind === 'error' &&
      /busy|rate.?limit|high demand|quota/i.test(
        `${'error' in block ? String(block.error) : ''} ${'message' in block ? String(block.message) : ''}`,
      ),
  );
  const verdict = judgeResearchOpening(opening);
  if (!verdict.ok) {
    bestWhy = verdict.why;
    console.log(`  refused: ${verdict.why}`);
    if (providerBusy && attempt < ATTEMPTS && BUSY_WAIT_MS > 0) {
      console.log(`  waiting ${String(BUSY_WAIT_MS)}ms for capacity…`);
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
    }
    continue;
  }
  await Deno.mkdir(new URL('.', OUT), { recursive: true });
  await Deno.writeTextFile(OUT, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`\nWrote ${OUT.pathname}`);
  console.log(`tools: ${verdict.tools.join(', ')}`);
  console.log(`outcomes: ${String(verdict.complete)} complete, ${String(verdict.failed)} error`);
  console.log(`blocks: ${verdict.kinds.join(', ')}`);
  Deno.exit(0);
}

console.error(`No take met the bar after ${String(ATTEMPTS)} attempts (last: ${bestWhy}).`);
Deno.exit(1);
