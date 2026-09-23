import { assertEquals, assertExists, assertThrows } from '@std/assert';
import { TheoremError } from '../../../../src/guardrails/error.ts';
import { registerTool } from '../../../../src/kernel/tools/mod.ts';
import type { ProviderCompleteRequest } from '../../../../src/kernel/types.ts';
import {
  buildGeminiLiveClientContent,
  buildGeminiLiveRealtimeInput,
  buildGeminiLiveSetupMessage,
  buildGeminiLiveToolResponse,
  buildGeminiLiveToolResponses,
  buildGeminiLiveWebSocketUrl,
  extractLiveUsageTokens,
  foldGeminiLiveServerMessage,
  type LiveFold,
  newLiveFold,
  parseFunctionArguments,
  parseGeminiLiveMessage,
  parseGoAwayTimeLeftMs,
  wireFunctionDeclaration,
} from '../../../../src/providers/google/live/framing.ts';

/** One server message on a fresh connection. */
function foldMessage(message: Record<string, unknown>, fold: LiveFold = newLiveFold()) {
  return foldGeminiLiveServerMessage(message, fold);
}

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

Deno.test('buildGeminiLiveSetupMessage declares builtins as their own tools and functions together', () => {
  registerTool({
    type: 'builtin',
    name: 'liveSearch',
    description: 'Google Live web search',
    category: 'web',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    wire: { live: 'googleSearch' },
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
    setup: { tools: Array<Record<string, unknown>> };
  };
  // The setup shape every Live model accepted for search (probe 23/09/2026).
  assertEquals(setupMsg.setup.tools[0], { googleSearch: {} });
  const decls = setupMsg.setup.tools[1]?.functionDeclarations as Array<{ name: string }>;
  assertEquals(
    decls.map((d) => d.name),
    ['getCurrentWeather'],
  );
  assertEquals(setupMsg.setup.tools.length, 2);
});

Deno.test('buildGeminiLiveSetupMessage rejects a builtin with no Live wire type', () => {
  registerTool({
    type: 'builtin',
    name: 'interactionsOnly',
    description: 'Interactions-only builtin',
    category: 'web',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    wire: { interactions: 'google_search' },
  });
  assertThrows(
    () =>
      buildGeminiLiveSetupMessage({
        model: 'gemini-3.1-flash-live-preview',
        apiId: 'gemini-3.1-flash-live-preview',
        system: '',
        thinking: 'none',
        maxOutputTokens: 100,
        temperature: 0,
        builtins: ['interactionsOnly'],
        input: [],
        structured: null,
        image: null,
      }),
    TheoremError,
    "Builtin 'interactionsOnly' has no wire.live",
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

Deno.test('buildGeminiLiveClientContent sends history content first, then parts', () => {
  assertEquals(
    buildGeminiLiveClientContent([
      {
        role: 'user',
        content: 'What is on this leaf?',
        parts: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0=' }],
      },
    ]),
    {
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [
              { text: 'What is on this leaf?' },
              { inlineData: { mimeType: 'image/png', data: 'iVBORw0=' } },
            ],
          },
        ],
        turnComplete: true,
      },
    },
  );
});

Deno.test('buildGeminiLiveClientContent replays tool calls and results as function parts', () => {
  assertEquals(
    buildGeminiLiveClientContent([
      { role: 'user', content: 'Where is order A1042?' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup_order', arguments: '{"order_id":"A1042"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'lookup_order',
        content: '{"status":"shipped"}',
        parts: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0=' }],
      },
    ]),
    {
      clientContent: {
        turns: [
          { role: 'user', parts: [{ text: 'Where is order A1042?' }] },
          {
            role: 'model',
            parts: [
              { text: 'Checking.' },
              {
                functionCall: { id: 'call_1', name: 'lookup_order', args: { order_id: 'A1042' } },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'lookup_order',
                  response: { result: '{"status":"shipped"}' },
                  parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0=' } }],
                },
              },
            ],
          },
        ],
        turnComplete: true,
      },
    },
  );
});

Deno.test('buildGeminiLiveClientContent sends only the tool fields history carries', () => {
  assertEquals(buildGeminiLiveClientContent([{ role: 'tool', content: 'done' }]), {
    clientContent: {
      turns: [{ role: 'user', parts: [{ functionResponse: { response: { result: 'done' } } }] }],
      turnComplete: true,
    },
  });
});

Deno.test('buildGeminiLiveClientContent rejects malformed tool-call history arguments', () => {
  assertThrows(
    () =>
      buildGeminiLiveClientContent([
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup_order', arguments: '{"a"' },
            },
          ],
        },
      ]),
    TheoremError,
  );
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

Deno.test('buildGeminiLiveRealtimeInput creates text input payload', () => {
  assertEquals(buildGeminiLiveRealtimeInput({ type: 'text', text: 'hello' }), {
    realtimeInput: { text: 'hello' },
  });
});

Deno.test('buildGeminiLiveRealtimeInput sends the mime it is given', () => {
  // 'audio/pcm' with no rate is accepted on every Live model (probe 23/09/2026).
  assertEquals(
    buildGeminiLiveRealtimeInput({ type: 'audio', mimeType: 'audio/pcm', data: 'AQ==' }),
    {
      realtimeInput: { audio: { mimeType: 'audio/pcm', data: 'AQ==' } },
    },
  );
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
  const textEvts = foldMessage({
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
  const interruptedEvts = foldMessage({
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
  const audioEvts = foldMessage({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmBase64 } }],
      },
    },
  });
  assertEquals(audioEvts.length, 1);
  assertEquals(audioEvts[0]?.type, 'media');
  assertEquals(audioEvts[0]?.media?.mimeType, 'audio/wav');
  const wav = new DataView(
    Uint8Array.from(atob(audioEvts[0]?.media?.data ?? ''), (c) => c.charCodeAt(0)).buffer,
  );
  assertEquals(wav.getUint32(24, true), 24000);

  // A mime without a stated rate is not wrapped at a guessed one.
  const unstated = foldMessage({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: pcmBase64 } }] },
    },
  });
  assertEquals(unstated[0]?.media, { mimeType: 'audio/pcm', data: pcmBase64 });

  // 4. Session resumption update
  const resumeEvts = foldMessage({
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
  const outputOnly = foldMessage({
    serverContent: {
      outputTranscription: { text: 'spoken by model' },
    },
  });
  assertEquals(outputOnly.length, 1);
  assertEquals(outputOnly[0]?.type, 'evidence');
  assertEquals(outputOnly[0]?.text, 'spoken by model');
  assertEquals(outputOnly[0]?.evidence?.kind, 'output_transcription');

  const both = foldMessage({
    serverContent: {
      inputTranscription: { text: 'user hello' },
      outputTranscription: { text: 'agent hello' },
    },
  });
  assertEquals(
    both.map((e) => e.evidence?.kind),
    ['input_transcription', 'output_transcription'],
  );

  const interim = foldMessage({
    serverContent: {
      interimInputTranscription: { text: 'hel' },
    },
  });
  assertEquals(interim[0]?.evidence?.kind, 'input_transcription');
  assertEquals(interim[0]?.evidence?.interim, true);
});

