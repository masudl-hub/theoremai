/**
 * Live session traces: the session record, one record per response, one per
 * `executeTool` call.
 */
import { z } from 'zod';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { sha256Base64 } from '../../src/kernel/engine/hash.ts';
import { runSession } from '../../src/kernel/engine/session/mod.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { registerTool } from '../../src/kernel/tools/registry.ts';
import type { LiveSession, SessionRequest, TurnEvent } from '../../src/kernel/types.ts';
import { memorySink } from '../../src/observability/trace.ts';
import {
  contentOf,
  inlineContent,
  type TraceRecord,
} from '../../src/observability/trace-record.ts';
import type { TraceAttributes, TraceSpan } from '../../src/observability/trace-span.ts';
import { MockLiveWebSocket } from '../fixtures/live-socket.ts';
import { HOST_BINDINGS } from '../fixtures/models.ts';

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
    memorySink(records),
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

  const tokens = events.filter((e) => e.type === 'tokens');
  assertEquals(
    tokens.map((e) => e.tokens?.input),
    [12],
  );
  const done = events.find((e) => e.type === 'done');
  assertEquals(done?.traceparent, `00-${call.traceId}-${call.spanId}-01`);
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
  await harness.session.executeTool({ name: TOOL, callId: 'c1', input: {} });
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
  const tokens = events.filter((e) => e.type === 'tokens');
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0]?.tokens?.estimated, ['input', 'output']);
});

Deno.test('a session that fails to open still writes its record', async () => {
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
      memorySink(records),
    );
  } catch {
    failed = true;
  }
  const root = rootOf(records[0]);
  assertEquals(failed, true);
  assertEquals(root.status.code, 'ERROR');
  assertEquals(
    root.events.some((e) => e.name === 'exception'),
    true,
  );
});
