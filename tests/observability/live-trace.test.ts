import { z } from 'zod';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { forClient } from '../../src/host/client-turn.ts';
import { registerProfile, registerTool, runSession } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { sha256Base64 } from '../../src/kernel/engine/hash.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { LiveSession, SessionRequest, TurnEvent } from '../../src/kernel/types.ts';
import {
  contentOf,
  inlineContent,
  type TraceRecord,
} from '../../src/observability/trace-record.ts';
import type { TraceAttributes, TraceSpan } from '../../src/observability/trace-span.ts';
import { eventsOf, firstOf, sessionEventOf } from '../fixtures/events.ts';
import { MockLiveWebSocket } from '../fixtures/live-socket.ts';
import { HOST_BINDINGS } from '../fixtures/models.ts';
import { catalogedSink, catalogGate } from '../fixtures/trace-catalog.ts';

const PROFILE = 'live_trace_probe';
const TOOL = 'live_trace_lookup';
const API_ID = HOST_BINDINGS.gemini31FlashLive.apiId;
const HANDLE_IN = 'resume-handle-sent-synthetic';
const HANDLE_OUT = 'resume-handle-issued-synthetic';
const USAGE = { promptTokenCount: 12, responseTokenCount: 3, totalTokenCount: 15 };

registerTool({
  type: 'function',
  name: TOOL,
  description: 'Looks up an order',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({}),
  output: z.object({ finding: z.string(), status: z.string() }),
  handler: () => ({ finding: 'shipped', status: 'shipped' }),
});

registerProfile(
  defineProfile({
    type: 'live',
    id: PROFILE,
    identity: { handle: 'live', system: 'hi' },
    models: { gemini31FlashLive: { ...HOST_BINDINGS.gemini31FlashLive, key: 'slotA' } },
    live: {
      voice: 'Aoede',
      ingress: { text: true },
      transcription: { input: true, output: true },
      sessionResumption: true,
    },
    tools: { allow: [TOOL] },
  }),
);

/** The same live profile with its own ended-call wording. */
const WORDED_PROFILE = `${PROFILE}_worded`;
const ENDED_WORDING = 'That call is over. Start another any time.';
registerProfile(
  defineProfile({
    type: 'live',
    id: WORDED_PROFILE,
    identity: { handle: 'live', system: 'hi' },
    models: { gemini31FlashLive: { ...HOST_BINDINGS.gemini31FlashLive, key: 'slotA' } },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: [TOOL] },
    lexicon: { 'live.session_ended': ENDED_WORDING },
  }),
);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  session: LiveSession;
  socket: MockLiveWebSocket;
  records: TraceRecord[];
  events: Promise<TurnEvent[]>;
}

async function open(extra: Partial<SessionRequest> = {}): Promise<Harness> {
  const records: TraceRecord[] = [];
  let socket: MockLiveWebSocket | undefined;
  const session = await runSession(
    { profile: PROFILE, ...extra },
    {
      gemini: { vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined } },
      openWebSocket: () => {
        socket = new MockLiveWebSocket();
        setTimeout(() => socket?.open(), 0);
        return Promise.resolve(socket as unknown as WebSocket);
      },
    },
    catalogedSink(records),
  );
  if (!socket) throw new Error('no socket');
  const events = (async () => {
    const out: TurnEvent[] = [];
    for await (const event of session.events()) out.push(event);
    return out;
  })();
  return { session, socket, records, events };
}

async function deliver(harness: Harness, ...frames: unknown[]): Promise<void> {
  for (const frame of frames) harness.socket.deliver(frame);
  await tick();
  await tick();
}

async function finish(harness: Harness): Promise<TurnEvent[]> {
  await harness.session.close();
  return await harness.events;
}

function rootOf(record: TraceRecord | undefined): TraceSpan {
  const root = record?.spans[0];
  if (!root) throw new Error('no root span');
  return root;
}

function recordNamed(records: TraceRecord[], prefix: string): TraceRecord[] {
  return records.filter((record) => rootOf(record).name.startsWith(prefix));
}

function sessionRecord(records: TraceRecord[]): TraceRecord {
  const [record] = recordNamed(records, 'invoke_agent');
  if (!record) throw new Error('no session record');
  return record;
}

function sessionEvents(span: TraceSpan): TraceAttributes[] {
  return span.events.filter((e) => e.name === 'theorem.session').map((e) => e.attributes);
}

function messages(span: TraceSpan, key: string): TraceAttributes[] {
  return span.attributes[key] as TraceAttributes[];
}

