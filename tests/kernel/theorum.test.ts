import '../fixtures/test-host.ts';
import { PUBLIC_CANARY, TheorumError } from '../../src/guardrails/error.ts';
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '../../src/kernel/engine/assert.ts';
import { synthesizeRepairPrompt } from '../../src/kernel/engine/repair.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  modelEntryByApiId,
} from '../../src/kernel/registry/catalog.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { projectProfile, resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type {
  EgressContext,
  ModelProvider,
  ProfileId,
  ProviderCompleteRequest,
  ToolId,
  TurnEvent,
  TurnRequest,
} from '../../src/kernel/types.ts';
import { geminiModel, HOST_MODELS, modelAllow } from '../fixtures/models.ts';
import { invokeRegisteredTool, withProfileTools } from '../fixtures/test-tools.ts';

Deno.test('runner internal helper branches: loaders, tool findings, step ceilings, and fallback handlers', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'dynamic_runner_bot',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 3 },
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
      outputs: { structured: null },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'loader_runner_bot',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 2 },
      tools: { allow: ['record_lookup'] },
      inputs: { text: true },
      outputs: { structured: null },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  // 1. Deferred tool not loaded yet -> not_loaded error
  const mockDeferredProvider: ModelProvider = {
    complete: () => {
      return (async function* () {
        yield {
          type: 'tool',
          tool: { name: 'record_lookup', arguments: { q: 'test' } },
        };
        yield { type: 'text', text: 'done' };
        yield { type: 'done' };
      })();
    },
  };

  const deferredEvents: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'loader_runner_bot',
      input: { text: 'lookup without loader' },
    },
    mockDeferredProvider,
  )) {
    deferredEvents.push(ev);
  }
  const deferredTool = deferredEvents.find((e) => e.type === 'tool');
  assertEquals(deferredTool?.tool?.phase, 'error');
  assertStringIncludes(deferredTool?.tool?.failure?.message ?? '', 'not loaded');

  // 2. Registered tool on multi-step profile executes and continues
  const noHandlerReq: TurnRequest = {
    profile: 'dynamic_runner_bot',
    input: { text: 'run stub' },
  };
  let callCount = 0;
  const noHandlerProvider: ModelProvider = {
    complete: () => {
      return (async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: 'tool',
            tool: { name: 'stub_tool', arguments: { value: 123 } },
          };
        } else {
          yield { type: 'text', text: 'finished' };
        }
      })();
    },
  };
  const stubEvents: TurnEvent[] = [];
  for await (const ev of runTurn(noHandlerReq, noHandlerProvider)) {
    stubEvents.push(ev);
  }
  const textEv = stubEvents.find((e) => e.type === 'text');
  assertEquals(textEv?.text, 'finished');

  // 3. Catalog registration is the source of truth for tool metadata
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'existing_tool_bot',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['existing_tool'] },
      inputs: { text: true },
      outputs: { structured: null },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const updateReq: TurnRequest = {
    profile: 'existing_tool_bot',
    input: { text: 'run existing' },
  };
  const updateProvider: ModelProvider = {
    complete: () => {
      return (async function* () {
        yield {
          type: 'tool',
          tool: { name: 'existing_tool', arguments: {} },
        };
        yield { type: 'text', text: 'updated' };
        yield { type: 'done' };
      })();
    },
  };
  for await (const _ev of runTurn(updateReq, updateProvider)) {
    // drain
  }
});

Deno.test('runTurn emits one final done when provider also emits done', async () => {
  const provider: ModelProvider = {
    complete: () => {
      return (async function* () {
        yield { type: 'text', text: 'single terminal event' };
        yield { type: 'tokens', tokens: { input: 1, output: 1, total: 2 } };
        yield { type: 'done' };
      })();
    },
  };

  const events: TurnEvent[] = [];
  for await (const ev of runTurn({ profile: 'chat', input: { text: 'ping' } }, provider)) {
    events.push(ev);
  }

  assertEquals(events.filter((event) => event.type === 'done').length, 1);
  assertEquals(events.at(-1)?.type, 'done');
});

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

async function* fakeComplete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
  await Promise.resolve();
  yield { type: 'text', text: `${req.model}:${req.thinking}` };
  if (req.structured) {
    yield { type: 'structured', structured: { schema: req.structured } };
  }
  if (req.image) {
    yield {
      type: 'media',
      media: { mimeType: req.image.mimeType ?? 'image/png', data: 'vinyl-bytes' },
    };
  }
}

const fake: ModelProvider = { complete: fakeComplete };

const LONG_FLASH = 40_000;

function withTools(id: ProfileId, extra: ToolId[]) {
  const profile = getProfile(id);
  if (profile.type === 'speech') {
    throw new Error(`withTools: profile '${id}' is speech`);
  }
  return withProfileTools(profile, extra);
}

Deno.test('every profile is oneshot', () => {
  const ids: ProfileId[] = ['chat', 'pinned', 'formatter', 'selector', 'image'];
  for (const id of ids) {
    assertEquals(getProfile(id).model.maxSteps, 1);
  }
});

Deno.test('runTurn accepts an omitted input object', async () => {
  registerProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    tools: { allow: [] },
    inputs: { text: true },
    id: 'no_input_bot',
    model: { ...geminiModel('gemini35FlashLite') },
  });

  const provider: ModelProvider = {
    async *complete() {
      await Promise.resolve();
      yield { type: 'text', text: 'empty input ok' };
    },
  };
  const events = await collect(runTurn({ profile: 'no_input_bot' }, provider));

  assertEquals(events.find((e) => e.type === 'text')?.text, 'empty input ok');
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('flash lite thinking off is minimal', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    thinking: false,
    input: { text: 'hi' },
  });
  assertEquals(generation.model, 'gemini35FlashLite');
  assertEquals(generation.thinking, 'minimal');
  assertEquals(generation.summaries, 'none');
  assertEquals(HOST_MODELS.gemini35FlashLite.thinking?.off, 'minimal');
});

