import '../fixtures/test-host.ts';
import { assertEquals, assertExists, assertThrows } from '@std/assert';
import { listProfilesCommand, showProfileCommand } from '../../src/cli/commands/profile.ts';
import { runCommand } from '../../src/cli/commands/run.ts';
import { executeSingleTest, testProfileCommand } from '../../src/cli/commands/test.ts';
import { main } from '../../src/cli/index.ts';
import {
  FIXTURE_CSV_BASE64,
  FIXTURE_PDF_BASE64,
  FIXTURE_PNG_BASE64,
  FIXTURE_WAV_BASE64,
  getFixtureForMime,
} from '../../src/cli/matrix/fixtures.ts';
import {
  buildCustomTurnRequest,
  synthesizeLiteCombo,
  synthesizeMatrixCombos,
  synthesizeStressCombo,
} from '../../src/cli/matrix/synthesizer.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, Profile, TurnEvent } from '../../src/kernel/types.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';

const testProfile: Profile = {
  type: 'text',
  id: 'test-agent',
  identity: { handle: 'test-agent', system: 'You are a test agent.' },
  models: {
    fast: HOST_BINDINGS.gemini35FlashLite,
    smart: HOST_BINDINGS.gemini31ProPreview,
  },
  defaultModel: 'fast',
  allowModelSelect: true,
  key: 'slotA',
  tools: { allow: [] },
  inputs: {
    text: true,
    attachments: { accept: ['image/png', 'application/pdf', 'text/csv', 'text/plain'] },
    voice: { accept: ['audio/wav'] },
    maxFiles: 5,
    maxBytes: 10_000_000,
    maxTurnBytes: 15_000_000,
  },
  outputs: { structured: null },
  guardrails: { quota: { perDay: 50 } },
};

Deno.test('fixtures produce valid base64 buffers', () => {
  assertExists(FIXTURE_PNG_BASE64);
  assertExists(FIXTURE_WAV_BASE64);
  assertExists(FIXTURE_PDF_BASE64);
  assertExists(FIXTURE_CSV_BASE64);

  const png = getFixtureForMime('image/png');
  assertEquals(png?.mimeType, 'image/png');
  assertEquals(png?.data, FIXTURE_PNG_BASE64);

  const pdf = getFixtureForMime('application/pdf');
  assertEquals(pdf?.mimeType, 'application/pdf');

  const csv = getFixtureForMime('text/csv');
  assertEquals(csv?.mimeType, 'text/csv');

  const txt = getFixtureForMime('text/plain');
  assertEquals(txt?.mimeType, 'text/plain');

  const wav = getFixtureForMime('audio/wav');
  assertEquals(wav?.mimeType, 'audio/wav');

  const unknown = getFixtureForMime('unknown/mime');
  assertEquals(unknown, undefined);
});

Deno.test('synthesizeLiteCombo constructs minimal fast request', () => {
  const req = synthesizeLiteCombo(testProfile);
  assertEquals(req.profile, 'test-agent');
  assertEquals(req.model, 'fast');
  assertEquals(req.input?.attachments, undefined);
  assertEquals(req.input?.voice, undefined);
});

Deno.test('synthesizeStressCombo constructs smart mode with multimodal attachments', () => {
  const req = synthesizeStressCombo(testProfile);
  assertEquals(req.profile, 'test-agent');
  assertEquals(req.model, 'smart');
  assertEquals(req.input?.attachments?.length, 1);
  assertEquals(req.input?.voice?.length, 1);
});

Deno.test('synthesizeMatrixCombos generates lite + stress rows', () => {
  const matrix = synthesizeMatrixCombos(testProfile);
  assertEquals(matrix.length, 2);
  assertEquals(matrix[0].name, 'Lite (connectivity)');
  assertEquals(matrix[1].name, 'Stress (all modalities + primary tools)');
});

Deno.test('buildCustomTurnRequest requires grounding flags on the model', () => {
  assertThrows(
    () =>
      buildCustomTurnRequest(testProfile, {
        mode: 'fast',
        map: true,
        search: false,
      }),
    Error,
    'googleMaps',
  );
  const withMaps: Profile = {
    ...testProfile,
    type: 'text',
    models: {
      ...testProfile.models,
      fast: {
        ...testProfile.models.fast,
        builtInTools: ['googleMaps'],
      },
    },
    tools: testProfile.tools,
    inputs: testProfile.inputs,
  };
  const req = buildCustomTurnRequest(withMaps, { mode: 'fast', map: true });
  assertEquals(req.model, 'fast');
});

Deno.test('synthesizer handles all tool combinations, fallbacks, and reasoning configurations', () => {
  const customSelectProfile: Profile = {
    ...testProfile,
    type: 'text',
    models: {
      gemini35FlashLite: HOST_BINDINGS.gemini35FlashLite,
      gemini31ProPreview: {
        ...HOST_BINDINGS.gemini31ProPreview,
        builtInTools: ['googleMaps'],
      },
    },
    defaultModel: 'gemini35FlashLite',
    allowModelSelect: true,
    tools: { allow: [] },
    inputs: {
      text: true,
      attachments: { accept: ['unknown/custom-mime'] },
      voice: { accept: [] },
      maxFiles: 5,
      maxBytes: 10_000_000,
      maxTurnBytes: 15_000_000,
    },
  };
  const req1 = synthesizeStressCombo(customSelectProfile);
  assertEquals(req1.model, 'gemini31ProPreview');
  assertEquals(req1.input?.attachments?.length, 1);
  assertEquals(req1.input?.voice, undefined);

  const noSelectProfile: Profile = {
    ...testProfile,
    type: 'text',
    allowModelSelect: false,
    tools: { allow: ['ask_user'] },
    inputs: {
      text: true,
      attachments: { accept: [] },
      voice: { accept: [] },
      maxFiles: 5,
      maxBytes: 10_000_000,
      maxTurnBytes: 15_000_000,
    },
  };
  const req2 = synthesizeStressCombo(noSelectProfile);
  assertEquals(req2.model, undefined);
  assertEquals(req2.input?.attachments, undefined);

  const liteReq = buildCustomTurnRequest(testProfile, { lite: true });
  assertEquals(liteReq.model, 'fast');

  assertThrows(
    () => buildCustomTurnRequest(testProfile, { search: true, map: true }),
    Error,
    'googleSearch',
  );
  const withSearch: Profile = {
    ...testProfile,
    type: 'text',
    models: {
      ...testProfile.models,
      fast: {
        ...testProfile.models.fast,
        builtInTools: ['googleSearch'],
      },
    },
    tools: testProfile.tools,
    inputs: testProfile.inputs,
  };
  const searchOk = buildCustomTurnRequest(withSearch, { search: true });
  assertEquals(searchOk.profile, testProfile.id);
});

