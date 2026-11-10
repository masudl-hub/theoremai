import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import {
  invokeTool,
  type ProfileDefinition,
  registerProfile,
  registerTool,
  type TurnEvent,
} from '../../mod.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { appendAssistantEventsToHistory } from '../../src/interface/history.ts';
import { createSchemaRegistry } from '../../src/kernel/registry/schemas.ts';
import { outputForModel } from '../../src/kernel/tools/model-view.ts';
import type { ModelRequest, TurnModel } from '../../src/kernel/types.ts';
import { createHostTransport } from '../../web/src/client/host-transport.ts';
import { createTheoremHostHandler, createTheoremMcpHandler } from '../../web/src/server/mod.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';

const PHOTO = 'https://img.example/fern.png';
const TAG = 'shelf-7-internal';
const OUTPUT = {
  name: 'fern',
  photoUrl: PHOTO,
  pots: [
    { size: 'small', tag: TAG },
    { size: 'large', tag: TAG },
  ],
};
const MODEL_VIEW = { name: 'fern', pots: [{ size: 'small' }, { size: 'large' }] };

registerTool({
  type: 'function',
  name: 'model_view_plant',
  description: 'Look a plant up',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.object({}),
  output: z.object({
    name: z.string(),
    photoUrl: z.string().meta({ exposeToModel: false }),
    pots: z.array(z.object({ size: z.string(), tag: z.string().meta({ exposeToModel: false }) })),
  }),
  handler: () => OUTPUT,
});
registerProfile({
  type: 'text',
  id: 'model_view_agent',
  identity: { handle: 'model_view_agent', system: 'You help.' },
  ...geminiModels('gemini35FlashLite'),
  maxSteps: 3,
  tools: { allow: ['model_view_plant'] },
  inputs: { text: true },
});
type HostDefinition = Extract<ProfileDefinition, { type: 'host' }>;
const HOST: HostDefinition = {
  type: 'host',
  id: 'model_view_host',
  tools: { allow: ['model_view_plant'] },
  guardrails: { detect: { injection: 'ignore' } },
};

function leaks(text: string): boolean {
  return text.includes(PHOTO) || text.includes(TAG);
}

Deno.test('one tool, two readers: the host gets every field, each model view leaves the marked ones out', async () => {
  const requests: ModelRequest[] = [];
  const model: TurnModel = {
    async *complete(req) {
      await Promise.resolve();
      requests.push(req);
      if (requests.length === 1) {
        yield { type: 'tool', tool: { name: 'model_view_plant', arguments: {}, callId: 'c1' } };
        return;
      }
      yield { type: 'text', text: 'A fern.' };
    },
  };
  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    { profile: 'model_view_agent', input: { text: 'Which plant?' } },
    model,
  ))
    events.push(event);
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.output, OUTPUT);
  assert(complete?.readBack);
  assertEquals(leaks(complete.readBack), false);
  assertEquals(complete.readBack.includes('"pots":[{"size":"small"},{"size":"large"}]'), true);

  const sent = requests[1]?.history?.find((message) => message.role === 'tool')?.content;
  assertEquals(sent, complete.readBack);

  const replayed = appendAssistantEventsToHistory([], events).find((m) => m.role === 'tool');
  assertEquals(replayed?.content, complete.readBack);

  const mcp = createTheoremMcpHandler({ profile: HOST, name: 'model-view-mcp', version: '1.0.0' });
  const res = await mcp(
    new Request('http://mcp.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'model_view_plant',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'model_view_plant',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
  );
  const { result } = await res.json();
  assertEquals(result.isError, false);
  assertEquals(result.content, [{ type: 'text', text: complete.readBack }]);
});

