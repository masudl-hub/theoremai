import '../fixtures/test-host.ts';
import { z } from 'zod';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  checkPermission,
  executeBuiltin,
  executeFunction,
  extractLoadedIds,
  formatToolFailureForModel,
  formatToolResult,
  isResumeContinuation,
  isToolPause,
  notLoadedMessage,
  permissionGranted,
  plainToolInput,
  projectForModel,
  startToolExecution,
  yieldHandlerSideEvent,
} from '../../src/kernel/tools/execute.ts';
import { registerTool } from '../../src/kernel/tools/registry.ts';
import {
  applyBuiltinMutualExclusions,
  buildWire,
  cloneTurnToolSnapshot,
  expandT1Policy,
  initialBuiltins,
  initialVisible,
  pathMatches,
  promoteBuiltin,
  promoteLoadedTools,
  promoteTool,
  promotionFailure,
  resolveAllowedCustomToolIds,
  resolveModelBuiltinIds,
  wireForTool,
} from '../../src/kernel/tools/resolve.ts';
import type {
  FunctionToolDef,
  ToolContext,
  ToolPause,
  TurnToolSnapshot,
} from '../../src/kernel/tools/types.ts';
import type { Profile, ProviderCompleteRequest, TurnRequest } from '../../src/kernel/types.ts';
import {
  emitPendingFunctionCall,
  emitUniqueToolEvent,
  eventType,
  foldCompleteEvents,
  foldInteractionSteps,
  foldStepStop,
  functionCallKey,
  isCompleteCodeStep,
  isCompleteEvent,
  isDeltaEvent,
  isRawPcmMime,
  isVoiceProfile,
  missingSpeechAudioError,
  newStreamFold,
  parseArgumentsObject,
  readApiErrorMessage,
  readData,
  readMime,
  readNonOkErrorMessage,
  type StreamFold,
  scanInteractionsMedia,
  scanMediaParts,
  shouldReportMissingSpeechAudio,
  yieldEvidenceStep,
  yieldGrounding,
  yieldTokens,
} from '../../src/providers/google/interactions/stream.ts';

type ToolPhaseEvent = {
  tool: {
    phase: string;
    data?: unknown;
    step?: { name: string };
    artifact?: { id: string };
    warning?: { code: string };
    failure?: { code: string; message: string };
    pause?: { kind: string };
  };
};
type NamedWire = { name: string };
type MediaEvent = { type?: string; media: { mimeType: string } };
type PromoteResult = { promoted: string[] };
type FailureInfo = { message?: string; code?: string };

function asValue<T>(value: unknown): T {
  return value as T;
}

function asIter<T>(value: unknown): T[] {
  return [...(value as Iterable<T>)];
}

function toolEventAt(events: unknown[], index: number): ToolPhaseEvent {
  return asValue<ToolPhaseEvent>(events[index]);
}

const base = { name: 'probe', callId: 'c1', arguments: {} };

Deno.test('tools mutation helpers classify resume, pauses, and permissions precisely', () => {
  assertEquals(isResumeContinuation(undefined), false);
  assertEquals(isResumeContinuation({}), false);
  assertEquals(isResumeContinuation({ granted: true }), true);
  assertEquals(isResumeContinuation({ value: 0 }), true);
  assertEquals(isResumeContinuation({ value: undefined, granted: false }), false);

  assertEquals(isToolPause({ kind: 'interactive', tool: 'probe', input: {} }), true);
  assertEquals(isToolPause({ kind: 'confirmation', tool: 'probe', input: {} }), true);
  assertEquals(isToolPause({ kind: 'permission', tool: 'probe', input: {} }), true);
  assertEquals(isToolPause({ code: 'x', message: 'failure' }), false);

  assertEquals(permissionGranted('probe', undefined), false);
  assertEquals(permissionGranted('probe', []), false);
  assertEquals(permissionGranted('probe', ['probe']), true);
  assertEquals(permissionGranted('probe', ['*']), true);
  assertEquals(permissionGranted('probe', ['other']), false);

  assertEquals(checkPermission('probe', 'auto'), null);
  assertEquals(checkPermission('probe', 'always_confirm', ['probe']), {
    kind: 'permission',
    tool: 'probe',
    permission: 'always_confirm',
    input: {},
  });
  assertEquals(checkPermission('probe', 'always_confirm', undefined, { granted: true }), null);
  assertEquals(checkPermission('probe', 'session_consent', ['probe']), null);
  assertEquals(
    asValue<{ kind?: string } | null | undefined>(
      checkPermission('probe', 'session_consent', undefined),
    )?.kind,
    'permission',
  );
});

