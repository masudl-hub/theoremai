/**
 * Registered function tools used by kernel tests.
 *
 * @module
 */

import { z } from 'zod';
import { invokeTool, registerTool } from '../../src/kernel/tools/mod.ts';
import type { InvokeToolRequest, Profile, TurnEvent } from '../../src/kernel/types.ts';

const FindingOutput = z.object({ finding: z.string() });

const LoadToolsInput = z.object({ names: z.array(z.string()).min(1) });
const LoadToolsOutput = z.object({ loaded: z.array(z.string()) });
const RecordLookupInput = z.object({ q: z.string() });
const GetRecordInput = z.object({ recordId: z.string() });
const SensorInput = z.object({ sensor: z.string() });
const OrderInput = z.object({ orderId: z.string() });
const DeleteInput = z.object({ id: z.string() });
const PingInput = z.object({ step: z.number() });
const CrashInput = z.object({ id: z.string() });
const StubInput = z.object({ value: z.number().optional() });
const ExistingInput = z.object({});

type LoadToolsInputValue = z.infer<typeof LoadToolsInput>;
type RecordLookupInputValue = z.infer<typeof RecordLookupInput>;
type PingInputValue = z.infer<typeof PingInput>;
type DeleteInputValue = z.infer<typeof DeleteInput>;

/** Register catalog tools referenced by kernel integration tests. */
function registerTestTools(): void {
  registerTool({
    type: 'function',
    name: 'stub_tool',
    description: 'Test stub',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: StubInput,
    output: FindingOutput,
    handler: () => ({ finding: 'stub ok' }),
  });

  registerTool({
    type: 'function',
    name: 'existing_tool',
    description: 'Existing tool',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: ExistingInput,
    output: FindingOutput,
    handler: () => ({ finding: 'existing ok' }),
  });

  registerTool({
    type: 'function',
    name: 'load_tools',
    description: 'Load deferred tools by name',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: LoadToolsInput,
    output: LoadToolsOutput,
    handler: (input) => ({ loaded: (input as LoadToolsInputValue).names }),
  });

  registerTool({
    type: 'function',
    name: 'load_tools_consent',
    description: 'Loader requiring session consent',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'session_consent',
    input: LoadToolsInput,
    output: LoadToolsOutput,
    handler: (input) => ({ loaded: (input as LoadToolsInputValue).names }),
  });

  registerTool({
    type: 'function',
    name: 'record_lookup',
    description: 'Lookup a record',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T2',
    permission: 'auto',
    input: RecordLookupInput,
    output: FindingOutput,
    handler: (input) => ({ finding: `found ${(input as RecordLookupInputValue).q}` }),
  });

  registerTool({
    type: 'function',
    name: 'get_record_status',
    description: 'Record status',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: GetRecordInput,
    output: FindingOutput,
    handler: () => ({
      finding: 'Moisture is 45%, last watered 4 days ago.',
    }),
  });

  registerTool({
    type: 'function',
    name: 'fetch_sensor',
    description: 'Fetch sensor reading',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: SensorInput,
    output: FindingOutput,
    handler: () => ({ finding: 'Sensor raw value: 22%' }),
  });

  registerTool({
    type: 'function',
    name: 'lookup_order',
    description: 'Lookup order',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: OrderInput,
    output: FindingOutput,
    handler: () => ({ finding: 'shipped' }),
  });

  registerTool({
    type: 'function',
    name: 'crashing_tool',
    description: 'Throws on execute',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: CrashInput,
    output: FindingOutput,
    handler: () => {
      throw new Error('Database connection timed out');
    },
  });

  registerTool({
    type: 'function',
    name: 'ping_tool',
    description: 'Ping',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: PingInput,
    output: FindingOutput,
    handler: (input) => ({ finding: `pong ${(input as PingInputValue).step}` }),
  });

  registerTool({
    type: 'function',
    name: 'delete_resource',
    description: 'Delete resource',
    category: 'test',
    access: 'destructive',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'session_consent',
    input: DeleteInput,
    output: FindingOutput,
    handler: (input) => ({ finding: `deleted ${(input as DeleteInputValue).id}` }),
  });

  registerTool({
    type: 'function',
    name: 'denied_tool',
    description: 'Always denied by preTool',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: StubInput,
    output: FindingOutput,
    preTool: () => ({ deny: { code: 'not_authorized', message: 'Tool execution not authorized' } }),
    handler: () => ({ finding: 'should not run' }),
  });

  registerTool({
    type: 'function',
    name: 'throwing_auth_tool',
    description: 'preTool throws',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: StubInput,
    output: FindingOutput,
    preTool: () => {
      throw new Error('auth network failure');
    },
    handler: () => ({ finding: 'should not run' }),
  });

  registerTool({
    type: 'function',
    name: 'always_confirm_tool',
    description: 'Requires confirmation on every call',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'always_confirm',
    input: StubInput,
    output: FindingOutput,
    handler: () => ({ finding: 'confirmed ok' }),
  });

  registerTool({
    type: 'function',
    name: 'preflight_confirm_tool',
    description: 'preTool returns confirmation gate',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: StubInput,
    output: FindingOutput,
    preTool: () => ({
      confirm: { summary: 'Proceed with this action?' },
    }),
    handler: () => ({ finding: 'preflight cleared' }),
  });

  registerTool({
    type: 'function',
    name: 'streaming_probe',
    description: 'Streaming handler probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: StubInput,
    output: FindingOutput,
    handler: async function* () {
      yield { kind: 'progress', data: { pct: 50 } };
      yield {
        kind: 'trace',
        step: { name: 'step1', kind: 'test', status: 'ok' },
      };
      yield { kind: 'artifact', artifact: { id: 'art-1' } };
      yield { kind: 'warning', warning: { code: 'slow', message: 'degraded' } };
      yield { kind: 'complete', output: { finding: 'streamed ok' } };
    },
  });

  registerTool({
    type: 'function',
    name: 'web_only_tool',
    description: 'Only available on web path',
    category: 'test',
    access: 'read-only',
    paths: ['web'],
    loadTier: 'T0',
    permission: 'auto',
    input: StubInput,
    output: FindingOutput,
    handler: () => ({ finding: 'web ok' }),
  });

  registerTool({
    type: 'function',
    name: 'hidden_from_model_tool',
    description: 'Omits data from model projection',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    exposeToModel: false,
    input: StubInput,
    output: z.object({ finding: z.string(), secret: z.string() }),
    handler: () => ({ finding: 'done', secret: 'classified' }),
  });
}

async function collectToolEvents(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

/** Invoke a registered tool through the host entrypoint. */
function invokeRegisteredTool(args: InvokeToolRequest): Promise<TurnEvent[]> {
  return collectToolEvents(invokeTool(args));
}

function withProfileTools(
  profile: Exclude<Profile, import('../../src/kernel/types.ts').SpeechProfile>,
  extraAllow: string[],
): typeof profile {
  return {
    ...profile,
    tools: { allow: [...profile.tools.allow, ...extraAllow] },
  };
}

export { collectToolEvents, invokeRegisteredTool, registerTestTools, withProfileTools };
