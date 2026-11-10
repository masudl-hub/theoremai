import { assertEquals, assertStringIncludes } from '@std/assert';
import { z } from 'zod';
import {
  clearProfiles,
  registerProfile,
  registerTool,
  resetTools,
  runSession,
} from '../../src/kernel/default-scope.ts';
import type { LiveLine, LiveLines } from '../../src/kernel/engine/session/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnHistoryMessage } from '../../src/kernel/types.ts';
import { MockLiveWebSocket } from '../fixtures/live-socket.ts';
import { HOST_BINDINGS } from '../fixtures/models.ts';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const AUDIO = { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' };
const heard = (text: string) => ({ serverContent: { inputTranscription: { text } } });
const said = (text: string) => ({ serverContent: { outputTranscription: { text } } });
const TURN_COMPLETE = { serverContent: { turnComplete: true } };

/** A host that numbers lines in order; `log` has what it kept and saw, in the order it happened. */
function lineHost(failKeep = false) {
  let next = 0;
  const log: string[] = [];
  const kept: LiveLine[] = [];
  const lines: LiveLines = {
    reserve: () => {
      next += 1;
      return Promise.resolve(`msg.${next}`);
    },
    note: ({ id, role }) => `[note] ${role} ${id}`,
    keep: async (line) => {
      await tick();
      if (failKeep) throw new Error('store down');
      kept.push(line);
      log.push(`keep ${line.id}`);
    },
  };
  return { lines, kept, log };
}

async function openLines(id: string, lines?: LiveLines, log: string[] = [], greeting?: string) {
  clearProfiles();
  resetTools();
  registerTool({
    type: 'function',
    name: 'live_lookup',
    description: 'look something up',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
  });
  const profile = defineProfile({
    type: 'live',
    id,
    identity: { handle: 'live', system: 'hi' },
    models: { gemini31FlashLive: { ...HOST_BINDINGS.gemini31FlashLive, keySlot: 'main' } },
    live: { voice: 'Aoede', ingress: { text: true }, ...(greeting ? { greeting } : {}) },
    tools: { allow: ['live_lookup'] },
  });
  registerProfile(profile);
  const sockets: MockLiveWebSocket[] = [];
  let history: readonly TurnHistoryMessage[] = [];
  const session = await runSession(
    {
      profile: profile.id,
      onStage: ({ stage, history: seen }) => {
        if (stage === 'post_turn') history = structuredClone(seen);
      },
    },
    {
      vault: { main: 'test-key' },
      openWebSocket: () => {
        const socket = new MockLiveWebSocket();
        sockets.push(socket);
        setTimeout(() => socket.open(), 0);
        return Promise.resolve(socket as unknown as WebSocket);
      },
      ...(lines ? { lines } : {}),
    },
  );
  const [mock] = sockets;
  if (!mock) throw new Error('no socket opened');
  /** The kernel's id for each call the model made, in the order the session surfaced them. */
  const issued: string[] = [];
  const drain = (async () => {
    for await (const event of session.events()) {
      if (event.type === 'tool' && event.tool.phase === undefined) {
        log.push('tool');
        issued.push(event.tool.callId);
      }
    }
  })();
  /** The texts sent as clientContent; `seeded` is the opening seed, the rest are mid-call notes. */
  const clientTexts = (turnComplete: boolean) =>
    mock.sent.flatMap((frame): string[] => {
      const content = JSON.parse(frame)?.clientContent;
      if (!content || content.turnComplete !== turnComplete) return [];
      return content.turns.flatMap((turn: { parts: { text?: string }[] }) =>
        turn.parts.flatMap((part) => (part.text ? [part.text] : [])),
      );
    });
  const deliver = async (...frames: unknown[]) => {
    for (const frame of frames) {
      mock.deliver(frame);
      await tick();
    }
    await tick(20);
  };
  const end = async () => {
    await session.close();
    mock.close();
    await drain.catch(() => undefined);
  };
  return { session, mock, drain, deliver, end, clientTexts, issued, history: () => history };
}

Deno.test('a user line is kept under the id its note gave, before the tool call reaches the host', async () => {
  const host = lineHost();
  const call = await openLines('lines_tool_waits', host.lines, host.log);
  assertEquals(call.clientTexts(true), ['[note] user msg.1']);
  await call.session.sendAudio(AUDIO);
  await call.deliver(heard('My name'), heard(' is Ada.'), {
    toolCall: { functionCalls: [{ id: 'c1', name: 'live_lookup', args: {} }] },
  });
  assertEquals(host.kept, [{ id: 'msg.1', role: 'user', text: 'My name is Ada.' }]);
  assertEquals(host.log, ['keep msg.1', 'tool']);
  assertEquals(call.clientTexts(false), ['[note] user msg.2']);
  await call.end();
});

Deno.test("the model's turn is one line, kept and then noted", async () => {
  const host = lineHost();
  const call = await openLines('lines_reply', host.lines);
  await call.session.sendAudio(AUDIO);
  await call.deliver(heard('Hi'), said('Hello'), said(' there.'), TURN_COMPLETE);
  assertEquals(host.kept, [
    { id: 'msg.1', role: 'user', text: 'Hi' },
    { id: 'msg.3', role: 'assistant', text: 'Hello there.' },
  ]);
  assertEquals(call.clientTexts(false), ['[note] user msg.2', '[note] assistant msg.3']);
  assertEquals(call.history(), [
    { role: 'system', content: '[note] user msg.1' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello there.' },
    { role: 'system', content: '[note] assistant msg.3' },
  ]);
  await call.end();
});

Deno.test('what the model says before a call is one message with the call', async () => {
  const call = await openLines('lines_said_then_call');
  await call.session.sendAudio(AUDIO);
  await call.deliver(heard('Look it up.'), {
    serverContent: { modelTurn: { parts: [{ text: 'Let me look.' }] } },
  });
  await call.deliver({
    toolCall: { functionCalls: [{ id: 'c1', name: 'live_lookup', args: {} }] },
  });
  const [issued] = call.issued;
  if (!issued) throw new Error('the session never surfaced the call');
  await call.session.executeTool({ callId: issued });
  await call.deliver(
    { serverContent: { modelTurn: { parts: [{ text: 'Found it.' }] } } },
    TURN_COMPLETE,
  );
  assertEquals(
    call.history().map((m) => [m.role, m.content ?? null, m.tool_calls?.map((c) => c.id) ?? null]),
    [
      ['user', 'Look it up.', null],
      ['assistant', 'Let me look.', [issued]],
      ['tool', 'ok', null],
      ['assistant', 'Found it.', null],
    ],
  );
  await call.end();
});

Deno.test('without lines, the chunks of what the user said are one history entry', async () => {
  const call = await openLines('lines_unset');
  assertEquals(call.clientTexts(true), []);
  await call.session.sendAudio(AUDIO);
  await call.deliver(heard('My name'), heard(' is Ada.'), said('Hello, Ada.'), TURN_COMPLETE);
  assertEquals(call.history(), [
    { role: 'user', content: 'My name is Ada.' },
    { role: 'assistant', content: 'Hello, Ada.' },
  ]);
  assertEquals(call.clientTexts(false), []);
  await call.end();
});

Deno.test('a typed line takes the id the model was given, as a spoken one does', async () => {
  const host = lineHost();
  const call = await openLines('lines_typed', host.lines);
  await call.session.sendText('What is this leaf?');
  await call.deliver(said('A fig.'), TURN_COMPLETE);
  assertEquals(host.kept[0], { id: 'msg.1', role: 'user', text: 'What is this leaf?' });
  await call.end();
});

Deno.test('the greeting is not a line: the first line is the first thing the user says', async () => {
  const host = lineHost();
  const call = await openLines('lines_greeting', host.lines, [], 'Greet the visitor.');
  await call.deliver(said('Hello!'), TURN_COMPLETE);
  await call.session.sendAudio(AUDIO);
  await call.deliver(heard('Hi.'), said('How can I help?'), TURN_COMPLETE);
  assertEquals(host.kept, [
    { id: 'msg.2', role: 'assistant', text: 'Hello!' },
    { id: 'msg.1', role: 'user', text: 'Hi.' },
    { id: 'msg.4', role: 'assistant', text: 'How can I help?' },
  ]);
  await call.end();
});

Deno.test('closing keeps what the user said that the model never answered', async () => {
  const host = lineHost();
  const call = await openLines('lines_close', host.lines);
  await call.session.sendAudio(AUDIO);
  await call.deliver(heard('Goodbye.'));
  assertEquals(host.kept, []);
  await call.end();
  assertEquals(host.kept, [{ id: 'msg.1', role: 'user', text: 'Goodbye.' }]);
});

Deno.test('a line the host cannot keep at the close is reported once', async () => {
  const host = lineHost(true);
  const call = await openLines('lines_keep_fails', host.lines);
  await call.session.sendAudio(AUDIO);
  await call.deliver(heard('Goodbye.'));
  const reports: string[] = [];
  await call.session.close().catch((err: Error) => reports.push(err.message));
  call.mock.close();
  await call.drain.catch((err: Error) => reports.push(err.message));
  assertEquals(reports.length, 1);
  assertStringIncludes(reports[0] ?? '', 'store down');
});
