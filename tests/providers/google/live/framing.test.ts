import { assertEquals, assertExists, assertThrows } from '@std/assert';
import { TheoremError } from '../../../../src/guardrails/error.ts';
import { registerTool } from '../../../../src/kernel/tools/mod.ts';
import type { ProviderCompleteRequest } from '../../../../src/kernel/types.ts';
import {
  buildGeminiLiveClientContent,
  buildGeminiLiveRealtimeInput,
  buildGeminiLiveRealtimeText,
  buildGeminiLiveSetupMessage,
  buildGeminiLiveToolResponse,
  buildGeminiLiveToolResponses,
  buildGeminiLiveWebSocketUrl,
  extractLiveUsageTokens,
  foldGeminiLiveServerMessage,
  parseFunctionArguments,
  parseGeminiLiveMessage,
  parseGoAwayTimeLeftMs,
  wireFunctionDeclaration,
} from '../../../../src/providers/google/live/framing.ts';

Deno.test('buildGeminiLiveWebSocketUrl encodes api key parameter', () => {
  const url = buildGeminiLiveWebSocketUrl('test-key-123');
  assertEquals(url.includes('key=test-key-123'), true);
  assertEquals(url.startsWith('wss://generativelanguage.googleapis.com/ws/'), true);
});

Deno.test('buildGeminiLiveSetupMessage constructs standard setup frame', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    temperature: 0.7,
    maxOutputTokens: 2048,
    system: 'You are a helpful live assistant.',
    builtins: [],
    thinking: 'low',
    input: [],
    structured: null,
    image: null,
    live: {
      voice: 'Puck',
      vad: {
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        startSensitivity: 'START_SENSITIVITY_HIGH',
        endSensitivity: 'START_SENSITIVITY_LOW',
        prefixPaddingMs: 300,
        silenceDurationMs: 1200,
      },
      sessionResumption: true,
      contextCompression: 'slidingWindow',
      proactiveAudio: true,
      transcription: {
        input: true,
        output: true,
      },
    },
  };

  const setupMsg = buildGeminiLiveSetupMessage(req) as {
    setup: {
      model: string;
      generationConfig: Record<string, unknown>;
      systemInstruction: { parts: Array<{ text: string }> };
      realtimeInputConfig: Record<string, unknown>;
      sessionResumption: Record<string, unknown>;
      contextWindowCompression: Record<string, unknown>;
      inputAudioTranscription: Record<string, unknown>;
      outputAudioTranscription: Record<string, unknown>;
      proactivity: Record<string, unknown>;
    };
  };

  assertEquals(setupMsg.setup.model, 'models/gemini-3.1-flash-live-preview');
  assertEquals(
    setupMsg.setup.systemInstruction.parts[0]?.text,
    'You are a helpful live assistant.',
  );
  assertEquals(
    (
      setupMsg.setup.generationConfig.speechConfig as {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: string } };
      }
    ).voiceConfig.prebuiltVoiceConfig.voiceName,
    'Puck',
  );
  assertEquals(
    (setupMsg.setup.generationConfig.thinkingConfig as { thinkingLevel: string }).thinkingLevel,
    'low',
  );
  assertExists(setupMsg.setup.sessionResumption);
  assertExists(setupMsg.setup.contextWindowCompression);
  assertExists(setupMsg.setup.realtimeInputConfig);
  assertExists(setupMsg.setup.inputAudioTranscription);
  assertExists(setupMsg.setup.outputAudioTranscription);
  assertEquals(setupMsg.setup.proactivity, { proactiveAudio: true });
  // Empty sessions must not gate on clientContent history — that stalls realtime.
  assertEquals((setupMsg.setup as { historyConfig?: unknown }).historyConfig, undefined);
});