Deno.test('the host door hands the page the whole output and publishes the mark in its schema', async () => {
  const handler = createTheoremHostHandler({ profile: { ...HOST, id: 'model_view_host_door' } });
  let cookie = '';
  const transport = createHostTransport({
    endpoint: 'http://host.test/api/host',
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set('cookie', cookie);
      const response = await handler(new Request(url, { ...init, headers }));
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0];
      return response;
    },
  });
  const described = await transport.describe();
  const schema = described.tools[0]?.outputSchema as {
    properties: { photoUrl: { exposeToModel?: boolean } };
  };
  assertEquals(schema.properties.photoUrl.exposeToModel, false);
  const events: TurnEvent[] = [];
  await transport.call({ name: 'model_view_plant', input: {} }, (event) => {
    events.push(event as TurnEvent);
  });
  assertEquals(toolEventsOf(events, 'complete')[0]?.output, OUTPUT);
});

Deno.test('invokeTool keeps the output whole and gives the model view as its read-back', async () => {
  const events: TurnEvent[] = [];
  for await (const event of invokeTool({
    profile: 'model_view_agent',
    name: 'model_view_plant',
    input: {},
  }))
    events.push(event);
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.output, OUTPUT);
  assertEquals(JSON.parse(complete?.readBack ?? '{}'), MODEL_VIEW);
});

Deno.test('the post_tool stage hands the host the output as the model reads it', async () => {
  const seen: { raw: unknown; forModel: unknown }[] = [];
  for await (const _ of invokeTool({
    profile: 'model_view_agent',
    name: 'model_view_plant',
    input: {},
    onStage: (ctx) => {
      if (ctx.stage === 'post_tool')
        seen.push({ raw: ctx.outputRaw, forModel: ctx.outputForModel });
    },
  }));
  assertEquals(seen, [{ raw: OUTPUT, forModel: MODEL_VIEW }]);
});

Deno.test('a field one branch of a union marks is left out whichever branch the value took', () => {
  const schema = {
    anyOf: [
      {
        type: 'object',
        properties: { id: { type: 'string' }, url: { type: 'string', exposeToModel: false } },
      },
      { type: 'object', properties: { url: { type: 'string' }, size: { type: 'number' } } },
    ],
  };
  assertEquals(outputForModel(schema, { url: 'x', size: 2 }), { size: 2 });
});

Deno.test('a mark reached through a reference is honoured, recursive shapes included', () => {
  const schema = {
    $ref: '#/$defs/node',
    $defs: {
      node: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          secret: { type: 'string', exposeToModel: false },
          children: { type: 'array', items: { $ref: '#/$defs/node' } },
        },
      },
    },
  };
  const tree = {
    label: 'a',
    secret: 's1',
    children: [{ label: 'b', secret: 's2', children: [] }],
  };
  assertEquals(outputForModel(schema, tree), {
    label: 'a',
    children: [{ label: 'b', children: [] }],
  });
});

Deno.test('an output with no mark is handed back as it is', () => {
  const output = { a: 1 };
  assertEquals(outputForModel({ type: 'object' }, output) === output, true);
});

Deno.test('a mark the kernel cannot honour is refused when the tool or schema registers', () => {
  const base = {
    type: 'function' as const,
    description: 'x',
    category: 'test',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    handler: () => ({ a: 'x' }),
  };
  assertThrows(
    () =>
      registerTool({
        ...base,
        name: 'model_view_bad_input',
        input: z.object({ q: z.string().meta({ exposeToModel: false }) }),
        output: z.object({ a: z.string() }),
      }),
    TheoremError,
    'marks output fields only',
  );
  assertThrows(
    () =>
      registerTool({
        ...base,
        name: 'model_view_bad_value',
        input: z.object({}),
        output: z.object({ a: z.string().meta({ exposeToModel: true }) }),
      }),
    TheoremError,
    'takes false only',
  );
  assertThrows(
    () =>
      registerTool({
        ...base,
        name: 'model_view_bad_root',
        input: z.object({}),
        output: z.object({ a: z.string() }).meta({ exposeToModel: false }),
      }),
    TheoremError,
    'set exposeToModel: false on the tool instead',
  );
  assertThrows(
    () =>
      createSchemaRegistry().register('model_view_bad_reply', {
        jsonSchema: { type: 'object', exposeToModel: false },
      }),
    TheoremError,
    'set exposeToModel: false on the tool instead',
  );
});