Deno.test('thinking level shapes differ by model family', () => {
  assertEquals(HOST_MODELS.gemini31FlashLite.thinkingLevels, ['minimal', 'low', 'medium', 'high']);
  assertEquals(HOST_MODELS.gemini35FlashLite.thinkingLevels, ['minimal', 'low', 'medium', 'high']);
  assertEquals(HOST_MODELS.gemini31ProPreview.thinkingLevels, ['low', 'medium', 'high']);
  assertEquals(HOST_MODELS.gemini31FlashLiteImage.thinkingLevels, ['minimal', 'high']);
  assertEquals(HOST_MODELS.gemini31ProPreview.thinking?.off, 'low');
  assertEquals(clampThinkingLevel(HOST_MODELS.gemini31ProPreview, 'minimal'), 'low');
  assertEquals(clampThinkingLevel(HOST_MODELS.gemini31FlashLite, 'minimal'), 'minimal');
  assertEquals(
    modelEntryByApiId(HOST_MODELS, 'gemini-3.5-flash-lite')?.apiId,
    'gemini-3.5-flash-lite',
  );
  assertEquals(clampThinkingLevelForApiId(HOST_MODELS, 'gemini-3.1-pro-preview', 'minimal'), 'low');
  assertEquals(modelEntryByApiId(HOST_MODELS, 'unknown-model-api-id'), undefined);
});

Deno.test('flash lite thinking on is high', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    thinking: true,
    input: { text: 'hi' },
  });
  assertEquals(generation.thinking, 'high');
  assertEquals(generation.summaries, 'auto');
});

Deno.test('pinned profile uses fixed thinking without a control', () => {
  const { generation } = resolveTurn({ profile: 'pinned', input: {} });
  assertEquals(generation.thinking, 'low');
  assertEquals(projectProfile('pinned').model.controls, []);
});

Deno.test('selectable profile picks model and pinned thinking', () => {
  const fast = resolveTurn({
    profile: 'selector',
    select: 'fast',
    input: { text: 'x' },
  });
  assertEquals(fast.generation.model, 'gemini35FlashLite');
  assertEquals(fast.generation.thinking, 'low');
  assertEquals(fast.generation.maxOutputTokens, LONG_FLASH);
  const smart = resolveTurn({
    profile: 'selector',
    select: 'smart',
    input: { text: 'x' },
  });
  assertEquals(smart.generation.model, 'gemini31ProPreview');
  assertEquals(smart.generation.thinking, 'high');
});

Deno.test('model builtInTools lists search and maps when both are allowlisted', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'mutex_grounding',
      model: {
        thinking: 'minimal',
        key: 'slotA',
        protocol: 'geminiInteractions',
        provider: 'google',
        allow: ['gemini35FlashLite'],
        config: {
          gemini35FlashLite: {
            ...getProfile('chat').model.config.gemini35FlashLite,
            builtInTools: ['googleSearch', 'googleMaps'],
          },
        },
        maxSteps: 1,
      },
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const { generation } = resolveTurn({
    profile: 'mutex_grounding',
    input: { text: 'x' },
  });
  assertEquals(generation.builtins, ['googleSearch', 'googleMaps']);
});

Deno.test('model builtInTools ceiling blocks unlisted builtins', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'ceiling_grounding',
      model: {
        thinking: 'minimal',
        key: 'slotA',
        protocol: 'geminiInteractions',
        provider: 'google',
        allow: ['gemini35FlashLite'],
        config: {
          gemini35FlashLite: {
            ...getProfile('chat').model.config.gemini35FlashLite,
            builtInTools: ['googleSearch', 'googleMaps'],
          },
        },
        maxSteps: 1,
      },
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const { generation } = resolveTurn({
    profile: 'ceiling_grounding',
    input: { text: 'x' },
  });
  assertEquals(generation.builtins, ['googleSearch', 'googleMaps']);
});