Deno.test('buildGeminiLiveSetupMessage omits proactivity when proactiveAudio is unset', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    temperature: 0.7,
    maxOutputTokens: 2048,
    system: 'You are a helpful live assistant.',
    builtins: [],
    thinking: 'low',
    input: [],
    structured: null,
    image: null,
    live: { voice: 'Puck', proactiveAudio: false },
  };

  const setupMsg = buildGeminiLiveSetupMessage(req) as {
    setup: { proactivity?: unknown };
  };
  assertEquals(setupMsg.setup.proactivity, undefined);
});

Deno.test('buildGeminiLiveSetupMessage omits VAD and compression when profile omits them', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    temperature: 0.7,
    maxOutputTokens: 2048,
    system: 'You are a helpful live assistant.',
    builtins: [],
    thinking: 'low',
    input: [],
    structured: null,
    image: null,
    live: { voice: 'Puck' },
  };

  const setupMsg = buildGeminiLiveSetupMessage(req) as {
    setup: {
      realtimeInputConfig?: unknown;
      contextWindowCompression?: unknown;
    };
  };

  assertEquals(setupMsg.setup.realtimeInputConfig, undefined);
  assertEquals(setupMsg.setup.contextWindowCompression, undefined);
});

Deno.test('buildGeminiLiveSetupMessage omits compression for contextCompression none', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    temperature: 0.7,
    maxOutputTokens: 2048,
    system: 'You are a helpful live assistant.',
    builtins: [],
    thinking: 'low',
    input: [],
    structured: null,
    image: null,
    live: { voice: 'Puck', contextCompression: 'none' },
  };

  const setupMsg = buildGeminiLiveSetupMessage(req) as {
    setup: { contextWindowCompression?: unknown };
  };
  assertEquals(setupMsg.setup.contextWindowCompression, undefined);
});

Deno.test('buildGeminiLiveSetupMessage seeds historyConfig only when history is present', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    temperature: 0.7,
    maxOutputTokens: 2048,
    system: 'You are a helpful live assistant.',
    builtins: [],
    thinking: 'low',
    input: [],
    structured: null,
    image: null,
    history: [{ role: 'user', content: 'prior turn' }],
    live: { voice: 'Puck' },
  };

  const setupMsg = buildGeminiLiveSetupMessage(req) as {
    setup: { historyConfig?: { initialHistoryInClientContent?: boolean } };
  };
  assertEquals(setupMsg.setup.historyConfig?.initialHistoryInClientContent, true);
});

Deno.test('buildGeminiLiveSetupMessage includes tool declarations when provided', () => {
  registerTool({
    type: 'builtin',
    name: 'liveSearch',
    description: 'Google Live web search',
    category: 'web',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    wire: { live: 'google_search' },
  });

  const req: ProviderCompleteRequest = {
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    system: '',
    thinking: 'none',
    maxOutputTokens: 100,
    temperature: 0,
    builtins: ['liveSearch'],
    input: [],
    structured: null,
    image: null,
    wireTools: [
      {
        type: 'function',
        name: 'getCurrentWeather',
        description: 'Get weather for location',
        parameters: { type: 'object', properties: { location: { type: 'string' } } },
      },
    ],
  };

  const setupMsg = buildGeminiLiveSetupMessage(req) as {
    setup: {
      tools: Array<{ functionDeclarations: Array<{ name: string; description?: string }> }>;
    };
  };

  assertEquals(Array.isArray(setupMsg.setup.tools), true);
  assertEquals(setupMsg.setup.tools.length, 1);
  const decls = setupMsg.setup.tools[0]?.functionDeclarations ?? [];
  assertEquals(
    decls.some((d) => d.name === 'liveSearch'),
    true,
  );
  assertEquals(
    decls.some((d) => d.name === 'getCurrentWeather'),
    true,
  );
});

