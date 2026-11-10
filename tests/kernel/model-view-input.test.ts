import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import {
  invokeTool,
  type ProfileDefinition,
  registerProfile,
  registerTool,
  type StageHandler,
  type TurnEvent,
} from '../../mod.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { appendAssistantEventsToHistory } from '../../src/interface/history.ts';
import type { ModelRequest, TurnModel } from '../../src/kernel/types.ts';
import { createTheoremMcpHandler } from '../../web/src/server/mod.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';

const STORE = 'store-7';
const received: unknown[] = [];

registerTool({
  type: 'function',
  name: 'model_view_stock',
  description: 'Look up stock for a plant',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({
    plant: z.string(),
    storeId: z.string().meta({ exposeToModel: false }).optional(),
    filter: z
      .object({ size: z.string(), shelf: z.string().optional().meta({ exposeToModel: false }) })
      .optional(),
  }),
  output: z.object({ count: z.number() }),
  handler: (input) => {
    received.push(input);
    return { count: 3 };
  },
});
registerProfile({
  type: 'text',
  id: 'model_view_input_agent',
  identity: { handle: 'model_view_input_agent', system: 'You help.' },
  ...geminiModels('gemini35FlashLite'),
  maxSteps: 3,
  tools: { allow: ['model_view_stock'] },
  inputs: { text: true },
});
type HostDefinition = Extract<ProfileDefinition, { type: 'host' }>;
const HOST: HostDefinition = {
  type: 'host',
  id: 'model_view_input_host',
  tools: { allow: ['model_view_stock'] },
  guardrails: { detect: { injection: 'ignore' } },
};

const fillStore: StageHandler = (ctx) => {
  if (ctx.stage !== 'pre_tool') return undefined;
  const input = ctx.input as Record<string, unknown>;
  return {
    mutate: { input: { ...input, storeId: STORE, filter: { size: 'small', shelf: 'b2' } } },
  };
};

function modelCalling(args: Record<string, unknown>, requests: ModelRequest[]): TurnModel {
  return {
    async *complete(req) {
      await Promise.resolve();
      requests.push(req);
      if (requests.length === 1) {
        yield { type: 'tool', tool: { name: 'model_view_stock', arguments: args, callId: 'c1' } };
        return;
      }
      yield { type: 'text', text: 'Three.' };
    },
  };
}

Deno.test('the model never sees a marked input field; the host fills it and the model never reads it back', async () => {
  received.length = 0;
  const requests: ModelRequest[] = [];
  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    { profile: 'model_view_input_agent', input: { text: 'Any ferns?' }, onStage: fillStore },
    modelCalling({ plant: 'fern', filter: { size: 'small' } }, requests),
  ))
    events.push(event);
  const sent = JSON.stringify(requests[0]?.wireTools);
  assert(sent.includes('plant'));
  assertEquals(sent.includes('storeId'), false);
  assertEquals(sent.includes('shelf'), false);
  assertEquals(sent.includes('exposeToModel'), false);
  assertEquals(received, [
    { plant: 'fern', storeId: STORE, filter: { size: 'small', shelf: 'b2' } },
  ]);
  const leaks = (text: string) => text.includes(STORE) || text.includes('b2');
  assertEquals(leaks(JSON.stringify(requests[1]?.history)), false);
  const replayed = appendAssistantEventsToHistory([], events);
  assertEquals(leaks(JSON.stringify(replayed)), false);
});

Deno.test('a model that sends a marked input field is refused and the tool does not run', async () => {
  received.length = 0;
  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    { profile: 'model_view_input_agent', input: { text: 'Any ferns?' } },
    modelCalling({ plant: 'fern', storeId: 'guess', filter: { size: 'small', shelf: 'x' } }, []),
  ))
    events.push(event);
  const [error] = toolEventsOf(events, 'error');
  assertEquals(error?.failure.code, 'invalid_input');
  assertEquals((error?.failure.details as { notInputs?: string[] } | undefined)?.notInputs, [
    'storeId',
    'filter.shelf',
  ]);
  assertEquals(received, []);
});

Deno.test('the host sends a marked input field itself', async () => {
  received.length = 0;
  await Array.fromAsync(
    invokeTool({
      profile: 'model_view_input_agent',
      name: 'model_view_stock',
      input: { plant: 'fern', storeId: STORE },
    }),
  );
  assertEquals(received, [{ plant: 'fern', storeId: STORE }]);
});

Deno.test('a confirmed call holds the model view, and the host fills the field again when it resumes', async () => {
  received.length = 0;
  const confirmThenFill: StageHandler = (ctx) => {
    const filled = fillStore(ctx);
    if (ctx.stage !== 'pre_tool' || ctx.approved) return filled;
    return { ...filled, confirm: { summary: 'Check the store.' } };
  };
  const call = {
    profile: 'model_view_input_agent',
    name: 'model_view_stock',
    onStage: confirmThenFill,
  };
  const held = await Array.fromAsync(invokeTool({ ...call, input: { plant: 'fern' } }));
  const [gate] = toolEventsOf(held, 'gate');
  assertEquals(gate?.gate.preparedArguments, { plant: 'fern', filter: { size: 'small' } });
  assertEquals(received, []);
  await Array.fromAsync(
    invokeTool({
      ...call,
      input: gate?.gate.preparedArguments,
      resume: { granted: true, gateKind: 'confirmation' },
    }),
  );
  assertEquals(received, [
    { plant: 'fern', storeId: STORE, filter: { size: 'small', shelf: 'b2' } },
  ]);
});