Deno.test('allow puts T0 custom tools on the wire; builtins follow the model', () => {
  const idle = resolveTurn({ profile: 'chat', input: { text: 'x' } });
  assertEquals(idle.generation.builtins, []);
  assertEquals(idle.generation.tools.visible, []);
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'search_on_model',
      model: {
        thinking: 'minimal',
        key: 'slotA',
        protocol: 'geminiInteractions',
        provider: 'google',
        allow: ['gemini35FlashLite'],
        config: {
          gemini35FlashLite: {
            ...getProfile('chat').model.config.gemini35FlashLite,
            builtInTools: ['googleSearch'],
          },
        },
        maxSteps: 1,
      },
      tools: { allow: ['ask_user'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const search = resolveTurn({
    profile: 'search_on_model',
    input: { text: 'x' },
  });
  assertEquals(search.generation.builtins, ['googleSearch']);
  assertEquals(search.generation.tools.visible.includes('ask_user'), true);
});

Deno.test('language slot picks structured schema', () => {
  const html = resolveTurn({
    profile: 'formatter',
    input: { text: 'x', slots: { language: 'html' } },
  });
  assertEquals(html.generation.structured, 'htmlTurn');
  const tsx = resolveTurn({
    profile: 'formatter',
    input: { text: 'x', slots: { language: 'tsx' } },
  });
  assertEquals(tsx.generation.structured, 'tsxTurn');
});

Deno.test('disallowed tool cannot run', async () => {
  const events = await invokeRegisteredTool({
    profile: 'pinned',
    name: 'ask_user',
    input: { kind: 'text', prompt: 'q' },
  });
  const toolEv = events.find((e) => e.type === 'tool');
  assertEquals(toolEv?.tool?.phase, 'error');
});

Deno.test('ask_user pauses when allowed', async () => {
  registerProfile({
    ...withTools('chat', ['ask_user']),
    id: 'ask_user_bot',
  });
  const events = await invokeRegisteredTool({
    profile: 'ask_user_bot',
    name: 'ask_user',
    input: { kind: 'text', prompt: 'which?' },
  });
  const toolEv = events.find((e) => e.type === 'tool' && e.tool?.phase === 'pause');
  assertEquals(Boolean(toolEv), true);
});

Deno.test('invokeTool ask_user is denied until allowed', async () => {
  const events = await invokeRegisteredTool({
    profile: 'pinned',
    name: 'ask_user',
    input: { kind: 'text', prompt: 'q' },
  });
  const toolEv = events.findLast((e) => e.type === 'tool' && e.tool?.name === 'ask_user');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'not_allowed');
});

Deno.test('runTurn oneshot yields text structured done', async () => {
  const events = await collect(runTurn({ profile: 'chat', input: { text: 'flow' } }, fake));
  assertEquals(
    events.map((e) => e.type),
    ['text', 'structured', 'tokens', 'done'],
  );
});

Deno.test('projection lists only allowed tools', () => {
  const ui = projectProfile('formatter');
  assertEquals(
    ui.tools.map((t) => t.name),
    [],
  );
  assertEquals(ui.model.controls, ['thinking']);
  assertEquals(ui.inputs?.voice, undefined);
});

Deno.test('unknown profile select is rejected', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'selector',
        select: 'turbo',
        input: { text: 'x' },
      }),
    TheorumError,
  );
});

Deno.test('ask_user validates kind and prompt', async () => {
  registerProfile({ ...withTools('chat', ['ask_user']), id: 'ask_user_validate_bot' });
  const badKind = await invokeRegisteredTool({
    profile: 'ask_user_validate_bot',
    name: 'ask_user',
    input: { kind: 'nope', prompt: 'q' },
  });
  assertEquals(badKind.findLast((e) => e.type === 'tool')?.tool?.phase, 'error');
  const badPrompt = await invokeRegisteredTool({
    profile: 'ask_user_validate_bot',
    name: 'ask_user',
    input: { kind: 'text', prompt: '  ' },
  });
  assertEquals(badPrompt.findLast((e) => e.type === 'tool')?.tool?.phase, 'error');
});

Deno.test('unregistered custom tools fail at execution', async () => {
  registerProfile({ ...withTools('chat', ['host_tool']), id: 'host_tool_bot' });
  const events = await invokeRegisteredTool({
    profile: 'host_tool_bot',
    name: 'host_tool',
    input: { n: 1 },
  });
  const toolEv = events.find((e) => e.type === 'tool');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertStringIncludes(toolEv?.tool?.failure?.message ?? '', 'not registered');
});

Deno.test('provider tool call is dispatched', async () => {
  async function* complete(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield {
      type: 'tool',
      tool: { name: 'ask_user', arguments: { kind: 'text', prompt: 'q' } },
    };
  }
  const provider: ModelProvider = { complete };
  const events = await collect(runTurn({ profile: 'chat', input: { text: 'flow' } }, provider));
  assertEquals(
    events.some(
      (e) => e.type === 'tool' && e.tool?.name === 'ask_user' && e.tool?.phase === 'error',
    ),
    true,
  );
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('role-specific system prompt still completes', async () => {
  const events = await collect(
    runTurn(
      {
        profile: 'selector',
        select: 'fast',
        input: { text: 'plan', role: 'reviewer' },
      },
      fake,
    ),
  );
  assertEquals(
    events.some((e) => e.type === 'text'),
    true,
  );
});

Deno.test('empty text input still runs', async () => {
  const events = await collect(runTurn({ profile: 'chat', input: {} }, fake));
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );
});

Deno.test('chat voice audio becomes an audio interaction part', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: {
      text: 'hi',
      voice: [{ mimeType: 'audio/webm;codecs=opus', data: 'dGVzdA==' }],
    },
  });
  const audio = generation.input.find((part) => part.type === 'audio');
  assertEquals(audio?.type, 'audio');
  if (audio?.type === 'audio') {
    assertEquals(audio.mimeType, 'audio/webm');
  }
});

Deno.test('chat pdf attachment becomes a document part', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: {
      text: 'hi',
      attachments: [{ mimeType: 'application/pdf', data: 'dGVzdA==' }],
    },
  });
  const doc = generation.input.find((part) => part.type === 'document');
  assertEquals(doc?.type, 'document');
});

Deno.test('chat rejects video because the profile does not allow it', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'chat',
        input: {
          text: 'hi',
          attachments: [{ mimeType: 'video/mp4', data: 'dGVzdA==' }],
        },
      }),
    TheorumError,
  );
});

Deno.test('chat rejects audio on the attachments channel', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'chat',
        input: {
          text: 'hi',
          attachments: [{ mimeType: 'audio/webm', data: 'dGVzdA==' }],
        },
      }),
    TheorumError,
  );
});

Deno.test('pinned does not accept voice', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'pinned',
        input: { voice: [{ mimeType: 'audio/webm', data: 'dGVzdA==' }] },
      }),
    TheorumError,
  );
});