Deno.test('buildGeminiLiveClientContent formats conversation history', () => {
  const content = buildGeminiLiveClientContent([
    { role: 'user', content: 'Hello there' },
    { role: 'assistant', content: 'General Kenobi!' },
  ]) as {
    clientContent: {
      turns: Array<{ role: string; parts: Array<{ text: string }> }>;
      turnComplete: boolean;
    };
  };

  assertEquals(content.clientContent.turnComplete, true);
  assertEquals(content.clientContent.turns.length, 2);
  assertEquals(content.clientContent.turns[0]?.role, 'user');
  assertEquals(content.clientContent.turns[0]?.parts[0]?.text, 'Hello there');
  assertEquals(content.clientContent.turns[1]?.role, 'model');
  assertEquals(content.clientContent.turns[1]?.parts[0]?.text, 'General Kenobi!');
});

Deno.test('buildGeminiLiveRealtimeInput serializes audio, video, and text parts', () => {
  const textMsg = buildGeminiLiveRealtimeInput({ type: 'text', text: 'Live prompt' }) as {
    realtimeInput: { text: string };
  };
  assertEquals(textMsg.realtimeInput.text, 'Live prompt');

  const audioMsg = buildGeminiLiveRealtimeInput({
    type: 'audio',
    mimeType: 'audio/pcm;rate=16000',
    data: 'AQIDBA==',
  }) as { realtimeInput: { audio: { mimeType: string; data: string } } };
  assertEquals(audioMsg.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assertEquals(audioMsg.realtimeInput.audio.data, 'AQIDBA==');

  const videoMsg = buildGeminiLiveRealtimeInput({
    type: 'video',
    mimeType: 'image/jpeg',
    data: 'dGVzdA==',
  }) as { realtimeInput: { video: { mimeType: string; data: string } } };
  assertEquals(videoMsg.realtimeInput.video.mimeType, 'image/jpeg');
  assertEquals(videoMsg.realtimeInput.video.data, 'dGVzdA==');
});

Deno.test('buildGeminiLiveRealtimeText creates text input payload', () => {
  const textMsg = buildGeminiLiveRealtimeText('hello') as { realtimeInput: { text: string } };
  assertEquals(textMsg.realtimeInput.text, 'hello');
});

Deno.test('buildGeminiLiveToolResponse formats function responses', () => {
  const resp = buildGeminiLiveToolResponse('call_123', 'get_weather', {
    temp: 72,
    condition: 'Sunny',
  }) as {
    toolResponse: {
      functionResponses: Array<{ id: string; name: string; response: { result: unknown } }>;
    };
  };
  const firstFn = resp.toolResponse.functionResponses[0];
  assertEquals(firstFn?.id, 'call_123');
  assertEquals(firstFn?.name, 'get_weather');
  assertEquals((firstFn?.response?.result as { temp: number } | undefined)?.temp, 72);
});

Deno.test('buildGeminiLiveToolResponse maps tool errors to response.error', () => {
  const resp = buildGeminiLiveToolResponse('call_404', 'navigate', {
    error: 'Element not found',
  }) as {
    toolResponse: {
      functionResponses: Array<{ response: { error: string } }>;
    };
  };
  assertEquals(resp.toolResponse.functionResponses[0]?.response?.error, 'Element not found');
});

Deno.test('buildGeminiLiveToolResponses batches multiple function responses', () => {
  const resp = buildGeminiLiveToolResponses([
    { id: 'a', name: 'one', output: { ok: true } },
    { id: 'b', name: 'two', output: { error: 'nope' } },
  ]) as {
    toolResponse: {
      functionResponses: Array<{ id: string; name: string; response: Record<string, unknown> }>;
    };
  };
  assertEquals(resp.toolResponse.functionResponses.length, 2);
  assertEquals(resp.toolResponse.functionResponses[0]?.id, 'a');
  assertEquals(resp.toolResponse.functionResponses[1]?.response?.error, 'nope');
});

Deno.test('foldGeminiLiveServerMessage handles model audio, text, transcriptions, and interruption', () => {
  // 1. Text and thinking
  const textEvts = foldGeminiLiveServerMessage({
    serverContent: {
      modelTurn: {
        parts: [
          { thought: true, text: 'Thinking about the answer' },
          { text: 'Here is the answer' },
        ],
      },
    },
  });
  assertEquals(textEvts.length, 2);
  assertEquals(textEvts[0]?.type, 'thought');
  assertEquals(textEvts[0]?.text, 'Thinking about the answer');
  assertEquals(textEvts[1]?.type, 'text');
  assertEquals(textEvts[1]?.text, 'Here is the answer');

  // 2. Interruption
  const interruptedEvts = foldGeminiLiveServerMessage({
    serverContent: {
      interrupted: true,
    },
  });
  assertEquals(interruptedEvts.length, 1);
  assertEquals(interruptedEvts[0]?.type, 'done');
  assertEquals(interruptedEvts[0]?.interrupted, true);
  assertEquals(interruptedEvts[0]?.stop?.kind, 'interrupted');

  // 3. Audio chunk wrapped into WAV
  // 4 bytes of PCM (2 samples: 0, 0)
  const pcmBase64 = btoa(String.fromCharCode(0, 0, 0, 0));
  const audioEvts = foldGeminiLiveServerMessage({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmBase64 } }],
      },
    },
  });
  assertEquals(audioEvts.length, 1);
  assertEquals(audioEvts[0]?.type, 'media');
  assertEquals(audioEvts[0]?.media?.mimeType, 'audio/wav');
  assertExists(audioEvts[0]?.media?.data);

  // 4. Session resumption update
  const resumeEvts = foldGeminiLiveServerMessage({
    sessionResumptionUpdate: {
      newHandle: 'handle_xyz_987',
      resumable: true,
    },
  });
  assertEquals(resumeEvts.length, 1);
  assertEquals(resumeEvts[0]?.sessionResumptionHandle, 'handle_xyz_987');
  assertEquals(resumeEvts[0]?.evidence?.kind, 'session_resumption');
  assertEquals(resumeEvts[0]?.evidence?.resumable, true);
});