Deno.test('tools mutation helpers preserve side-event payloads', () => {
  const sideEvents = [
    { kind: 'progress' as const, data: { n: 1 } },
    { kind: 'trace' as const, step: { name: 's', kind: 'test', status: 'ok' } },
    { kind: 'artifact' as const, artifact: { id: 'a' } },
    { kind: 'warning' as const, warning: { code: 'w', message: 'slow' } },
  ];
  const events = sideEvents.flatMap((event) =>
    asIter<ToolPhaseEvent>(yieldHandlerSideEvent(base, event)),
  );
  assertEquals(
    events.map((event) => event.tool.phase),
    ['progress', 'trace', 'artifact', 'warning'],
  );
  assertEquals(events[0]?.tool.data, { n: 1 });
  assertEquals(events[1]?.tool.step?.name, 's');
  assertEquals(events[2]?.tool.artifact?.id, 'a');
  assertEquals(events[3]?.tool.warning?.code, 'w');
});

Deno.test('tools mutation helpers project and format model results exactly', () => {
  const visible = { exposeToModel: true } as FunctionToolDef;
  const hidden = { exposeToModel: false } as FunctionToolDef;
  assertEquals(projectForModel(hidden, { finding: 'secret' }), { finding: 'Completed.' });
  assertEquals(projectForModel(visible, { finding: 'hello' }), {
    finding: 'hello',
    data: { finding: 'hello' },
  });
  assertEquals(projectForModel(visible, { value: 2 }), {
    finding: '{"value":2}',
    data: { value: 2 },
  });
  assertEquals(formatToolResult({ finding: 'ok' }), 'ok');
  assertEquals(formatToolResult({ finding: 'ok', data: { n: 1 } }), 'ok\n{"n":1}');
  assertEquals(formatToolFailureForModel({ code: 'bad', message: 'no' }), {
    finding: 'Tool error (bad): no',
    data: { ok: false, code: 'bad', message: 'no' },
  });
  assertEquals(formatToolFailureForModel({ code: 'bad', message: 'no', details: { field: 'x' } }), {
    finding: 'Tool error (bad): no',
    data: { ok: false, code: 'bad', message: 'no', details: { field: 'x' } },
  });
});

Deno.test('tools mutation helpers validate loaded ids and sanitize nested input', () => {
  assertEquals(
    notLoadedMessage(asValue<FunctionToolDef>({ name: 'probe', loadTier: 'T0' })),
    "Tool 'probe' is not visible this turn",
  );
  assertEquals(
    notLoadedMessage(asValue<FunctionToolDef>({ name: 'one', loadTier: 'T1' })),
    "Tool 'one' is not wired — profile.tools.t1Policy must select it",
  );
  assertEquals(
    notLoadedMessage(asValue<FunctionToolDef>({ name: 'two', loadTier: 'T2' })),
    "Tool 'two' is not loaded — run profile.tools.t2Loader first",
  );
  assertEquals(extractLoadedIds(null), undefined);
  assertEquals(extractLoadedIds([]), undefined);
  assertEquals(extractLoadedIds({ loaded: [] }), []);
  assertEquals(extractLoadedIds({ loaded: ['a', 'b'] }), ['a', 'b']);
  assertEquals(extractLoadedIds({ loaded: ['a', 2] }), undefined);
  const polluted = JSON.parse(
    '{"safe":{"x":1},"__proto__":{"polluted":true},"constructor":{"x":2},"prototype":{"x":3}}',
  );
  assertEquals(plainToolInput(polluted), { safe: { x: 1 } });
  assertEquals(plainToolInput([null, 2, { x: 'y' }]), [null, 2, { x: 'y' }]);
  assertEquals(plainToolInput('x'), 'x');
});

Deno.test('tools mutation helpers filter paths, wire tools, and clone snapshots', () => {
  assertEquals(pathMatches(['*'], undefined), true);
  assertEquals(pathMatches(['web'], undefined), false);
  assertEquals(pathMatches(['web'], 'web'), true);
  assertEquals(pathMatches(['web'], 'cli'), false);
  assertEquals(initialVisible(['stub_tool', 'record_lookup']), ['stub_tool']);
  assertEquals(initialBuiltins(['googleSearch']), ['googleSearch']);
  const snapshot: TurnToolSnapshot = {
    builtins: [],
    gated: ['stub_tool'],
    visible: ['stub_tool'],
    executable: ['stub_tool'],
    path: 'web',
    sessionPermissions: ['x'],
    wire: [],
  };
  const cloned = asValue<TurnToolSnapshot>(cloneTurnToolSnapshot(snapshot));
  cloned.visible.push('changed');
  cloned.sessionPermissions?.push('changed');
  assertEquals(snapshot.visible, ['stub_tool']);
  assertEquals(snapshot.sessionPermissions, ['x']);
});