function partsOf(message: TraceAttributes | undefined): TraceAttributes[] {
  return (message?.parts ?? []) as TraceAttributes[];
}

const complete = { serverContent: { turnComplete: true }, usageMetadata: USAGE };

Deno.test('a response is its own record under the session, with what was sent for it', async () => {
  const harness = await open({ conversationId: 'conv-live-1' });
  await harness.session.sendText('where is my order');
  await deliver(
    harness,
    { serverContent: { modelTurn: { parts: [{ text: 'On its way.' }] } } },
    { serverContent: { generationComplete: true } },
    complete,
  );
  const events = await finish(harness);

  const [response] = recordNamed(harness.records, 'generate_content');
  const call = rootOf(response);
  const root = rootOf(sessionRecord(harness.records));
  assertEquals(call.name, `generate_content ${API_ID}`);
  assertEquals([call.traceId, call.parentSpanId], [root.traceId, root.spanId]);
  assertEquals(call.kind, 'CLIENT');
  assertEquals(call.status, { code: 'OK' });
  assertEquals(call.attributes['gen_ai.request.stream'], true);
  // The first output frame stamps the person's wait from the response's first input frame.
  assertEquals(typeof call.attributes['gen_ai.response.time_to_first_chunk'], 'number');
  assertEquals(call.attributes['gen_ai.output.type'], 'speech');
  assertEquals(call.attributes['gen_ai.agent.name'], PROFILE);
  assertEquals(call.attributes['gen_ai.conversation.id'], 'conv-live-1');
  const [input] = messages(call, 'gen_ai.input.messages');
  const [text] = partsOf(input);
  assertEquals(input?.role, 'user');
  assertEquals(response && contentOf(response, text)?.includes('where is my order'), true);
  const [output] = messages(call, 'gen_ai.output.messages');
  assertEquals(response && contentOf(response, partsOf(output)[0]), 'On its way.');
  assertEquals(output?.finish_reason, 'generation_complete');
  assertEquals(call.attributes['gen_ai.usage.input_tokens'], 12);
  assertEquals(call.events.filter((e) => e.name === 'theorem.wire.request').length, 1);

  assertEquals(root.attributes['theorem.steps'], 1);
  assertEquals(root.attributes['gen_ai.usage.input_tokens'], 12);
  assertEquals(
    root.events.some((e) => e.name === 'theorem.wire.request'),
    true,
  );
  assertEquals(
    sessionEvents(root).map((e) => e.kind),
    ['setup_complete', 'closed'],
  );
  assertEquals(sessionEvents(root)[1]?.initiator, 'host');

  const tokens = eventsOf(events, 'tokens');
  assertEquals(
    tokens.map((e) => e.tokens?.input),
    [12],
  );
  const done = firstOf(events, 'done');
  assertEquals(done?.traceparent, `00-${call.traceId}-${call.spanId}-01`);
});

/** A span's guardrail check named `check`. */
function checkOn(span: TraceSpan, check: string): TraceAttributes | undefined {
  return span.events.find((e) => e.name === 'theorem.guardrail' && e.attributes.check === check)
    ?.attributes;
}

Deno.test("a live session times the host's input check and each response's output check", async () => {
  const harness = await open();
  await harness.session.sendText('where is my order');
  await deliver(
    harness,
    { serverContent: { modelTurn: { parts: [{ text: 'On its way.' }] } } },
    complete,
  );
  await finish(harness);
  const input = checkOn(rootOf(sessionRecord(harness.records)), 'live_input');
  assertEquals(input?.action, 'allow');
  assertEquals(typeof input?.duration_ms, 'number');
  const call = rootOf(recordNamed(harness.records, 'generate_content')[0]);
  const output = checkOn(call, 'live_output');
  assertEquals(output?.action, 'allow');
  assertEquals(output?.stage, 'live_outbound');
  assertEquals(typeof output?.duration_ms, 'number');
  assertEquals((output?.runs as number) >= 1, true);
  assertEquals(call.attributes['theorem.guardrail.stream_ms'], output?.duration_ms);
});