Deno.test("a user's edit reads back as the model's view of the call", async () => {
  received.length = 0;
  const events = await Array.fromAsync(
    invokeTool({
      profile: 'model_view_input_agent',
      name: 'model_view_stock',
      input: { plant: 'rose', storeId: STORE },
      resume: { granted: true, gateKind: 'confirmation', edited: { from: { plant: 'fern' } } },
    }),
  );
  const running = events.flatMap((event) =>
    event.type === 'tool' && event.tool.phase === 'running' && event.tool.edited
      ? [event.tool.edited]
      : [],
  );
  assertEquals(running, [{ from: { plant: 'fern' }, to: { plant: 'rose' } }]);
  assertEquals(received, [{ plant: 'rose', storeId: STORE }]);
});

async function mcpCall(method: string, params: Record<string, unknown>) {
  const mcp = createTheoremMcpHandler({
    profile: HOST,
    name: 'model-view-input-mcp',
    version: '1.0.0',
  });
  const res = await mcp(
    new Request('http://mcp.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
  );
  return await res.json();
}

registerProfile({
  type: 'text',
  id: 'model_view_input_researcher',
  identity: { handle: 'model_view_input_researcher', system: 'You research.' },
  ...geminiModels('gemini35FlashLite'),
  maxSteps: 2,
  tools: { allow: [] },
  inputs: { text: true },
});
registerTool({
  type: 'agent',
  name: 'model_view_ask',
  description: 'Ask the researcher',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  profile: 'model_view_input_researcher',
  hostFields: { storeId: z.string().meta({ exposeToModel: false }).optional() },
});
registerProfile({
  type: 'text',
  id: 'model_view_input_caller',
  identity: { handle: 'model_view_input_caller', system: 'You help.' },
  ...geminiModels('gemini35FlashLite'),
  maxSteps: 3,
  tools: { allow: ['model_view_ask'] },
  inputs: { text: true },
});

/** The caller asks the researcher once with `args`; the researcher answers with the text it was sent. */
function callerAsking(args: Record<string, unknown>, requests: ModelRequest[]): TurnModel {
  return {
    async *complete(req) {
      await Promise.resolve();
      requests.push(req);
      if (req.system.includes('You research.')) {
        yield { type: 'text', text: 'Found it.' };
        return;
      }
      if (requests.length === 1) {
        yield { type: 'tool', tool: { name: 'model_view_ask', arguments: args, callId: 'a1' } };
        return;
      }
      yield { type: 'text', text: 'Done.' };
    },
  };
}

async function askResearcher(args: Record<string, unknown>, onStage?: StageHandler) {
  const requests: ModelRequest[] = [];
  const hostInputs: unknown[] = [];
  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    {
      profile: 'model_view_input_caller',
      input: { text: 'Any ferns?' },
      ...(onStage ? { onStage } : {}),
      onAgentCall: (call) => {
        hostInputs.push(call.hostInput);
        return { input: call.input };
      },
    },
    callerAsking(args, requests),
  ))
    events.push(event);
  return { requests, hostInputs, events };
}

Deno.test("an agent tool's marked host field is the host's to fill, and reaches onAgentCall", async () => {
  const filled = await askResearcher({ text: 'Any ferns?' }, (ctx) =>
    ctx.stage === 'pre_tool'
      ? { mutate: { input: { ...(ctx.input as object), storeId: STORE } } }
      : undefined,
  );
  const sent = JSON.stringify(filled.requests[0]?.wireTools);
  assert(sent.includes('model_view_ask'));
  assertEquals(sent.includes('storeId'), false);
  assertEquals(filled.hostInputs, [{ storeId: STORE }]);
  assertEquals(JSON.stringify(filled.requests.slice(1)).includes(STORE), false);

  const empty = await askResearcher({ text: 'Any ferns?' });
  assertEquals(empty.hostInputs, [{}]);

  const sentByModel = await askResearcher({ text: 'Any ferns?', storeId: 'guess' });
  const [error] = toolEventsOf(sentByModel.events, 'error');
  assertEquals(error?.failure.code, 'invalid_input');
  assertEquals((error?.failure.details as { notInputs?: string[] } | undefined)?.notInputs, [
    'storeId',
  ]);
  assertEquals(sentByModel.hostInputs, []);
});

Deno.test('the MCP door lists the model view and refuses a marked field', async () => {
  received.length = 0;
  const listed = await mcpCall('tools/list', {});
  const schema = JSON.stringify(listed.result.tools[0].inputSchema);
  assert(schema.includes('plant'));
  assertEquals(schema.includes('storeId'), false);
  const refused = await mcpCall('tools/call', {
    name: 'model_view_stock',
    arguments: { plant: 'fern', storeId: 'guess' },
  });
  assert(refused.error);
  assertEquals(received, []);
});

Deno.test('an input mark the kernel cannot honour is refused when the tool registers', () => {
  const base = {
    type: 'function' as const,
    description: 'x',
    category: 'test',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    output: z.object({ a: z.string() }),
    handler: () => ({ a: 'x' }),
  };
  const refused = (name: string, input: z.ZodType, message: string) =>
    assertThrows(() => registerTool({ ...base, name, input }), TheoremError, message);
  refused(
    'model_view_input_required',
    z.object({ q: z.string().meta({ exposeToModel: false }) }),
    'must be optional',
  );
  refused(
    'model_view_input_item',
    z.object({ q: z.array(z.string().meta({ exposeToModel: false })).optional() }),
    'marks a field of an object',
  );
  refused(
    'model_view_input_root',
    z.object({}).meta({ exposeToModel: false }),
    'marks a field of an object',
  );
  refused(
    'model_view_input_value',
    z.object({ q: z.string().meta({ exposeToModel: true }).optional() }),
    'takes false only',
  );
});