Deno.test('tools mutation coverage exercises resolver filtering and builtin promotion', () => {
  assertEquals(applyBuiltinMutualExclusions(['googleSearch', 'googleMaps']), [
    'googleSearch',
    'googleMaps',
  ]);
  assertEquals(
    resolveAllowedCustomToolIds(
      asValue<Profile>({
        tools: { allow: ['stub_tool', 'record_lookup', 'googleSearch', 'missing'] },
      }),
      asValue<TurnRequest>({ path: 'web' }),
    ),
    ['stub_tool', 'record_lookup'],
  );
  assertEquals(
    resolveModelBuiltinIds(
      asValue<Profile>({
        model: { config: { m: { builtInTools: ['googleSearch', 'stub_tool', 'missing'] } } },
      }),
      asValue<TurnRequest>({ path: 'web' }),
      'm',
    ),
    ['googleSearch'],
  );
  assertEquals(
    resolveModelBuiltinIds(
      asValue<Profile>({ model: { config: {} } }),
      asValue<TurnRequest>({ path: 'web' }),
      'missing',
    ),
    [],
  );
  assertEquals(asValue<NamedWire>(wireForTool('stub_tool')).name, 'stub_tool');
  assertEquals(wireForTool('googleSearch'), undefined);
  assertEquals(wireForTool('missing'), undefined);
  assertEquals(
    asValue<NamedWire[]>(buildWire(['stub_tool', 'googleSearch', 'missing'])).map(
      (wire) => wire.name,
    ),
    ['stub_tool'],
  );

  const state: TurnToolSnapshot = {
    builtins: ['googleSearch'],
    gated: ['googleSearch', 'googleMaps'],
    visible: [],
    executable: [],
    wire: [],
  };
  promoteBuiltin(state, 'googleSearch');
  promoteBuiltin(state, 'googleMaps');
  assertEquals(state.builtins, ['googleSearch', 'googleMaps']);
  promoteBuiltin(state, 'stub_tool');
  assertEquals(state.builtins, ['googleSearch', 'googleMaps']);
  assertEquals(
    asValue<FailureInfo | undefined>(
      promotionFailure('stub_tool', asValue<Profile>({ tools: { allow: ['stub_tool'] } })),
    )?.message,
    "tools.t2Loader attempted to promote tool 'stub_tool' with loadTier 'T0' — only T2 tools may be promoted",
  );
  assertEquals(
    asValue<FailureInfo | undefined>(
      promotionFailure('missing', asValue<Profile>({ tools: { allow: [] } })),
    )?.code,
    'invalid_output',
  );
  assertEquals(
    promotionFailure('record_lookup', asValue<Profile>({ tools: { allow: ['record_lookup'] } })),
    undefined,
  );
});

Deno.test('tools mutation helpers reject invalid promotion and preserve state atomically', () => {
  const profile = { tools: { allow: ['record_lookup'] } } as Profile;
  const state: TurnToolSnapshot = {
    builtins: [],
    gated: ['record_lookup'],
    visible: [],
    executable: [],
    path: 'web',
    wire: [],
  };
  for (const id of ['__proto__', 'constructor', 'prototype', 'missing', 'stub_tool']) {
    const result = asValue<PromoteResult>(promoteLoadedTools(state, [id], profile));
    assertEquals(result.promoted, []);
    assertEquals(state.visible, []);
  }
  const result = asValue<PromoteResult>(promoteLoadedTools(state, ['record_lookup'], profile));
  assertEquals(result.promoted, ['record_lookup']);
  assertEquals(state.visible, ['record_lookup']);
  assertEquals(state.executable, ['record_lookup']);
});

