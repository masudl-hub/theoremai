import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { z } from 'zod';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { applyStageResult, type StageResult } from '../../src/kernel/stages.ts';
import type { TurnModel } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const steer = { role: 'user', content: 'and the fern?' } as const;

function tool(name: string, loadTier: 'T0' | 'T2') {
  registerTool({
    type: 'function',
    name,
    description: `${name} probe`,
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier,
    permission: 'auto',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  });
}

tool('promote_here', 'T0');
tool('promote_later', 'T2');
tool('promote_other', 'T2');

/**
 * A turn whose first call uses a tool and whose second answers. The handler injects at `stage`
 * once; returns the tools each model call was offered.
 */
async function offered(id: string, stage: 'post_tool' | 'before_end', inject: StageResult) {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: ['promote_here', 'promote_later'] },
      inputs: { text: true },
    }),
  );
  const listed: string[][] = [];
  const model: TurnModel = {
    complete: async function* (req) {
      listed.push((req.wireTools ?? []).map((wire) => wire.name));
      if (listed.length === 1 && stage === 'post_tool') {
        yield { type: 'tool', tool: { name: 'promote_here', arguments: {}, callId: 'c1' } };
        return;
      }
      yield { type: 'text', text: `reply ${listed.length}` };
      yield { type: 'done', stop: { kind: 'completed' } };
    },
  };
  let injected = false;
  for await (const _ of runTurn(
    {
      profile: id,
      input: { text: 'hi' },
      onStage: (ctx) => {
        if (ctx.stage !== stage || injected) return;
        injected = true;
        return inject;
      },
    },
    model,
  ));
  return listed;
}

Deno.test('promote: a post_tool inject puts the T2 tool it brings on the next call', async () => {
  const listed = await offered('promote.post_tool', 'post_tool', {
    inject: [steer],
    promote: ['promote_later'],
  });
  assertEquals(listed, [['promote_here'], ['promote_here', 'promote_later']]);
});

Deno.test('promote: a before_end inject puts the T2 tool it brings on the next call', async () => {
  const listed = await offered('promote.before_end', 'before_end', {
    inject: [steer],
    promote: ['promote_later'],
  });
  assertEquals(listed, [['promote_here'], ['promote_here', 'promote_later']]);
});

Deno.test('promote: a tool the turn could not load stays off the list', async () => {
  const listed = await offered('promote.outside', 'before_end', {
    inject: [steer],
    promote: ['promote_other', 'promote_here', 'no_such_tool'],
  });
  assertEquals(listed, [['promote_here'], ['promote_here']]);
});

Deno.test('promote: an inject without promote leaves the list as it was', async () => {
  const listed = await offered('promote.none', 'before_end', { inject: [steer] });
  assertEquals(listed, [['promote_here'], ['promote_here']]);
});

Deno.test('promote: a promote that is not a list of ids warns and promotes nothing', () => {
  const bad = applyStageResult({
    stage: 'before_end',
    result: { inject: [steer], promote: [''] },
    injectAllowed: true,
  });
  assertEquals(bad.inject, { messages: [steer] });
  assertEquals(
    bad.warnings.map((w) => w.code),
    ['inject_promote_invalid'],
  );
  const alone = applyStageResult({
    stage: 'before_end',
    result: { promote: ['promote_later'] },
    injectAllowed: true,
  });
  assertEquals(alone.inject, undefined);
  assertEquals(
    alone.warnings.map((w) => w.code),
    ['inject_promote_invalid'],
  );
  const good = applyStageResult({
    stage: 'before_end',
    result: { inject: [steer], promote: ['promote_later'] },
    injectAllowed: true,
  });
  assertEquals(good.inject, { messages: [steer], promote: ['promote_later'] });
});