Deno.test('foldGeminiLiveServerMessage folds goAway, tool cancel, waitingForInput, generationComplete', () => {
  const goAway = foldMessage({
    goAway: { timeLeft: '10s' },
  });
  assertEquals(goAway[0]?.type, 'session');
  assertEquals(goAway[0]?.session?.kind, 'closing_soon');
  assertEquals(goAway[0]?.session?.timeLeftMs, 10_000);

  const fold = newLiveFold();
  foldMessage(
    {
      toolCall: {
        functionCalls: [
          { id: 'call_1', name: 'get_soil_moisture', args: {} },
          { id: 'call_2', name: 'get_light_level', args: {} },
        ],
      },
    },
    fold,
  );
  // The wire shape (probe 23/09/2026): ids only.
  const cancel = foldMessage({ toolCallCancellation: { ids: ['call_1', 'call_2'] } }, fold);
  assertEquals(
    cancel.map((ev) => ev.tool),
    [
      { id: 'call_1', name: 'get_soil_moisture', phase: 'cancel' },
      { id: 'call_2', name: 'get_light_level', phase: 'cancel' },
    ],
  );

  const waiting = foldMessage({
    serverContent: { waitingForInput: true },
  });
  assertEquals(waiting[0]?.session?.kind, 'waiting_for_input');

  const genDone = foldMessage({
    serverContent: { generationComplete: true },
  });
  assertEquals(genDone[0]?.type, 'done');
  assertEquals(genDone[0]?.stop?.kind, 'generation_complete');
});

Deno.test('foldGeminiLiveServerMessage emits resumable false without a new handle', () => {
  const evts = foldMessage({
    sessionResumptionUpdate: { resumable: false },
  });
  assertEquals(evts.length, 1);
  assertEquals(evts[0]?.evidence?.kind, 'session_resumption');
  assertEquals(evts[0]?.evidence?.resumable, false);
  assertEquals(evts[0]?.sessionResumptionHandle, undefined);
});