Deno.test('tools mutation coverage exercises Interactions media and API error helpers', async () => {
  assertEquals(readData({ data: 'abc' }), 'abc');
  assertEquals(readData({ data: '' }), undefined);
  assertEquals(readData({ data: 1 }), undefined);
  assertEquals(readMime({ mime_type: 'image/png' }), 'image/png');
  assertEquals(readMime({ mimeType: 'audio/wav' }), 'audio/wav');
  assertEquals(readMime({ mimeType: '' }), undefined);

  const media = asIter<MediaEvent>(
    scanMediaParts([
      null,
      { type: 'image', data: 'a', mime_type: 'image/png' },
      { type: 'audio', data: 'b', mimeType: 'audio/mpeg' },
      { type: 'media', data: 'c', mimeType: 'video/mp4' },
      { type: 'video', data: 'd', mimeType: 'video/mp4' },
      { type: 'text', data: 'ignored' },
    ]),
  );
  assertEquals(media.length, 4);
  assertEquals(
    media.map((event) => event.media.mimeType),
    ['image/png', 'audio/mpeg', 'video/mp4', 'video/mp4'],
  );
  assertEquals(asIter(scanMediaParts({})), []);
  assertEquals(
    asIter(scanInteractionsMedia({ steps: [{ content: [{ type: 'image', data: 'x' }] }] })).length,
    1,
  );
  assertEquals(asIter(scanInteractionsMedia({ steps: [null, 2] })), []);

  assertEquals(readApiErrorMessage({}), null);
  assertEquals(readApiErrorMessage({ error: null }), null);
  assertEquals(readApiErrorMessage({ error: { message: 'bad' } }), 'bad');
  assertEquals(
    readApiErrorMessage({ error: { message: 'bad', status: 'INVALID_ARGUMENT' } }),
    'INVALID_ARGUMENT: bad',
  );
  assertEquals(readApiErrorMessage({ error: { message: '' } }), 'Gemini returned an error.');
  assertEquals(readApiErrorMessage({ error: { message: 4 } }), 'Gemini returned an error.');
  assertEquals(await readNonOkErrorMessage(new Response('', { status: 503 })), 'HTTP 503');
  assertEquals(
    await readNonOkErrorMessage(new Response('not json', { status: 400 })),
    'Gemini HTTP 400: not json',
  );
  assertEquals(
    await readNonOkErrorMessage(new Response('{"error":{"message":"bad"}}', { status: 400 })),
    'bad',
  );
  assertEquals(
    await readNonOkErrorMessage(new Response('{"error":{}}', { status: 400 })),
    'Gemini returned an error.',
  );
});

Deno.test('tools mutation coverage distinguishes voice synthesis conditions', () => {
  const plain = asValue<ProviderCompleteRequest>({ text: 'hello', speech: undefined });
  const voice = asValue<ProviderCompleteRequest>({
    text: 'hello',
    speech: { voice: 'Kore', format: 'pcm' },
  });
  const empty = asValue<ProviderCompleteRequest>({
    text: '',
    speech: { voice: 'Kore', format: 'pcm' },
  });
  const mediaFold = asValue<StreamFold>(newStreamFold());
  mediaFold.sawStreamedMedia = true;
  const textFold = asValue<StreamFold>(newStreamFold());
  textFold.text = 'hello';
  assertEquals(isVoiceProfile(plain), false);
  assertEquals(isVoiceProfile(voice), true);
  assertEquals(shouldReportMissingSpeechAudio(plain, newStreamFold()), false);
  assertEquals(shouldReportMissingSpeechAudio(voice, textFold), true);
  assertEquals(shouldReportMissingSpeechAudio(empty, newStreamFold()), true);
  assertEquals(shouldReportMissingSpeechAudio(voice, mediaFold), false);
  const missing = asIter<{ type?: string }>(missingSpeechAudioError());
  assertEquals(missing.length, 1);
  assertEquals(missing[0]?.type, 'error');
});