Deno.test('synthesizeRepairPrompt scopes history to last 2 exchanges and includes rejection/output', () => {
  const prompt = synthesizeRepairPrompt({
    profile: getProfile('chat'),
    repair: {
      previousOutput: 'The answer leaked internal_marker.',
      rejection: 'Remove internal_marker from user-visible prose.',
      guidance: 'Rewrite as safe user-facing text.',
    },
    history: [
      { role: 'user', content: 'msg 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'msg 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'msg 3' },
      { role: 'assistant', content: 'reply 3' },
    ],
  });
  assertEquals(prompt.includes('msg 1'), false);
  assertEquals(prompt.includes('msg 2'), true);
  assertEquals(prompt.includes('reply 3'), true);
  assertEquals(prompt.includes('The answer leaked internal_marker.'), true);
  assertEquals(prompt.includes('Remove internal_marker from user-visible prose.'), true);
  assertEquals(prompt.includes('Rewrite as safe user-facing text.'), true);
});

Deno.test('runTurn executes profile validation and auto-corrects', async () => {
  registerProfile({
    type: 'text',
    id: 'validatedProfile',
    identity: { handle: 'validated' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'slotA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'validTurn',
      validation: {
        fields: {
          code: (code: unknown) => {
            if (code === 'good') return { isValid: true };
            return { isValid: false, error: 'code must be good' };
          },
        },
        maxRetries: 1,
        repairGuidance: 'emit good code',
      },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  let callCount = 0;
  async function* mockRepairComplete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    callCount++;
    if (callCount === 1) {
      yield { type: 'structured', structured: { code: 'bad' } };
    } else {
      assertEquals(
        req.input.some((p) => p.type === 'text' && p.text.includes('code must be good')),
        true,
      );
      yield { type: 'structured', structured: { code: 'good' } };
    }
  }

  const events = await collect(
    runTurn(
      { profile: 'validatedProfile', input: { text: 'make code' } },
      { complete: mockRepairComplete },
    ),
  );
  assertEquals(callCount, 2);
  assertEquals(events.filter((e) => e.type === 'structured').length, 1);
  assertEquals(events.find((e) => e.type === 'structured')?.structured, {
    code: 'good',
  });
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('runTurn skips optional field validators when optional path is omitted', async () => {
  let codeValidatorCalls = 0;
  registerProfile({
    type: 'text',
    id: 'optionalArtifactProfile',
    identity: { handle: 'optionalArtifact' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'slotA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'optionalCodeTurn',
      validation: {
        fields: {
          code: () => {
            codeValidatorCalls += 1;
            return { isValid: false, error: 'should not validate' };
          },
        },
        maxRetries: 3,
        repairGuidance: 'do not invent code',
      },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  let callCount = 0;
  async function* mockMessageOnly(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    callCount++;
    yield { type: 'structured', structured: { message: '2 + 2 is 4.' } };
  }

  const events = await collect(
    runTurn(
      { profile: 'optionalArtifactProfile', input: { text: 'what is 2+2?' } },
      { complete: mockMessageOnly },
    ),
  );
  assertEquals(callCount, 1);
  assertEquals(codeValidatorCalls, 0);
  assertEquals(events.find((e) => e.type === 'structured')?.structured, {
    message: '2 + 2 is 4.',
  });
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('runTurn streams thought and text live while validation buffers structured', async () => {
  registerProfile({
    type: 'text',
    id: 'streamWhileValidate',
    identity: { handle: 'streamValidate' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'slotA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'validTurn',
      validation: {
        fields: {
          code: () => ({ isValid: true }),
        },
        maxRetries: 0,
      },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  async function* mockComplete(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield { type: 'thought', text: 'planning' };
    yield { type: 'text', text: '{"code":' };
    yield { type: 'structured', structured: { code: 'good' } };
    yield { type: 'tokens', tokens: { input: 1, output: 1, thinking: 0, total: 2 } };
  }

  const events = await collect(
    runTurn({ profile: 'streamWhileValidate', input: { text: 'go' } }, { complete: mockComplete }),
  );
  const types = events.map((e) => e.type);
  assertEquals(types.includes('thought'), true);
  assertEquals(types.includes('text'), true);
  assertEquals(types.includes('structured'), true);
  assertEquals(types.filter((t) => t === 'thought').length, 1);
  assertEquals(types.filter((t) => t === 'text').length, 1);
  assertEquals(types.indexOf('thought') < types.indexOf('structured'), true);
  assertEquals(types.indexOf('text') < types.indexOf('structured'), true);
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('runTurn retries when required field is missing', async () => {
  registerProfile({
    type: 'text',
    id: 'requiredMissingProfile',
    identity: { handle: 'requiredMissing' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'slotA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'validTurn',
      validation: { maxRetries: 1, repairGuidance: 'include code' },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  let callCount = 0;
  async function* mockComplete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    callCount++;
    if (callCount === 1) {
      yield { type: 'structured', structured: { message: 'no code yet' } };
      return;
    }
    assertEquals(
      req.input.some(
        (p) => p.type === 'text' && p.text.includes("required field 'code' is missing"),
      ),
      true,
    );
    yield { type: 'structured', structured: { code: 'good' } };
  }

  const events = await collect(
    runTurn(
      { profile: 'requiredMissingProfile', input: { text: 'make code' } },
      { complete: mockComplete },
    ),
  );
  assertEquals(callCount, 2);
  assertEquals(events.find((e) => e.type === 'structured')?.structured, { code: 'good' });
});

Deno.test('runTurn validates nested required under present optional object', async () => {
  let mermaidCalls = 0;
  registerProfile({
    type: 'text',
    id: 'nestedOptionalProfile',
    identity: { handle: 'nestedOptional' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'slotA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: 'optionalCodeTurn',
      validation: {
        fields: {
          'diagram.mermaid': (source: unknown) => {
            mermaidCalls += 1;
            if (source === 'flowchart TD\nA --> B') return { isValid: true };
            return { isValid: false, error: 'bad mermaid' };
          },
        },
        maxRetries: 1,
        repairGuidance: 'fix mermaid',
      },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  let callCount = 0;
  async function* mockComplete(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    callCount++;
    if (callCount === 1) {
      yield {
        type: 'structured',
        structured: { message: 'here', diagram: { mermaid: 'nope' } },
      };
      return;
    }
    yield {
      type: 'structured',
      structured: { message: 'here', diagram: { mermaid: 'flowchart TD\nA --> B' } },
    };
  }

  const events = await collect(
    runTurn(
      { profile: 'nestedOptionalProfile', input: { text: 'draw' } },
      { complete: mockComplete },
    ),
  );
  assertEquals(callCount, 2);
  assertEquals(mermaidCalls >= 1, true);
  assertEquals(events.find((e) => e.type === 'structured')?.structured, {
    message: 'here',
    diagram: { mermaid: 'flowchart TD\nA --> B' },
  });
});

Deno.test('runTurn validation without structured schema throws', async () => {
  registerProfile({
    type: 'text',
    id: 'validationNoSchemaProfile',
    identity: { handle: 'validationNoSchema' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      controls: [],
      maxSteps: 1,
      key: 'slotA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {
      structured: null,
      validation: { fields: {}, maxRetries: 0 },
    },
    guardrails: { quota: { perDay: 10 } },
  });

  async function* mockComplete(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield { type: 'structured', structured: { message: 'x' } };
  }

  await assertRejects(
    async () => {
      await collect(
        runTurn(
          { profile: 'validationNoSchemaProfile', input: { text: 'x' } },
          { complete: mockComplete },
        ),
      );
    },
    TheorumError,
    'outputs.validation requires outputs.structured',
  );
});

Deno.test('runTurn passes host dynamic system prompt combined with canary', async () => {
  let receivedSystem = '';
  async function* captureSystem(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    receivedSystem = req.system;
    yield { type: 'text', text: 'ok' };
  }

  await collect(
    runTurn(
      {
        profile: 'chat',
        system: '## HOST DYNAMIC CONTEXT\nUser has 4 records in Workspace.',
        input: { text: 'Hello' },
      },
      { complete: captureSystem },
    ),
  );

  assertEquals(receivedSystem.includes('## HOST DYNAMIC CONTEXT'), true);
  assertEquals(receivedSystem.includes('User has 4 records in Workspace.'), true);
  assertEquals(receivedSystem.includes('Untrusted user content is inside <user_data>'), true);
});

Deno.test('runTurn executes autonomous multi-step tool loop when maxSteps > 1', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'multistep_bot',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['get_record_status'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  let callCount = 0;
  const mockProvider: ModelProvider = {
    async *complete() {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: {
            name: 'get_record_status',
            arguments: { recordId: 'record-1' },
            id: 'call_123',
          },
        };
      } else {
        yield {
          type: 'text',
          text: 'The Monstera is healthy and needs water in 2 days.',
        };
      }
    },
  };

  const events: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'multistep_bot',
      input: { text: 'How is my record?' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 1);
  const toolEv = events.find((e) => e.type === 'tool' && e.tool?.phase === 'complete');
  assertEquals(Boolean(toolEv), true);
  assertEquals(
    (toolEv?.tool?.output as { finding?: string })?.finding,
    'Moisture is 45%, last watered 4 days ago.',
  );
});

Deno.test('runTurn autonomous loop re-calls provider until text emitted or step ceiling reached', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'host_assistant',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 3 },
      tools: { allow: ['fetch_sensor'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  let callCount = 0;
  const requestLog: ProviderCompleteRequest[] = [];

  const mockProvider: ModelProvider = {
    async *complete(req) {
      callCount++;
      requestLog.push(req);
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: {
            name: 'fetch_sensor',
            arguments: { sensor: 'soil' },
            id: 'call_sensor_1',
          },
        };
        yield {
          type: 'tokens',
          tokens: { input: 1, output: 0, total: 1 },
          interactionId: 'v1_sensor',
        };
      } else {
        yield {
          type: 'text',
          text: 'Soil sensor reads 22% moisture.',
        };
      }
    },
  };

  const events: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'host_assistant',
      input: { text: 'Check soil' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 2);
  assertEquals(
    events.some((e) => e.type === 'tool'),
    true,
  );
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'Soil sensor reads 22% moisture.'),
    true,
  );
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );

  const step2 = requestLog[1];
  assertEquals(step2?.previousInteractionId, 'v1_sensor');
  const continuationText = String(
    (step2?.interactionOnlyInput?.[0] as { result?: Array<{ text?: string }> })?.result?.[0]?.text,
  );
  assertStringIncludes(continuationText, 'Sensor raw value: 22%');
  assertEquals(step2?.history, []);
  assertEquals(step2?.input, []);
});

Deno.test('runTurn sends every Interactions function_result in one continuation', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'host_assistant_multi_fn',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 3 },
      tools: { allow: ['fetch_sensor', 'lookup_order'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  let callCount = 0;
  const requestLog: ProviderCompleteRequest[] = [];

  const mockProvider: ModelProvider = {
    async *complete(req) {
      callCount++;
      requestLog.push(req);
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: { name: 'fetch_sensor', arguments: { sensor: 'soil' }, id: 'call_a' },
        };
        yield {
          type: 'tool',
          tool: { name: 'lookup_order', arguments: { orderId: '9' }, id: 'call_b' },
        };
        yield {
          type: 'tokens',
          tokens: { input: 1, output: 0, total: 1 },
          interactionId: 'v1_multi',
        };
      } else {
        yield { type: 'text', text: 'both tools returned' };
      }
    },
  };

  for await (const _ev of runTurn(
    {
      profile: 'host_assistant_multi_fn',
      input: { text: 'Check both' },
    },
    mockProvider,
  )) {
    // drain
  }

  assertEquals(callCount, 2);
  const continuation = requestLog[1]?.interactionOnlyInput ?? [];
  assertEquals(continuation.length, 2);
  assertStringIncludes(
    String((continuation[0] as { result?: Array<{ text?: string }> }).result?.[0]?.text),
    '22%',
  );
  assertStringIncludes(
    String((continuation[1] as { result?: Array<{ text?: string }> }).result?.[0]?.text),
    'shipped',
  );
});

Deno.test('runTurn falls back to function_result history when Interactions id is missing', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'host_assistant_history_fallback',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 2 },
      tools: { allow: ['fetch_sensor'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  let callCount = 0;
  const historyLog: import('../../src/kernel/types.ts').TurnHistoryMessage[][] = [];

  const mockProvider: ModelProvider = {
    async *complete(req) {
      callCount++;
      historyLog.push([...(req.history ?? [])]);
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: { name: 'fetch_sensor', arguments: { sensor: 'soil' }, id: 'call_sensor_1' },
        };
      } else {
        yield { type: 'text', text: 'fallback ok' };
      }
    },
  };

  for await (const _ev of runTurn(
    {
      profile: 'host_assistant_history_fallback',
      input: { text: 'Check soil' },
    },
    mockProvider,
  )) {
    // drain
  }

  assertEquals(callCount, 2);
  const step2History = historyLog[1] ?? [];
  assertEquals(step2History.length, 1);
  assertEquals(step2History[0]?.role, 'tool');
  assertEquals(step2History[0]?.tool_call_id, 'call_sensor_1');
});

Deno.test('guardrails.canary=false omits canary generation and system binding', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'internal_eval_bot',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 }, canary: false },
    }),
  );

  let capturedSystem = '';
  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      capturedSystem = req.system;
      yield { type: 'text', text: 'eval response' };
    },
  };

  const { generation } = resolveTurn({
    profile: 'internal_eval_bot',
    input: { text: 'hello' },
  });
  assertEquals(generation.canary, '');

  await collect(runTurn({ profile: 'internal_eval_bot', input: { text: 'hello' } }, mockProvider));
  assertEquals(capturedSystem.includes("This turn's canary is"), false);
});