Deno.test('foldGeminiLiveServerMessage folds output and interim transcriptions mid-turn', () => {
  const outputOnly = foldGeminiLiveServerMessage({
    serverContent: {
      outputTranscription: { text: 'spoken by model' },
    },
  });
  assertEquals(outputOnly.length, 1);
  assertEquals(outputOnly[0]?.type, 'evidence');
  assertEquals(outputOnly[0]?.text, 'spoken by model');
  assertEquals(outputOnly[0]?.evidence?.kind, 'output_transcription');

  const both = foldGeminiLiveServerMessage({
    serverContent: {
      inputTranscription: { text: 'user hello' },
      outputTranscription: { text: 'agent hello' },
    },
  });
  assertEquals(
    both.map((e) => e.evidence?.kind),
    ['input_transcription', 'output_transcription'],
  );

  const interim = foldGeminiLiveServerMessage({
    serverContent: {
      interimInputTranscription: { text: 'hel' },
    },
  });
  assertEquals(interim[0]?.evidence?.kind, 'input_transcription');
  assertEquals(interim[0]?.evidence?.interim, true);
});

Deno.test('foldGeminiLiveServerMessage folds goAway, tool cancel, waitingForInput, generationComplete', () => {
  const goAway = foldGeminiLiveServerMessage({
    goAway: { timeLeft: '10s' },
  });
  assertEquals(goAway[0]?.type, 'session');
  assertEquals(goAway[0]?.session?.kind, 'closing_soon');
  assertEquals(goAway[0]?.session?.timeLeftMs, 10_000);

  const cancel = foldGeminiLiveServerMessage({
    toolCallCancellation: { ids: ['call_1', 'call_2'] },
  });
  assertEquals(cancel.length, 2);
  assertEquals(cancel[0]?.tool?.phase, 'cancel');
  assertEquals(cancel[0]?.tool?.id, 'call_1');
  assertEquals(cancel[1]?.tool?.id, 'call_2');

  const waiting = foldGeminiLiveServerMessage({
    serverContent: { waitingForInput: true },
  });
  assertEquals(waiting[0]?.session?.kind, 'waiting_for_input');

  const genDone = foldGeminiLiveServerMessage({
    serverContent: { generationComplete: true },
  });
  assertEquals(genDone[0]?.type, 'done');
  assertEquals(genDone[0]?.stop?.kind, 'generation_complete');
});