Deno.test('parseGoAwayTimeLeftMs reads a protobuf Duration string', () => {
  assertEquals(parseGoAwayTimeLeftMs('10s'), 10_000);
  assertEquals(parseGoAwayTimeLeftMs('1.5s'), 1_500);
  assertEquals(parseGoAwayTimeLeftMs('0s'), 0);
  assertEquals(parseGoAwayTimeLeftMs(10), undefined);
  assertEquals(parseGoAwayTimeLeftMs('10'), undefined);
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

// Counts are a live gemini-3.1-flash-live-preview response (22/09/2026).
Deno.test('extractLiveUsageTokens adds thoughts to output and total', () => {
  assertEquals(extractLiveUsageTokens({}), undefined);
  assertEquals(
    extractLiveUsageTokens({
      promptTokenCount: 155,
      responseTokenCount: 67,
      totalTokenCount: 222,
      thoughtsTokenCount: 95,
    }),
    { input: 155, output: 162, thinking: 95, total: 317 },
  );
});

Deno.test('extractLiveUsageTokens keeps per-modality details as reported, lower-cased', () => {
  // Recorded shape (23/09/2026): details list only some prompt tokens.
  assertEquals(
    extractLiveUsageTokens({
      promptTokenCount: 200,
      responseTokenCount: 300,
      totalTokenCount: 500,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 150 }],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 300 }],
    }),
    {
      input: 200,
      output: 300,
      total: 500,
      byModality: { input: { text: 150 }, output: { audio: 300 } },
    },
  );
});

Deno.test('extractLiveUsageTokens adds tool-use prompt tokens to input and keeps cache share', () => {
  assertEquals(
    extractLiveUsageTokens({
      promptTokenCount: 100,
      responseTokenCount: 10,
      toolUsePromptTokenCount: 40,
      cachedContentTokenCount: 60,
    }),
    { input: 140, output: 10, toolUse: 40, cached: 60, total: 150 },
  );
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
  const events = foldMessage({
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
  const events = foldMessage({
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
  const working = foldMessage({
    serverContent: { turnComplete: true, interactionStatus: 'IN_PROGRESS' },
  });
  assertEquals(
    working.map((ev) => (ev.type === 'session' ? ev.session?.kind : ev.type)),
    ['turn_complete', 'working'],
  );

  const idle = foldMessage({ serverContent: { interactionStatus: 'IDLE' } });
  assertEquals(idle, [{ type: 'session', session: { kind: 'idle' } }]);

  assertEquals(foldMessage({ serverContent: { interactionStatus: 'BOGUS' } }), []);
  assertEquals(foldMessage({ interactionStatus: 'IDLE' }), []);
  assertEquals(foldMessage({}), []);
});

Deno.test('foldGeminiLiveServerMessage emits grounding from serverContent.groundingMetadata', () => {
  // Shape recorded from gemini-3.1-flash-live-preview with googleSearch (23/09/2026).
  const groundingMetadata = {
    groundingChunks: [
      { web: { uri: 'https://grounding.example/redirect/a', title: 'rhs.org.uk' } },
    ],
    searchEntryPoint: { renderedContent: '<div class="chip">chelsea</div>' },
    webSearchQueries: ['chelsea best in show'],
  };
  const events = foldMessage({ serverContent: { groundingMetadata } });
  assertEquals(events, [
    {
      type: 'grounding',
      grounding: {
        metadata: groundingMetadata,
        chunks: groundingMetadata.groundingChunks,
        searchHtml: '<div class="chip">chelsea</div>',
        sources: [
          { type: 'web', uri: 'https://grounding.example/redirect/a', title: 'rhs.org.uk' },
        ],
      },
    },
  ]);
  assertEquals(foldMessage({ serverContent: { grounding_metadata: groundingMetadata } }), []);
});

Deno.test('a Live cancel for a call the connection never issued is an error', () => {
  const events = foldMessage({ toolCallCancellation: { ids: ['call_9'] } });
  assertEquals(
    events.map((ev) => ev.type),
    ['error'],
  );
  assertEquals(events[0]?.errorInternal?.includes('call_9'), true);
});

Deno.test('foldGeminiLiveServerMessage folds voiceActivity as evidence', () => {
  // gemini-3.1-flash-live-preview (probe 23/09/2026).
  const voiceActivity = { type: 'ACTIVITY_START', audioOffset: '0.360s' };
  assertEquals(foldMessage({ serverContent: {}, voiceActivity }), [
    {
      type: 'evidence',
      evidence: { provider: 'google', kind: 'voice_activity', raw: voiceActivity },
    },
  ]);
});

Deno.test('foldGeminiLiveServerMessage folds a codeExecutionResult part as evidence', () => {
  // gemini-2.5-flash-native-audio reports a URL fetch this way (probe 23/09/2026).
  const result = { outcome: 'OUTCOME_OK', output: 'Browsing the web.' };
  assertEquals(
    foldMessage({ serverContent: { modelTurn: { parts: [{ codeExecutionResult: result }] } } }),
    [
      {
        type: 'evidence',
        evidence: {
          provider: 'google',
          kind: 'code_execution_result',
          result: 'Browsing the web.',
          isError: false,
          raw: result,
        },
      },
    ],
  );
  const failed = foldMessage({
    serverContent: {
      modelTurn: { parts: [{ codeExecutionResult: { outcome: 'OUTCOME_FAILED' } }] },
    },
  });
  assertEquals(failed[0]?.evidence?.isError, true);
});