Deno.test('inputs.text=false rejects text turns with TheorumError', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'voice_only_bot',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: {
        text: false,
        voice: { accept: ['audio/wav'] },
        maxFiles: 1,
        maxBytes: 10000,
        maxTurnBytes: 10000,
      },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  assertThrows(
    () =>
      resolveTurn({
        profile: 'voice_only_bot',
        input: { text: 'Should fail because text is disabled' },
      }),
    TheorumError,
  );
});

Deno.test('outputs.streaming.streamThoughts=false filters out thought events from SSE stream', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'quiet_bot',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      outputs: {
        streaming: { streamThoughts: false },
      },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      await Promise.resolve();
      yield { type: 'thought', text: 'internal deep thoughts...' };
      yield { type: 'text', text: 'final clean output' };
    },
  };

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  let capturedTraceEvents: import('../../src/observability/trace-record.ts').TraceEvent[] = [];
  const mockSink: import('../../src/observability/trace.ts').TraceSink = {
    write: (record) => {
      capturedTraceEvents = record.events;
      return Promise.resolve();
    },
  };

  for await (const ev of runTurn(
    { profile: 'quiet_bot', input: { text: 'solve problem' } },
    mockProvider,
    mockSink,
  )) {
    events.push(ev);
  }

  // Filtered from outer SSE stream
  assertEquals(
    events.some((e) => e.type === 'thought'),
    false,
  );
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'final clean output'),
    true,
  );
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );

  // But preserved in trace record for audit/storage
  assertEquals(
    capturedTraceEvents.some((e) => e.type === 'thought' && e.text === 'internal deep thoughts...'),
    true,
  );
});