Deno.test('foldGeminiLiveServerMessage emits resumable false without a new handle', () => {
  const evts = foldGeminiLiveServerMessage({
    sessionResumptionUpdate: { resumable: false },
  });
  assertEquals(evts.length, 1);
  assertEquals(evts[0]?.evidence?.kind, 'session_resumption');
  assertEquals(evts[0]?.evidence?.resumable, false);
  assertEquals(evts[0]?.sessionResumptionHandle, undefined);
});

Deno.test('parseGoAwayTimeLeftMs parses seconds and duration strings', () => {
  assertEquals(parseGoAwayTimeLeftMs(10), 10_000);
  assertEquals(parseGoAwayTimeLeftMs('10s'), 10_000);
  assertEquals(parseGoAwayTimeLeftMs('1.5s'), 1_500);
  assertEquals(parseGoAwayTimeLeftMs(''), undefined);
  assertEquals(parseGoAwayTimeLeftMs(undefined), undefined);
});

Deno.test('parseGeminiLiveMessage distinguishes empty from malformed', () => {
  assertEquals(parseGeminiLiveMessage('{"setupComplete": true}'), {
    ok: true,
    value: { setupComplete: true },
  });
  assertEquals(parseGeminiLiveMessage(''), { ok: false, reason: 'empty' });
  assertEquals(parseGeminiLiveMessage('   '), { ok: false, reason: 'empty' });
  assertEquals(parseGeminiLiveMessage('invalid json'), { ok: false, reason: 'malformed' });
  assertEquals(parseGeminiLiveMessage('[]'), { ok: false, reason: 'malformed' });
  assertEquals(parseGeminiLiveMessage('null'), { ok: false, reason: 'malformed' });
});

Deno.test('extractLiveUsageTokens parses token counts', () => {
  const empty = extractLiveUsageTokens({});
  assertEquals(empty, undefined);

  const tokens = extractLiveUsageTokens({
    promptTokenCount: 15,
    responseTokenCount: 25,
    thoughtsTokenCount: 5,
    totalTokenCount: 40,
  });
  assertEquals(tokens?.input, 15);
  assertEquals(tokens?.output, 25);
  assertEquals(tokens?.thinking, 5);
  assertEquals(tokens?.total, 40);

  const snakeTokens = extractLiveUsageTokens({
    prompt_token_count: 10,
    response_token_count: 20,
    total_token_count: 30,
  });
  assertEquals(snakeTokens?.input, 10);
  assertEquals(snakeTokens?.output, 20);
  assertEquals(snakeTokens?.total, 30);
  assertEquals(snakeTokens?.thinking, undefined);
});

Deno.test('wireFunctionDeclaration uppercases JSON Schema types for Gemini Live', () => {
  const wired = wireFunctionDeclaration({
    type: 'function',
    name: 'think_deeply',
    description: 'Think harder',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        mode: { type: ['string', 'null'] },
      },
      required: ['question'],
    },
  });
  assertEquals(wired.name, 'think_deeply');
  assertEquals(wired.parameters, {
    type: 'OBJECT',
    properties: {
      question: { type: 'STRING' },
      mode: { type: 'STRING', nullable: true },
    },
    required: ['question'],
  });
});