Deno.test('a response records what the host received beside what the model produced', async () => {
  const harness = await open();
  await harness.session.sendText('read me the note');
  await deliver(
    harness,
    { serverContent: { modelTurn: { parts: [{ text: 'The note says ' }] } } },
    { serverContent: { modelTurn: { parts: [{ text: harness.session.canary }] } } },
    complete,
  );
  const events = await finish(harness);
  const [response] = recordNamed(harness.records, 'generate_content');
  const call = rootOf(response);
  const hostText = events
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('');
  if (!response) throw new Error('no response record');
  // The gate withheld the canary and the text that led to it; the record shows what got through.
  assertEquals(
    events.some((e) => e.type === 'guardrail'),
    true,
  );
  assertEquals(hostText.includes(harness.session.canary), false);
  assertEquals(inlineContent(response, call.attributes['theorem.output.delivered']), [
    { role: 'assistant', parts: [{ type: 'text', content: hostText }] },
  ]);
  const [produced] = messages(call, 'gen_ai.output.messages');
  assertEquals(contentOf(response, partsOf(produced)[0])?.startsWith('The note says '), true);
});

Deno.test('an interrupted response is UNSET with no finish reason, and keeps its usage', async () => {
  const harness = await open();
  await harness.session.sendText('tell me a story');
  await deliver(
    harness,
    { serverContent: { modelTurn: { parts: [{ text: 'Once upon' }] } } },
    { serverContent: { interrupted: true } },
    complete,
  );
  await finish(harness);
  const call = rootOf(recordNamed(harness.records, 'generate_content')[0]);
  assertEquals(call.status, { code: 'UNSET' });
  assertEquals(call.attributes['theorem.stop.kind'], 'interrupted');
  assertEquals('finish_reason' in (messages(call, 'gen_ai.output.messages')[0] ?? {}), false);
  assertEquals(call.attributes['gen_ai.usage.output_tokens'], 3);
});

Deno.test('transcripts are labelled parts beside what the model read and wrote', async () => {
  const harness = await open();
  await deliver(
    harness,
    { serverContent: { inputTranscription: { text: 'where is it' } } },
    { serverContent: { outputTranscription: { text: 'on its way' } } },
    complete,
  );
  await finish(harness);
  const [response] = recordNamed(harness.records, 'generate_content');
  const call = rootOf(response);
  const heard = messages(call, 'gen_ai.input.messages').at(-1);
  assertEquals(heard?.role, 'user');
  assertEquals(partsOf(heard)[0]?.['theorem.source'], 'input_transcription');
  assertEquals(response && contentOf(response, partsOf(heard)[0]), 'where is it');
  const said = partsOf(messages(call, 'gen_ai.output.messages')[0])[0];
  assertEquals(said?.['theorem.source'], 'output_transcription');
});

Deno.test('a resumption handle is never recorded', async () => {
  const harness = await open({ sessionResumptionHandle: HANDLE_IN });
  await deliver(harness, { sessionResumptionUpdate: { newHandle: HANDLE_OUT, resumable: true } });
  await finish(harness);
  const stored = JSON.stringify(harness.records);
  assertEquals([stored.includes(HANDLE_IN), stored.includes(HANDLE_OUT)], [false, false]);
  const resumption = sessionEvents(rootOf(sessionRecord(harness.records))).find(
    (e) => e.kind === 'session_resumption',
  );
  assertEquals(resumption, { kind: 'session_resumption', resumable: true, handle_issued: true });
});

Deno.test('a tool call is its own record under the response that asked; the next response reads its result', async () => {
  const harness = await open();
  await deliver(harness, { toolCall: { functionCalls: [{ id: 'c1', name: TOOL, args: {} }] } });
  await harness.session.executeTool({ callId: 'c1' });
  // As Live orders it: the asking response completes as the result lands, then the answer.
  await deliver(
    harness,
    complete,
    { serverContent: { modelTurn: { parts: [{ text: 'It shipped.' }] } } },
    complete,
  );
  await finish(harness);

  const [toolRecord] = recordNamed(harness.records, 'execute_tool');
  const [asking, response] = recordNamed(harness.records, 'generate_content');
  const tool = rootOf(toolRecord);
  const asked = rootOf(asking);
  const call = rootOf(response);
  assertEquals([tool.traceId, tool.parentSpanId], [asked.traceId, asked.spanId]);
  assertEquals(messages(asked, 'gen_ai.input.messages'), []);
  assertEquals(tool.attributes['gen_ai.agent.name'], PROFILE);
  const read = toolRecord && contentOf(toolRecord, tool.attributes['gen_ai.tool.call.result']);
  // The guarded text a turn would send, never the raw output: summary, then the rest of the data.
  assertEquals(JSON.parse(read ?? 'null'), { result: 'shipped\n{"status":"shipped"}' });
  const sent = messages(call, 'gen_ai.input.messages').find((m) => m.role === 'tool');
  assertEquals(response && contentOf(response, partsOf(sent)[0]?.response), read);
});