Deno.test('registered tool exception is safely caught and converted to error finding', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'fault_tolerant_bot',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 2 },
      tools: { allow: ['crashing_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  let callCount = 0;
  let receivedToolError = '';
  const mockProvider: ModelProvider = {
    async *complete(req) {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: {
            name: 'crashing_tool',
            arguments: { id: 'bad_id' },
            id: 'call_crash_1',
          },
        };
        yield {
          type: 'tokens',
          tokens: { input: 1, output: 0, total: 1 },
          interactionId: 'v1_crash',
        };
      } else {
        const resultStep = req.interactionOnlyInput?.[0];
        const blocks = resultStep?.result as Array<{ text?: string }> | undefined;
        receivedToolError = String(blocks?.[0]?.text ?? '');
        yield { type: 'text', text: 'Handled error gracefully.' };
      }
    },
  };

  const events: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'fault_tolerant_bot',
      input: { text: 'Run crashing tool' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 2);
  assertEquals(
    events.some((e) => e.type === 'tool' && e.tool?.phase === 'error'),
    true,
  );
  assertEquals(receivedToolError.includes('Database connection timed out'), true);
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'Handled error gracefully.'),
    true,
  );
});

Deno.test('autonomous loop strictly enforces maxSteps ceiling when tool requests repeat endlessly', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'loop_capped_bot',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 2 },
      tools: { allow: ['ping_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 } },
    }),
  );

  let callCount = 0;
  const mockProvider: ModelProvider = {
    async *complete() {
      callCount++;
      yield {
        type: 'tool',
        tool: {
          name: 'ping_tool',
          arguments: { step: callCount },
          id: `call_ping_${callCount}`,
        },
      };
    },
  };

  const events: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'loop_capped_bot',
      input: { text: 'Loop test' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 2);
  assertEquals(events.at(-1)?.type, 'done');
});