Deno.test('tools mutation coverage exercises stream fold primitives', () => {
  assertEquals(isRawPcmMime('audio/pcm;rate=24000'), true);
  assertEquals(isRawPcmMime('AUDIO/RAW'), true);
  assertEquals(isRawPcmMime('audio/l16'), true);
  assertEquals(isRawPcmMime('audio/wav'), false);
  assertEquals(eventType({ event_type: 'x', type: 'y' }), 'x');
  assertEquals(eventType({ type: 'y' }), 'y');
  assertEquals(eventType({}), '');
  assertEquals(isDeltaEvent('content.delta'), true);
  assertEquals(isDeltaEvent('step.delta'), true);
  assertEquals(isDeltaEvent('other'), false);
  assertEquals(isCompleteEvent('interaction.complete'), true);
  assertEquals(isCompleteEvent('interaction.completed'), true);
  assertEquals(isCompleteEvent('other'), false);
  assertEquals(functionCallKey({ name: 'a', id: '1', arguments: { x: 1 } }), 'a:1:{"x":1}');
  assertEquals(functionCallKey({}), '::{}');
  assertEquals(parseArgumentsObject('{"x":1}'), { ok: true, value: { x: 1 } });
  assertEquals(parseArgumentsObject('{bad').ok, false);
  assertEquals(parseArgumentsObject({ x: 1 }), { ok: true, value: { x: 1 } });
  assertEquals(parseArgumentsObject([1]).ok, false);
  assertEquals(parseArgumentsObject(1).ok, false);
  assertEquals(isCompleteCodeStep({ arguments: {} }), true);
  assertEquals(isCompleteCodeStep({ result: {} }), true);
  assertEquals(isCompleteCodeStep({}), false);

  const fold: StreamFold = newStreamFold();
  const emitted = new Set<string>();
  assertEquals(asIter(yieldGrounding({})), []);
  assertEquals(asIter(yieldTokens({})), []);
  assertEquals(asIter(yieldEvidenceStep({}, emitted)).length, 1);
  assertEquals(asIter(foldStepStop({ index: 1 }, fold)), []);
  assertEquals(asIter(foldInteractionSteps({ steps: [] }, fold)), []);
  assertEquals(
    asIter(
      foldInteractionSteps(
        { steps: [{ type: 'function_call', id: 'i', name: 'n', arguments: '{}' }] },
        fold,
      ),
    ).length,
    1,
  );
  assertEquals(asIter(foldCompleteEvents({}, fold)), []);
  assertEquals(asIter(emitPendingFunctionCall(1, fold)), []);
  assertEquals(asIter(emitUniqueToolEvent({ name: 'n', arguments: {} }, fold)).length, 1);
  assertEquals(asIter(emitUniqueToolEvent({ name: 'n', arguments: {} }, fold)).length, 0);
});

Deno.test('tools mutation coverage asserts low-level execution event payloads', async () => {
  const input = z.object({ value: z.number() });
  const context = asValue<ToolContext>({ signal: undefined });
  const valid = startToolExecution({ input }, { value: 2 }, context, base) as Generator;
  assertEquals(valid.next().value, { type: 'tool', tool: { ...base, phase: 'running' } });
  assertEquals(valid.next().value, { ok: true, data: { value: 2 } });

  const invalid = startToolExecution({ input }, { value: 'bad' }, context, base) as Generator;
  invalid.next();
  assertEquals(
    asValue<{ tool: { failure: { code: string } } }>(invalid.next().value).tool.failure.code,
    'invalid_input',
  );
  assertEquals(invalid.next().value, { ok: false });

  const builtinCtx = asValue<ToolContext>({});
  const builtin = executeBuiltin(
    { name: 'googleSearch' },
    builtinCtx,
    base,
    asValue<TurnToolSnapshot>({
      builtins: ['googleSearch'],
    }),
  ) as AsyncGenerator;
  assertEquals((await builtin.next()).value.tool.phase, 'running');
  assertEquals((await builtin.next()).value.tool.failure.code, 'provider_native');
  const missing = executeBuiltin(
    { name: 'googleSearch' },
    builtinCtx,
    base,
    asValue<TurnToolSnapshot>({
      builtins: [],
    }),
  ) as AsyncGenerator;
  await missing.next();
  assertEquals((await missing.next()).value.tool.failure.code, 'not_loaded');
});

Deno.test('tools mutation coverage exercises resolver duplicate and conflict transitions', () => {
  registerTool({
    type: 'builtin',
    name: 'conflict_one',
    description: 'one',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    wire: {},
    conflictsWith: ['conflict_two'],
  });
  registerTool({
    type: 'builtin',
    name: 'conflict_two',
    description: 'two',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    wire: {},
    conflictsWith: ['conflict_one'],
  });
  assertEquals(applyBuiltinMutualExclusions(['conflict_one', 'conflict_two']), []);

  const state: TurnToolSnapshot = {
    builtins: ['conflict_one'],
    gated: ['stub_tool'],
    visible: ['stub_tool'],
    executable: ['stub_tool'],
    wire: [{ type: 'function', name: 'stub_tool', description: 'old', parameters: { a: 1 } }],
  };
  promoteTool(state, 'stub_tool');
  assertEquals(state.visible, ['stub_tool']);
  assertEquals(state.wire.length, 1);
  promoteTool(state, 'record_lookup');
  assertEquals(state.visible, ['stub_tool', 'record_lookup']);
  assertEquals(
    state.wire.map((wire) => wire.name),
    ['stub_tool', 'record_lookup'],
  );
  promoteBuiltin(state, 'conflict_two');
  assertEquals(state.builtins, ['conflict_two']);
  promoteBuiltin(state, 'conflict_two');
  assertEquals(state.builtins, ['conflict_two']);
});