Deno.test('audio sent for a response is one part over its concatenated bytes, stored as a hash', async () => {
  const harness = await open();
  const chunks = [btoa('first-chunk-'), btoa('second-chunk')];
  for (const data of chunks) {
    await harness.session.sendAudio({ data, mimeType: 'audio/pcm;rate=16000' });
  }
  await deliver(harness, complete);
  await finish(harness);
  const call = rootOf(recordNamed(harness.records, 'generate_content')[0]);
  const [input] = messages(call, 'gen_ai.input.messages');
  const parts = partsOf(input);
  assertEquals(parts.length, 1);
  assertEquals(
    parts[0]?.content_sha256,
    (await sha256Base64(btoa('first-chunk-second-chunk')))?.hash,
  );
  const stored = JSON.stringify(harness.records);
  assertEquals(
    chunks.some((data) => stored.includes(data)),
    false,
  );
});

Deno.test('a response with no reported usage has one estimated usage event', async () => {
  const harness = await open();
  await harness.session.sendText('hello');
  await deliver(
    harness,
    { serverContent: { modelTurn: { parts: [{ text: 'Hi there.' }] } } },
    { serverContent: { turnComplete: true } },
  );
  const events = await finish(harness);
  const tokens = eventsOf(events, 'tokens');
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0]?.tokens?.estimated, ['input', 'output']);
});

Deno.test('a session that fails to open still writes its record, typed by its kind', async () => {
  const records: TraceRecord[] = [];
  let failed = false;
  try {
    await runSession(
      { profile: PROFILE },
      {
        gemini: {
          vault: { slotA: undefined, slotB: undefined, slotC: undefined, paid: undefined },
        },
      },
      catalogedSink(records),
    );
  } catch {
    failed = true;
  }
  const root = rootOf(records[0]);
  assertEquals(failed, true);
  assertEquals(root.status, { code: 'ERROR', message: 'auth' });
  assertEquals(root.attributes['error.type'], 'auth');
  assertEquals(
    root.events.some((e) => e.name === 'exception'),
    true,
  );
});

Deno.test('a provider close mid-session reaches the host as an error with its kind', async () => {
  const harness = await open();
  harness.socket.close(1011, 'upstream overloaded');
  const events = await harness.events;
  const error = firstOf(events, 'error');
  assertEquals(error?.errorKind, 'unavailable');
  assertEquals(error?.error, lexiconDefault('error.unavailable'));
  await harness.session.close();
  const root = rootOf(sessionRecord(harness.records));
  assertEquals(root.status, { code: 'ERROR', message: 'unavailable' });
  assertEquals(root.attributes['error.type'], 'unavailable');
  assertEquals(sessionEvents(root).at(-1)?.initiator, 'provider');
});

Deno.test('a normal provider close ends the session without an error', async () => {
  const harness = await open();
  harness.socket.close(1000, '');
  const events = await harness.events;
  assertEquals(
    events.some((e) => e.type === 'error'),
    false,
  );
  await harness.session.close();
  const root = rootOf(sessionRecord(harness.records));
  assertEquals(root.attributes['error.type'], undefined);
});

Deno.test('a close after goAway ends the session quietly, with every close fact kept', async () => {
  const harness = await open();
  await deliver(harness, { goAway: { timeLeft: '50s' } });
  harness.socket.close(1008, 'session limit');
  const events = await harness.events;
  assertEquals(
    events.some((e) => e.type === 'error'),
    false,
  );
  const ended = sessionEventOf(events, 'ended');
  assertEquals(ended?.session.message, lexiconDefault('live.session_ended'));
  assertEquals(ended?.session.timeLeftMs, 50_000);
  assertEquals(ended?.session.ended.cause, 'go_away');
  assertEquals(ended?.session.ended.code, 1008);
  assertEquals(ended?.session.ended.errorKind, 'unsupported');
  assertEquals(typeof ended?.session.ended.closedAfterMs, 'number');
  assertEquals(ended?.errorInternal?.includes('1008: session limit'), true);
  assertEquals(ended && firstOf([forClient(ended)], 'session')?.errorInternal, undefined);
  await harness.session.close();
  const root = rootOf(sessionRecord(harness.records));
  assertEquals(root.status, { code: 'UNSET' });
  assertEquals(root.attributes['theorem.stop.kind'], 'go_away');
  assertEquals(root.attributes['error.type'], undefined);
  const closed = sessionEvents(root).find((e) => e.kind === 'closed');
  assertEquals(closed?.initiator, 'provider');
  assertEquals(closed?.code, 1008);
  assertEquals(closed?.reason, 'session limit');
  assertEquals(closed?.cause, 'go_away');
  assertEquals(closed?.time_left_ms, 50_000);
  assertEquals(closed?.['error.type'], 'unsupported');
  assertEquals(typeof closed?.closed_after_ms, 'number');
});