Deno.test('registered tool enforces session_consent pause unless granted', async () => {
  registerProfile({
    type: 'text',
    id: 'consent_tool_bot',
    identity: { handle: 'consent_bot' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 2,
    },
    tools: { allow: ['delete_resource'] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  const mockProvider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: {
          name: 'delete_resource',
          arguments: { id: 'res_123' },
          id: 'call_del_1',
        },
      };
    },
  };

  const events1: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'consent_tool_bot',
      input: { text: 'Delete resource 123' },
    },
    mockProvider,
  )) {
    events1.push(ev);
  }

  const toolEv1 = events1.findLast((e) => e.type === 'tool' && e.tool?.name === 'delete_resource');
  assertEquals(toolEv1?.tool?.phase, 'pause');
  assertEquals(toolEv1?.tool?.pause?.kind, 'permission');

  const events2: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'consent_tool_bot',
      sessionPermissions: ['delete_resource'],
      input: { text: 'Delete resource 123' },
    },
    mockProvider,
  )) {
    events2.push(ev);
  }

  const toolEv2 = events2.find((e) => e.type === 'tool' && e.tool?.phase === 'complete');
  assertEquals(Boolean(toolEv2), true);
  assertEquals((toolEv2?.tool?.output as { finding?: string })?.finding, 'deleted res_123');
});

Deno.test('loader promotes deferred tools and continues the same turn loop', async () => {
  registerProfile({
    type: 'text',
    id: 'loader_bot',
    identity: { handle: 'loader_bot' },
    model: {
      protocol: 'openAi',
      provider: 'openrouter',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 3,
    },
    tools: { allow: ['load_tools', 'record_lookup'], t2Loader: 'load_tools' },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  let callCount = 0;
  const seenToolLists: string[][] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      callCount++;
      seenToolLists.push((req.wireTools ?? []).map((tool) => tool.name));
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: {
            name: 'load_tools',
            arguments: { names: ['record_lookup'] },
            id: 'call_load',
          },
        };
        return;
      }
      yield {
        type: 'tool',
        tool: {
          name: 'record_lookup',
          arguments: { q: 'record' },
          id: 'call_lookup',
        },
      };
      yield { type: 'text', text: 'lookup complete' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'loader_bot',
        input: { text: 'load then lookup' },
      },
      provider,
    ),
  );

  assertEquals(callCount, 3);
  assertEquals(seenToolLists[0], ['load_tools']);
  assertEquals(seenToolLists[1], ['load_tools', 'record_lookup']);
  assertEquals(
    events.some((event) => {
      const loaded = event.tool?.output as { loaded?: string[] } | undefined;
      return event.tool?.name === 'load_tools' && Array.isArray(loaded?.loaded);
    }),
    true,
  );
  assertEquals(
    events.some((event) => event.tool?.name === 'record_lookup' && event.tool.phase === 'complete'),
    true,
  );
});

Deno.test('loader does not promote deferred tools before required permission is granted', async () => {
  registerProfile({
    type: 'text',
    id: 'loader_permission_bot',
    identity: { handle: 'loader_permission_bot' },
    model: {
      protocol: 'openAi',
      provider: 'openrouter',
      ...modelAllow('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 2,
    },
    tools: { allow: ['load_tools_consent', 'record_lookup'], t2Loader: 'load_tools_consent' },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  const seenToolLists: string[][] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      seenToolLists.push((req.wireTools ?? []).map((tool) => tool.name));
      if (seenToolLists.length === 1) {
        yield {
          type: 'tool',
          tool: {
            name: 'load_tools_consent',
            arguments: { names: ['record_lookup'] },
            id: 'call_load',
          },
        };
        return;
      }
      yield { type: 'text', text: 'permission not granted' };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'loader_permission_bot',
        input: { text: 'try loading without consent' },
      },
      provider,
    ),
  );

  assertEquals(seenToolLists, [['load_tools_consent']]);
  const loadEvent = events.findLast((event) => event.tool?.name === 'load_tools_consent');
  assertEquals(loadEvent?.tool?.phase, 'pause');
  assertEquals(
    events.some((event) => event.tool?.name === 'record_lookup'),
    false,
  );
});

Deno.test('guardrails.egress refuse_to_user delivers in-character refusal without retry', async () => {
  registerProfile({
    type: 'text',
    id: 'voice_egress_bot',
    identity: { handle: 'voice_bot' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 1,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: {
      quota: { perDay: 50 },
      egress: {
        onBlock: 'refuse_to_user',
        enforce: ({ text }: EgressContext) => {
          if (text.includes('internal_tool_abc')) {
            return {
              blocked: true,
              text: "i can't discuss internal wiring.",
              hits: ['internal_tool_name'],
            };
          }
          return { blocked: false, text };
        },
      },
    },
  });

  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      yield { type: 'text', text: 'I used internal_tool_abc to look that up.' };
    },
  };

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'voice_egress_bot',
      input: { text: 'How did you do that?' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  const textEv = events.find((e) => e.type === 'text');
  assertEquals(textEv?.text, "i can't discuss internal wiring.");
});