Deno.test('registered host profiles render cards', () => {
  assertEquals(getProfile('chat').id, 'chat');
  assertEquals(getProfile('formatter').id, 'formatter');
  assertEquals(getProfile('selector').id, 'selector');
  assertEquals(getProfile('pinned').id, 'pinned');

  listProfilesCommand();
  showProfileCommand('chat');
  showProfileCommand('non_existent');
});

Deno.test('runCommand exercises all stream event types and failure handling', async () => {
  const mockEvents: TurnEvent[] = [
    { type: 'thought', text: 'Thinking step...' },
    { type: 'text', text: 'Hello human!' },
    { type: 'tool', tool: { name: 'calculator', arguments: { expr: '2+2' } } },
    { type: 'structured', structured: { result: 4 } },
    { type: 'media', media: { mimeType: 'image/png', data: 'abc' } },
    { type: 'error', error: 'Non-fatal error' },
    { type: 'done' },
  ];

  const mockProvider: ModelProvider = {
    async *complete() {
      for (const ev of mockEvents) {
        yield ev;
      }
    },
  };

  // Run with mock provider via executeSingleTest
  const res = await executeSingleTest(
    { profile: 'chat', input: { text: 'test' } },
    'Host Profile Event Stream Test',
    mockProvider,
  );
  assertEquals(res.passed, false); // because error event was yielded

  // Test runCommand on OpenAI/OpenRouter profile
  const { registerProfile, defineProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'openrouter_run_bot',
      ...geminiModels('sonar'),
      inputs: { text: true },
      outputs: { structured: null },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  await runCommand({
    profile: 'openrouter_run_bot',
    prompt: 'test openrouter',
    provider: {
      async *complete() {
        yield { type: 'text', text: 'openrouter response' };
      },
    },
  });

  // Test runCommand when runTurn throws exception (e.g. text input disabled)
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'no_text_bot',
      ...geminiModels('gemini35FlashLite'),
      inputs: { text: false },
      outputs: { structured: null },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  await runCommand({
    profile: 'no_text_bot',
    prompt: 'should throw',
    provider: mockProvider,
  });
});

Deno.test('testProfileCommand and CLI main router test flag parsing and commands', async () => {
  // Test profile commands via main()
  await main(['profile', 'list']);
  await main(['profile', 'show', 'chat']);
  await main(['profile', 'show', '--profile', 'selector']);
  await main(['help']);
  await main(['--help']);
  await main(['-h']);

  // Invalid profile
  const failedRes = await testProfileCommand('non_existent');
  assertEquals(failedRes, false);

  // Missing profile
  const noProfileRes = await testProfileCommand(undefined, { all: false });
  assertEquals(noProfileRes, false);
});

Deno.test('testProfileCommand --all skips profiles that run no model turn', async () => {
  registerProfile({ type: 'host', id: 'cli_all_host', tools: { allow: [] } });
  registerProfile(
    defineProfile({
      type: 'decision',
      id: 'cli_all_decision',
      identity: { handle: 'Decision' },
      models: { jev: { apiId: 'jev-latest', timeoutMs: 1000 } },
      inputs: { state: 'json', maxStateBytes: 1000 },
      decision: { contract: 'test.v1' },
    }),
  );
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => printed.push(args.join(' '));
  try {
    await testProfileCommand(undefined, {
      all: true,
      lite: true,
      provider: {
        async *complete() {
          yield { type: 'text', text: 'ok' };
        },
      },
    });
  } finally {
    console.log = log;
  }
  const tested = printed.flatMap((line) => /Profile:\s+(\S+)/.exec(line)?.[1] ?? []);
  assertEquals(tested.includes('chat'), true);
  assertEquals(tested.includes('cli_all_host'), false);
  assertEquals(tested.includes('cli_all_decision'), false);
});

Deno.test('executeSingleTest sums every call and labels totals that include estimates', async () => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => printed.push(args.join(' '));
  try {
    const res = await executeSingleTest(
      { profile: 'chat', input: { text: 'test' } },
      'Token total',
      {
        async *complete() {
          yield { type: 'text', text: 'hello world' };
          yield { type: 'tokens', tokens: { input: 0, output: 4, total: 4, estimated: ['input'] } };
        },
      },
    );
    assertEquals(res.passed, true);
    assertEquals(res.tokens?.estimated, ['input']);
    assertEquals(res.tokens?.output, 4);
    const status = printed.find((line) => line.includes('STATUS: PASSED')) ?? '';
    assertEquals(status.includes(`${res.tokens?.total} tokens, includes estimates)`), true);
  } finally {
    console.log = log;
  }
});
