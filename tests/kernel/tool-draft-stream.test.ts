import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import type { DetectSpec } from '../../src/guardrails/detectors.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  ProviderEvent,
  TurnEvent,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

interface ToolProfileOptions {
  detect?: DetectSpec;
}

function registerToolProfile(id: string, options: ToolProfileOptions = {}): string {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: ['fetch_sensor'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 }, ...(options.detect ? { detect: options.detect } : {}) },
    }),
  );
  return id;
}

interface Piece {
  text: string;
  name?: string;
}

/** First call: drafts `pieces(canary)`, then the call they write; second call: a short reply. */
function draftingProvider(pieces: (canary: string) => Array<string | Piece>): ModelProvider {
  let call = 0;
  return {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<ProviderEvent> {
      await Promise.resolve();
      if (call++ > 0) {
        yield { type: 'text', text: 'Done.' };
        yield { type: 'done', stop: { kind: 'completed' } };
        return;
      }
      const canary = /Your canary token is (\S+?)\./.exec(req.system ?? '')?.[1] ?? '';
      const parts = pieces(canary).map((piece) =>
        typeof piece === 'string' ? { text: piece } : piece,
      );
      for (const { text, name = 'fetch_sensor' } of parts) {
        yield { type: 'tool_draft', callId: 'call_1', name, text };
      }
      yield {
        type: 'tool',
        tool: {
          name: 'fetch_sensor',
          callId: 'call_1',
          arguments: JSON.parse(parts.map((part) => part.text).join('')),
        },
      };
      yield { type: 'done', stop: { kind: 'tool' } };
    },
  };
}

async function collect(profile: string, provider: ModelProvider): Promise<TurnEvent[]> {
  return await Array.fromAsync(runTurn({ profile, input: { text: 'Check soil' } }, provider));
}

function draftText(events: TurnEvent[]): string {
  return events.flatMap((e) => (e.type === 'tool_draft' ? [e.text] : [])).join('');
}

function called(events: TurnEvent[]): boolean {
  return events.some((e) => e.type === 'tool' && e.tool.callId === 'call_1');
}

Deno.test('a draft reaches the host before its call, and adds up to it', async () => {
  const profile = registerToolProfile('tool_draft_stream');
  const events = await collect(
    profile,
    draftingProvider(() => ['{"sensor":', '"soil", "note": "a long', ' note"}']),
  );
  const types = events.map((e) => e.type);
  const firstCall = events.findIndex((e) => e.type === 'tool');
  assertEquals(types.indexOf('tool_draft') < firstCall, true);
  assertEquals(types.lastIndexOf('tool_draft') < firstCall, true);
  // why: The gate holds a tail that could open a canary; the call that follows owns the rest.
  assertEquals('{"sensor":"soil", "note": "a long note"}'.startsWith(draftText(events)), true);
  assertEquals(draftText(events).startsWith('{"sensor":"soil"'), true);
});

Deno.test('a canary written into a draft stops it before any of it shows', async () => {
  const profile = registerToolProfile('tool_draft_canary');
  let canary = '';
  const events = await collect(
    profile,
    draftingProvider((token) => {
      canary = token;
      const half = Math.floor(token.length / 2);
      return [
        '{"sensor":"soil","note":"',
        token.slice(0, half),
        token.slice(half),
        ' and more text after it"}',
      ];
    }),
  );
  assertEquals(canary.length > 0, true);
  const shown = draftText(events);
  assertEquals(shown.includes(canary), false);
  assertEquals(shown.includes(canary.slice(0, Math.floor(canary.length / 2))), false);
  assertEquals(shown.includes('more text'), false);
});

for (const action of ['block', 'redact'] as const) {
  Deno.test(`a secret the call's check would ${action} stops its draft before it shows`, async () => {
    const profile = registerToolProfile(`tool_draft_${action}`, {
      detect: { credentials: { at: { tool_arguments_function: action } } },
    });
    const half = Math.floor(TEST_OPENAI_KEY.length / 2);
    const events = await collect(
      profile,
      draftingProvider(() => [
        '{"sensor":"soil","note":"key ',
        TEST_OPENAI_KEY.slice(0, half),
        TEST_OPENAI_KEY.slice(half),
        ' then more"}',
      ]),
    );
    const shown = draftText(events);
    assertEquals(shown.includes(TEST_OPENAI_KEY), false);
    assertEquals(shown.includes(TEST_OPENAI_KEY.slice(0, half)), false);
    assertEquals(shown.includes('then more'), false);
  });
}

Deno.test('a draft whose name changes stops showing', async () => {
  const profile = registerToolProfile('tool_draft_renamed');
  const events = await collect(
    profile,
    draftingProvider(() => [
      { text: '{"sensor":', name: 'fetch' },
      { text: '"soil"}', name: 'fetch_sensor' },
    ]),
  );
  const drafts = events.filter((e) => e.type === 'tool_draft');
  assertEquals(
    drafts.every((e) => e.type === 'tool_draft' && e.name === 'fetch'),
    true,
  );
  assertEquals(draftText(events).includes('soil'), false);
  assertEquals(called(events), true);
});