Deno.test('tools mutation coverage exercises policy and function execution transitions', async () => {
  const state = {
    builtins: [],
    gated: ['record_lookup'],
    visible: [],
    executable: [],
    path: 'web',
    wire: [],
  } as TurnToolSnapshot;
  await expandT1Policy(
    state,
    asValue<Profile>({
      id: 'profile',
      tools: { allow: ['record_lookup'], t1Policy: () => ['record_lookup'] },
    }),
    asValue<TurnRequest>({ path: 'web', input: { text: 'x' } }),
  );
  assertEquals(state.visible, ['record_lookup']);
  assertEquals(state.executable, ['record_lookup']);
  await expandT1Policy(
    state,
    asValue<Profile>({
      id: 'profile',
      tools: { allow: ['record_lookup'], t1Policy: () => ['missing', 'record_lookup'] },
    }),
    asValue<TurnRequest>({ path: 'web' }),
  );

  const makeTool = (overrides: Record<string, unknown> = {}): FunctionToolDef =>
    asValue<FunctionToolDef>({
      type: 'function',
      name: `mutation_tool_${Math.random()}`,
      description: 'mutation test tool',
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier: 'T0',
      permission: 'auto',
      input: z.object({ value: z.number() }),
      output: z.object({ finding: z.string() }),
      inputSchema: {},
      outputSchema: {},
      handler: () => ({ finding: 'ok' }),
      ...overrides,
    });
  const ctx = asValue<ToolContext>({
    profile: { id: 'p', tools: { allow: ['x'] } },
    callId: 'c',
  });
  const run = async (tool: FunctionToolDef, input: unknown, context: ToolContext = ctx) => {
    const gen = executeFunction(tool, input, context, base) as AsyncGenerator;
    const events: unknown[] = [];
    for await (const event of gen) events.push(event);
    return events;
  };

  const denied = await run(makeTool({ canExecute: () => false }), { value: 1 });
  assertEquals(toolEventAt(denied, 1).tool.failure?.code, 'not_authorized');
  const authError = await run(
    makeTool({
      canExecute: () => {
        throw new Error('nope');
      },
    }),
    { value: 1 },
  );
  assertEquals(toolEventAt(authError, 1).tool.failure?.message.includes('nope'), true);
  const preflightFailure = await run(
    makeTool({ preflight: () => ({ code: 'blocked', message: 'stop' }) }),
    { value: 1 },
  );
  assertEquals(toolEventAt(preflightFailure, 1).tool.failure?.code, 'blocked');
  const preflightPause = await run(
    makeTool({
      preflight: (input: unknown): ToolPause => ({
        kind: 'confirmation',
        tool: 'x',
        input,
      }),
    }),
    { value: 1 },
  );
  assertEquals(toolEventAt(preflightPause, 1).tool.pause?.kind, 'confirmation');
  const interactive = await run(
    makeTool({ interactive: { render: () => ({ kind: 'choice', prompt: 'pick' }) } }),
    { value: 1 },
  );
  assertEquals(toolEventAt(interactive, 1).tool.pause?.kind, 'interactive');
  const noOutput = await run(makeTool({ handler: () => undefined }), { value: 1 });
  assertEquals(toolEventAt(noOutput, 1).tool.failure?.code, 'invalid_output');
  const badOutput = await run(makeTool({ handler: () => ({ finding: 3 }) }), { value: 1 });
  assertEquals(toolEventAt(badOutput, 1).tool.failure?.code, 'invalid_output');
  const handlerError = await run(
    makeTool({
      handler: () => {
        throw new Error('boom');
      },
    }),
    { value: 1 },
  );
  assertEquals(toolEventAt(handlerError, 1).tool.failure?.code, 'handler_error');
  const streamTool = makeTool({
    handler: async function* () {
      yield { kind: 'progress', data: 1 };
      yield { kind: 'complete', output: { finding: 'streamed' } };
    },
  });
  const streamed = await run(streamTool, { value: 1 });
  assertEquals(toolEventAt(streamed, 1).tool.phase, 'progress');
  assertEquals(toolEventAt(streamed, 2).tool.phase, 'complete');
});