Deno.test('an ended session speaks in the profile lexicon', async () => {
  const harness = await open({ profile: WORDED_PROFILE });
  await deliver(harness, { goAway: {} });
  harness.socket.close(1000, '');
  const ended = sessionEventOf(await harness.events, 'ended');
  assertEquals(ended?.session.message, ENDED_WORDING);
  await harness.session.close();
});

Deno.test('a normal close after goAway ends the session with no failure kind', async () => {
  const harness = await open();
  await deliver(harness, { goAway: {} });
  harness.socket.close(1000, '');
  const events = await harness.events;
  const ended = sessionEventOf(events, 'ended');
  assertEquals(ended?.session.ended.code, 1000);
  assertEquals(ended?.session.ended.errorKind, undefined);
  assertEquals(ended?.session.timeLeftMs, undefined);
  assertEquals(ended?.errorInternal, undefined);
  await harness.session.close();
  const closed = sessionEvents(rootOf(sessionRecord(harness.records))).find(
    (e) => e.kind === 'closed',
  );
  assertEquals(closed?.['error.type'], undefined);
  assertEquals(closed?.time_left_ms, undefined);
});

/** A socket whose setup Google refuses for quota. */
class QuotaRefusedSocket extends MockLiveWebSocket {
  override send(data: string): void {
    this.sent.push(data);
    queueMicrotask(() => this.close(1011, 'You exceeded your current quota.'));
  }
}

Deno.test('a quota refusal at setup reopens on paid, and the trace names the refusal and the key that served', async () => {
  const records: TraceRecord[] = [];
  const urls: string[] = [];
  const sockets: MockLiveWebSocket[] = [];
  const session = await runSession(
    { profile: PROFILE },
    {
      gemini: {
        vault: { slotA: 'free-key', slotB: undefined, slotC: undefined, paid: 'paid-key' },
      },
      openWebSocket: (url) => {
        urls.push(url);
        const socket = urls.length === 1 ? new QuotaRefusedSocket() : new MockLiveWebSocket();
        sockets.push(socket);
        setTimeout(() => socket.open(), 0);
        return Promise.resolve(socket as unknown as WebSocket);
      },
    },
    catalogedSink(records),
  );
  const drained = (async () => {
    for await (const _ of session.events()) {
      // drain
    }
  })();
  await session.sendText('hello');
  sockets[1]?.deliver({ serverContent: { modelTurn: { parts: [{ text: 'Hi.' }] } } });
  sockets[1]?.deliver(complete);
  await tick();
  await tick();
  await session.close();
  await drained;

  assertEquals(
    urls.map((url) => new URL(url).searchParams.get('key')),
    ['free-key', 'paid-key'],
  );
  const root = rootOf(sessionRecord(records));
  const [overflow] = sessionEvents(root);
  assertEquals(overflow?.kind, 'key_overflow');
  assertEquals(overflow?.key_slot, 'slotA');
  assertEquals(overflow?.to_key_slot, 'paid');
  assertEquals(overflow?.['error.type'], 'rate_limit');
  assertEquals(String(overflow?.error).includes('exceeded your current quota'), true);
  assertEquals(
    sessionEvents(root).map((e) => e.kind),
    ['key_overflow', 'setup_complete', 'closed'],
  );
  const [response] = recordNamed(records, 'generate_content');
  assertEquals(rootOf(response).attributes['theorem.key_slot'], 'paid');
});

Deno.test('a quota refusal with no distinct paid key fails the open as rate_limit', async () => {
  const records: TraceRecord[] = [];
  let opens = 0;
  let failure: unknown;
  try {
    await runSession(
      { profile: PROFILE },
      {
        gemini: {
          vault: { slotA: 'free-key', slotB: undefined, slotC: undefined, paid: undefined },
        },
        openWebSocket: () => {
          opens += 1;
          const socket = new QuotaRefusedSocket();
          setTimeout(() => socket.open(), 0);
          return Promise.resolve(socket as unknown as WebSocket);
        },
      },
      catalogedSink(records),
    );
  } catch (err) {
    failure = err;
  }
  assertEquals(opens, 1);
  assertEquals((failure as { kind?: string } | undefined)?.kind, 'rate_limit');
  assertEquals(rootOf(records[0]).attributes['error.type'], 'rate_limit');
});

catalogGate();
