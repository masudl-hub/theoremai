import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertEquals, assertRejects } from '@std/assert';
import { runCommand } from '../../src/cli/commands/run.ts';
import { testProfileCommand } from '../../src/cli/commands/test.ts';
import { loadSetup } from '../../src/cli/setup.ts';
import type { NormalizedTurnRequest } from '../../src/kernel/types.ts';

const fixtures = (name: string) => pathToFileURL(join(Deno.cwd(), 'tests/fixtures', name)).href;
const kernel = (name: string) => pathToFileURL(join(Deno.cwd(), 'src/kernel', name)).href;

const ENTRY = `
import { registerProfile } from '${kernel('default-scope.ts')}';
import { defineProfile } from '${kernel('registry/profiles.ts')}';
import { geminiModels } from '${fixtures('models.ts')}';
import { fixtureHostOptions } from '${fixtures('registered-runner.ts')}';

export const theorem = {
  register: () => registerProfile(defineProfile({
    type: 'text',
    id: 'setup_cli_bot',
    identity: { handle: 'setup', system: 'test' },
    tools: { allow: [] },
    ...geminiModels('gemini35FlashLite'),
    inputs: { text: true },
    outputs: { structured: null },
    guardrails: { quota: { perDay: 50 } },
  })),
  provider: fixtureHostOptions({
    async *complete() {
      yield { type: 'text', text: 'wired' };
    },
  }),
  prepare: (turn) => {
    globalThis.setupPrepared.push(turn);
    return { ...turn, profile: 'not-the-named-profile', input: { text: 'prepared' } };
  },
};
`;

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: 'cli-setup-' });
  for (const [name, text] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, name), text);
  }
  return dir;
}

const prepared: NormalizedTurnRequest[] = [];
(globalThis as { setupPrepared?: NormalizedTurnRequest[] }).setupPrepared = prepared;

Deno.test('a setup file wires agents test and agents run: its registration, provider and prepare', async () => {
  const dir = await project({
    'studio.setup.ts': "export const entry = './app/entry.ts';",
  });
  await Deno.mkdir(join(dir, 'app'));
  await Deno.writeTextFile(join(dir, 'app/entry.ts'), ENTRY);
  const { setup, theorem } = await loadSetup(join(dir, 'studio.setup.ts'));
  assertEquals(setup.entry, './app/entry.ts');
  await theorem.register?.();

  const tested = await testProfileCommand('setup_cli_bot', {
    lite: true,
    provider: theorem.provider,
    prepare: theorem.prepare,
  });
  assertEquals(tested, true);
  const ran = await runCommand({
    profile: 'setup_cli_bot',
    prompt: 'from the command line',
    provider: theorem.provider,
    prepare: theorem.prepare,
  });
  assertEquals(ran, true);
  assertEquals(prepared.at(-1)?.input.text, 'from the command line');
  assertEquals(prepared.at(-1)?.profile, 'setup_cli_bot');
});

Deno.test('agents run fails without a provider and when the turn fails', async () => {
  const dir = await project({ 'studio.setup.ts': "export const entry = './entry.ts';" });
  await Deno.writeTextFile(join(dir, 'entry.ts'), ENTRY);
  const { theorem } = await loadSetup(join(dir, 'studio.setup.ts'));
  await theorem.register?.();
  assertEquals(await runCommand({ profile: 'setup_cli_bot', prompt: 'no keys' }), false);
  const failing = await runCommand({
    profile: 'setup_cli_bot',
    prompt: 'fails',
    provider: theorem.provider,
    prepare: () => {
      throw new Error('prepare refused');
    },
  });
  assertEquals(failing, false);
});

Deno.test('a setup that cannot be loaded says what is missing', async () => {
  const legacy = await project({ 'studio.setup.ts': 'export const provider = {};' });
  await assertRejects(
    () => loadSetup(join(legacy, 'studio.setup.ts')),
    Error,
    "exports `provider`. The app's wiring moved to its entry",
  );
  const noEntry = await project({ 'studio.setup.ts': 'export const host = {};' });
  await assertRejects(() => loadSetup(join(noEntry, 'studio.setup.ts')), Error, 'names no entry');
  const noTheorem = await project({
    'studio.setup.ts': "export const entry = './entry.ts';",
    'entry.ts': 'export const other = 1;',
  });
  await assertRejects(
    () => loadSetup(join(noTheorem, 'studio.setup.ts')),
    Error,
    './entry.ts exports no `theorem`',
  );
});