Deno.test('guardrails.egress reject_to_agent triggers auto-repair retry loop', async () => {
  registerProfile({
    type: 'text',
    id: 'chat_egress_bot',
    identity: { handle: 'chat_bot' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 1,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: {
      quota: { perDay: 50 },
      egress: {
        onBlock: 'reject_to_agent',
        maxRetries: 2,
        enforce: ({ text }: EgressContext) => {
          if (text.includes('internal_tool_abc')) {
            return {
              blocked: true,
              text: '',
              hits: ['internal_tool_name'],
              rejectionMessage: 'Do not mention internal_tool_abc in public prose.',
            };
          }
          return { blocked: false, text };
        },
      },
    },
  });

  let callCount = 0;
  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete(req) {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'text',
          text: 'Here is what internal_tool_abc returned.',
        };
      } else {
        // Verify model received the repair request in input
        const inputStr = JSON.stringify(req.input);
        assertStringIncludes(inputStr, 'Do not mention internal_tool_abc');
        yield { type: 'text', text: 'Here is the clean public answer.' };
      }
    },
  };

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'chat_egress_bot',
      input: { text: 'Show me status' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 2);
  const textEvents = events.filter((e) => e.type === 'text');
  assertEquals(textEvents.length, 1);
  assertEquals(textEvents[0]?.text, 'Here is the clean public answer.');
});

Deno.test('guardrails.egress reject_to_agent withholds turn when retries exhausted', async () => {
  registerProfile({
    type: 'text',
    id: 'exhausted_egress_bot',
    identity: { handle: 'exhausted_bot' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 1,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    guardrails: {
      quota: { perDay: 50 },
      egress: {
        onBlock: 'reject_to_agent',
        maxRetries: 1,
        enforce: () => ({
          blocked: true,
          text: '',
          hits: ['persistent_leak'],
          rejectionMessage: 'Persistent leak violation',
        }),
      },
    },
  });

  let callCount = 0;
  const mockProvider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      callCount++;
      yield { type: 'text', text: 'Persistent leak content' };
    },
  };

  const events: import('../../src/kernel/types.ts').TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: 'exhausted_egress_bot',
      input: { text: 'Run test' },
    },
    mockProvider,
  )) {
    events.push(ev);
  }

  assertEquals(callCount, 2); // Initial attempt (0) + 1 retry = 2 attempts
  const errorEv = events.find((e) => e.type === 'error');
  assertEquals(errorEv?.error, PUBLIC_CANARY);
  const textEv = events.find((e) => e.type === 'text');
  assertEquals(textEv, undefined);
});

Deno.test('guardrails.egress withholds media until prose clears', async () => {
  const { defineProfile, registerProfile } = await import('../../src/kernel/registry/profiles.ts');
  registerProfile(
    defineProfile({
      type: 'image',
      id: 'media_egress_bot',
      identity: { handle: 'media_bot' },
      model: {
        ...geminiModel('gemini31FlashLiteImage'),
        thinking: 'minimal',
        maxSteps: 1,
      },
      image: {
        aspectRatio: '1:1',
        size: '1K',
        mimeType: 'image/jpeg',
      },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {
        structured: null,
      },
      guardrails: {
        quota: { perDay: 50 },
        egress: {
          onBlock: 'reject_to_agent',
          maxRetries: 1,
          enforce: ({ text }: { text: string }) => ({
            blocked: text.includes('internal_tool_abc'),
            text,
            hits: ['internal_tool_name'],
            rejectionMessage: 'remove internal tool names',
          }),
        },
      },
    }),
  );

  let callCount = 0;
  const provider: import('../../src/kernel/types.ts').ModelProvider = {
    async *complete() {
      callCount++;
      if (callCount === 1) {
        yield { type: 'text', text: 'draft from internal_tool_abc' };
        yield {
          type: 'media',
          media: { mimeType: 'image/jpeg', data: 'leaky-image' },
        };
        return;
      }
      yield { type: 'text', text: 'clean public caption' };
      yield {
        type: 'media',
        media: { mimeType: 'image/jpeg', data: 'clean-image' },
      };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'media_egress_bot',
        input: {
          text: 'make image',
        },
      },
      provider,
    ),
  );

  assertEquals(callCount, 2);
  assertEquals(
    events.some((event) => event.media?.data === 'leaky-image'),
    false,
  );
  assertEquals(
    events.some((event) => event.media?.data === 'clean-image'),
    true,
  );
});

function createCanExecBotProfile(id: string, toolName: string): void {
  registerProfile({
    type: 'text',
    id,
    identity: { handle: id },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'minimal',
      maxSteps: 2,
    },
    tools: { allow: [toolName] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });
}

function createToolProvider(toolName: string): import('../../src/kernel/types.ts').ModelProvider {
  return {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: toolName, arguments: { val: 42 }, id: 'call_1' },
      };
    },
  };
}

Deno.test('registered tool canExecute returning false yields unauthorized error', async () => {
  createCanExecBotProfile('can_exec_bot_1', 'denied_tool');
  const events = await collect(
    runTurn(
      {
        profile: 'can_exec_bot_1',
        input: { text: 'test' },
      },
      createToolProvider('denied_tool'),
    ),
  );
  const toolEv = events.findLast((e) => e.type === 'tool' && e.tool?.name === 'denied_tool');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertStringIncludes(toolEv?.tool?.failure?.message ?? '', 'not authorized');
});

Deno.test('registered tool canExecute throwing error is caught safely', async () => {
  createCanExecBotProfile('can_exec_bot_3', 'throwing_auth_tool');
  const events = await collect(
    runTurn(
      {
        profile: 'can_exec_bot_3',
        input: { text: 'test' },
      },
      createToolProvider('throwing_auth_tool'),
    ),
  );
  const toolEv = events.findLast((e) => e.type === 'tool' && e.tool?.name === 'throwing_auth_tool');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertStringIncludes(toolEv?.tool?.failure?.message ?? '', 'Authorization failed for');
});