Deno.test('parseFunctionArguments handles strings, objects, and malformed inputs', () => {
  assertEquals(parseFunctionArguments('{"loc": "Paris"}'), {
    ok: true,
    value: { loc: 'Paris' },
  });
  assertEquals(parseFunctionArguments({ loc: 'Tokyo' }), {
    ok: true,
    value: { loc: 'Tokyo' },
  });
  assertEquals(parseFunctionArguments('invalid json').ok, false);
  assertEquals(parseFunctionArguments(123).ok, false);
  assertEquals(parseFunctionArguments(null), { ok: true, value: {} });
});

Deno.test('foldGeminiLiveServerMessage emits malformed_arguments on bad tool JSON', () => {
  const events = foldGeminiLiveServerMessage({
    toolCall: {
      functionCalls: [{ id: 'call_bad', name: 'search', args: '{not-json' }],
    },
  });
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'tool');
  assertEquals(events[0]?.tool?.phase, 'error');
  assertEquals(events[0]?.tool?.failure?.code, 'malformed_arguments');
});

Deno.test('foldGeminiLiveServerMessage handles tool calls and usage tokens', () => {
  const events = foldGeminiLiveServerMessage({
    toolCall: {
      functionCalls: [{ id: 'call_1', name: 'search', args: '{"q": "deno"}' }],
    },
    usageMetadata: {
      promptTokenCount: 12,
      responseTokenCount: 8,
      totalTokenCount: 20,
    },
  });
  assertEquals(events.length, 2);
  assertEquals(events[0]?.type, 'tool');
  assertEquals(events[0]?.tool?.id, 'call_1');
  assertEquals(events[0]?.tool?.name, 'search');
  assertEquals(events[0]?.tool?.arguments, { q: 'deno' });
  assertEquals(events[1]?.type, 'tokens');
  assertEquals(events[1]?.tokens?.input, 12);
  assertEquals(events[1]?.tokens?.output, 8);
});

Deno.test('Live client-content history and realtime input reject media references', () => {
  assertThrows(
    () =>
      buildGeminiLiveClientContent([
        {
          role: 'user',
          parts: [{ type: 'image', mimeType: 'image/png', uri: 'files/img1' }],
        },
      ]),
    TheoremError,
    'media references are not supported on geminiLive',
  );
  assertThrows(
    () => buildGeminiLiveRealtimeInput({ type: 'video', mimeType: 'video/mp4', uri: 'files/v1' }),
    TheoremError,
    'media references are not supported on geminiLive',
  );
});

Deno.test('wireLiveTools declares every live function NON_BLOCKING', () => {
  const req: ProviderCompleteRequest = {
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    system: '',
    thinking: 'none',
    maxOutputTokens: 100,
    temperature: 0,
    builtins: [],
    input: [],
    structured: null,
    image: null,
    wireTools: [
      {
        type: 'function',
        name: 'lookup',
        description: 'Look something up',
        parameters: { type: 'object', properties: {} },
      },
    ],
  };
  const setupMsg = buildGeminiLiveSetupMessage(req) as {
    setup: { tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }> };
  };
  const decls = setupMsg.setup.tools[0]?.functionDeclarations ?? [];
  assertEquals(decls.length, 1);
  assertEquals(decls[0]?.behavior, 'NON_BLOCKING');
});

Deno.test('foldGeminiLiveServerMessage folds interactionStatus and turnComplete into session events', () => {
  const working = foldGeminiLiveServerMessage({
    serverContent: { turnComplete: true },
    interactionStatus: 'IN_PROGRESS',
  });
  assertEquals(
    working.map((ev) => (ev.type === 'session' ? ev.session?.kind : ev.type)),
    ['turn_complete', 'working'],
  );

  const idle = foldGeminiLiveServerMessage({ interaction_status: 'IDLE' });
  assertEquals(idle, [{ type: 'session', session: { kind: 'idle' } }]);

  assertEquals(foldGeminiLiveServerMessage({ interactionStatus: 'BOGUS' }), []);
});
