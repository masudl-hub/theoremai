import { assertEquals } from '@std/assert';
import {
  formatAttachmentSize,
  resolveAttachPreviewStyle,
} from '../../react/src/client/attachment-hover-preview.ts';
import { composerDrawerSummary } from '../../react/src/client/composer-drawer.ts';
import { isStashShortcut, resolveComposerHint } from '../../react/src/client/composer-hints.ts';
import { composerActionState } from '../../react/src/client/composer-primary.ts';
import {
  computeInkBarTargets,
  INK_WAVE_BAR_COUNT,
  inkWaveDriver,
  inkWavePhases,
  stepInkBarHeights,
} from '../../react/src/client/ink-waveform.ts';
import {
  applyLiveTranscript,
  clearLiveCaptionInterim,
  emptyLiveCaptionState,
  latestLiveCaptionTurnId,
} from '../../react/src/client/live/live-captions.ts';
import {
  applyLiveToolTurnEvent,
  type LiveToolCallDraft,
  liveTranscriptFromEvidence,
  shouldForwardMicFrame,
} from '../../react/src/client/live/live-mic-forward.ts';
import { liveState } from '../../react/src/client/live/live-state.ts';
import { applyTurnResultToTranscript } from '../../react/src/client/run-session.ts';
import { citationsFromBlock } from '../../react/src/client/source-citations.ts';
import {
  assistantTurnTiming,
  composeAssistantTurn,
  groupTranscriptBlocks,
  pendingPromptOf,
  replyKey,
  type TranscriptTurnGroup,
  toolCallLabel,
  workStatus,
} from '../../react/src/client/transcript-groups.ts';
import { resolveScrollToBottomScrollTop } from '../../react/src/client/transcript-scroll.ts';
import { voiceFormatFromMime } from '../../react/src/client/voice-label.ts';
import {
  composerDrawerLabel,
  liveStateLabel,
  voiceNoteName,
  workStatusLabel,
} from '../../react/src/ui/labels.ts';
import { transcriptBlockCopyText } from '../../react/src/ui/transcript-copy-text.ts';
import {
  emptyInterfaceTurnSession,
  interfaceFromProfile,
  type TranscriptBlock,
} from '../../src/interface/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { toolCallRequestEvent, toolEvent } from '../../src/kernel/tools/events.ts';
import type { ProviderEvidence, Source } from '../../src/kernel/turn-events.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { malformedToolCall } from '../../src/providers/shared/tool-args.ts';
import { foldedCall } from '../fixtures/events.ts';
import { CHAT_MEDIA_LIMITS, geminiModels } from '../fixtures/models.ts';
import { defaultLabels as t } from './default-labels.ts';

registerGooglePreset();

const CALC = { name: 'calc', callId: 'c6' };

Deno.test('transcriptBlockCopyText formats all block kinds', () => {
  assertEquals(transcriptBlockCopyText(t, { kind: 'user-text', id: '1', text: 'hello' }), 'hello');
  assertEquals(
    transcriptBlockCopyText(t, {
      kind: 'user-attachment',
      id: '2',
      name: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    }),
    'doc.pdf',
  );
  assertEquals(
    transcriptBlockCopyText(t, {
      kind: 'user-voice',
      id: '3',
      name: 'voice.wav',
      mimeType: 'audio/wav',
      sizeBytes: 200,
    }),
    'voice.wav',
  );
  assertEquals(
    transcriptBlockCopyText(t, { kind: 'thought', id: '4', text: 'thinking...' }),
    'thinking...',
  );
  assertEquals(transcriptBlockCopyText(t, { kind: 'text', id: '5', text: 'world' }), 'world');
  assertEquals(
    transcriptBlockCopyText(t, {
      kind: 'tool',
      id: '6',
      tool: foldedCall(CALC, {}, { phase: 'complete', output: { res: 42 } }),
    }),
    'Tool: calc\n\n{\n  "res": 42\n}',
  );
  assertEquals(
    transcriptBlockCopyText(t, {
      kind: 'tool',
      id: '6b',
      tool: foldedCall(
        CALC,
        {},
        {
          phase: 'error',
          failure: { code: 'bad', kind: 'failed', message: 'err' },
        },
      ),
    }),
    'Tool: calc\n\n{\n  "code": "bad",\n  "kind": "failed",\n  "message": "err"\n}',
  );
  assertEquals(
    transcriptBlockCopyText(t, { kind: 'tool', id: '6c', tool: foldedCall(CALC, {}) }),
    'Tool: calc',
  );
  assertEquals(
    transcriptBlockCopyText(t, { kind: 'structured', id: '7', value: { x: 1 } }),
    '{\n  "x": 1\n}',
  );
  assertEquals(
    transcriptBlockCopyText(t, {
      kind: 'media',
      id: '8',
      mimeType: 'image/png',
      url: 'https://example.com/img.png',
    }),
    'https://example.com/img.png',
  );
  assertEquals(
    transcriptBlockCopyText(t, { kind: 'media', id: '8b', mimeType: 'image/png' }),
    '[image/png media]',
  );
  assertEquals(
    transcriptBlockCopyText(t, {
      kind: 'grounding',
      id: '9',
      grounding: { searchHtml: '<div>chip</div>' },
    }),
    '{\n  "searchHtml": "<div>chip</div>"\n}',
  );
  assertEquals(
    transcriptBlockCopyText(t, {
      kind: 'citation',
      id: '9b',
      sources: [{ type: 'web', title: 'a', uri: 'https://a.example' }],
    }),
    '[\n  {\n    "type": "web",\n    "title": "a",\n    "uri": "https://a.example"\n  }\n]',
  );
  assertEquals(
    transcriptBlockCopyText(t, {
      kind: 'evidence',
      id: '10',
      evidence: { provider: 'google', kind: 'url_context' },
    }),
    '{\n  "provider": "google",\n  "kind": "url_context"\n}',
  );
  assertEquals(transcriptBlockCopyText(t, { kind: 'error', id: '11', message: 'fatal' }), 'fatal');
  assertEquals(transcriptBlockCopyText(t, { kind: 'turn-done', id: '12' }), '');
});

Deno.test('applyLiveTranscript merges interim and final text correctly', () => {
  let state = emptyLiveCaptionState();
  assertEquals(state.turns.length, 0);

  assertEquals(applyLiveTranscript(state, '', true), state);

  state = applyLiveTranscript(state, 'Hello', true, true);
  assertEquals(state.interimUser, 'Hello');

  state = applyLiveTranscript(state, 'Hello world', true, false);
  assertEquals(state.turns.length, 1);
  assertEquals(state.turns[0].text, 'Hello world');
  assertEquals(state.interimUser, '');

  state = applyLiveTranscript(state, 'again', true, false);
  assertEquals(state.turns.length, 1);
  assertEquals(state.turns[0].text, 'Hello world again');

  state = applyLiveTranscript(state, 'Hi there', false, false);
  assertEquals(state.turns.length, 2);
  assertEquals(state.turns[1].role, 'agent');
  assertEquals(state.turns[1].text, 'Hi there');

  state = applyLiveTranscript(state, 'New prompt', false, false, { forceNew: true });
  assertEquals(state.turns.length, 3);
  assertEquals(state.turns[2].text, 'New prompt');

  state = applyLiveTranscript(state, 'thinking', false, true);
  assertEquals(state.interimAgent, 'thinking');

  state = clearLiveCaptionInterim(state);
  assertEquals(state.interimUser, '');
  assertEquals(state.interimAgent, '');
  assertEquals(typeof latestLiveCaptionTurnId(state), 'string');
});

Deno.test('inkWaveDriver and computeInkBarTargets calculate animations', () => {
  assertEquals(inkWaveDriver('disconnected', false, 0, 0), 'idle');
  assertEquals(inkWaveDriver('connecting', false, 0, 0), 'connecting');
  assertEquals(inkWaveDriver('ready', true, 0, 0), 'tool');
  assertEquals(inkWaveDriver('speaking', false, 0, 0), 'output');
  assertEquals(inkWaveDriver('ready', false, 0, 0.5), 'output');
  assertEquals(inkWaveDriver('ready', false, 0.5, 0), 'input');
  assertEquals(inkWaveDriver('working', false, 0, 0), 'working');
  assertEquals(inkWaveDriver('listening', false, 0, 0), 'idle');
  assertEquals(inkWaveDriver('ready', false, 0, 0), 'idle');
  assertEquals(inkWaveDriver('ready', false, 0, 0, true), 'idle');

  const phases = inkWavePhases(INK_WAVE_BAR_COUNT);
  assertEquals(phases.length, INK_WAVE_BAR_COUNT);

  const targetsIdle = computeInkBarTargets({
    phases,
    timeMs: 1000,
    driver: 'idle',
    inputLevel: 0,
    outputLevel: 0,
  });
  assertEquals(targetsIdle.length, INK_WAVE_BAR_COUNT);

  const targetsFrozen = computeInkBarTargets({
    phases,
    timeMs: 1000,
    driver: 'output',
    inputLevel: 0.5,
    outputLevel: 0.8,
    frozen: true,
  });
  assertEquals(targetsFrozen.length, INK_WAVE_BAR_COUNT);

  for (const driver of ['output', 'input', 'tool', 'working', 'connecting'] as const) {
    const res = computeInkBarTargets({
      phases,
      timeMs: 500,
      driver,
      inputLevel: 0.2,
      outputLevel: 0.4,
    });
    assertEquals(res.length, INK_WAVE_BAR_COUNT);
  }

  const stepped = stepInkBarHeights([0, 0], [1, 1], 0.5);
  assertEquals(stepped, [0.5, 0.5]);
});

/** The default UI's status line for a live call's state. */
function liveLine(args: Parameters<typeof liveState>[0]): string {
  return liveStateLabel(t, liveState(args), args.toolName);
}

Deno.test('liveState maps all states and connect phases; liveStateLabel words them', () => {
  assertEquals(
    liveLine({ status: 'ready', connectPhase: null, toolName: 'search', isMuted: false }),
    'calling search',
  );
  assertEquals(
    liveLine({
      status: 'connecting',
      connectPhase: 'socket',
      toolName: null,
      isMuted: false,
    }),
    'connecting',
  );
  assertEquals(
    liveLine({
      status: 'connecting',
      connectPhase: 'microphone',
      toolName: null,
      isMuted: false,
    }),
    'requesting mic',
  );
  assertEquals(
    liveLine({ status: 'speaking', connectPhase: null, toolName: null, isMuted: false }),
    'speaking',
  );
  assertEquals(
    liveLine({ status: 'listening', connectPhase: null, toolName: null, isMuted: false }),
    'listening',
  );
  assertEquals(
    liveLine({ status: 'listening', connectPhase: null, toolName: null, isMuted: true }),
    'muted',
  );
  assertEquals(
    liveLine({
      status: 'listening',
      connectPhase: null,
      toolName: null,
      isMuted: false,
      voiceEnabled: false,
    }),
    'connected',
  );
  assertEquals(
    liveLine({ status: 'connecting', connectPhase: null, toolName: null, isMuted: false }),
    'connecting',
  );
  assertEquals(
    liveLine({ status: 'error', connectPhase: null, toolName: null, isMuted: false }),
    'error',
  );
  assertEquals(
    liveLine({ status: 'disconnected', connectPhase: null, toolName: null, isMuted: false }),
    'ended',
  );
});

Deno.test('voiceFormatFromMime reads the format; voiceNoteName words it', () => {
  assertEquals(voiceFormatFromMime('audio/webm;codecs=opus'), 'webm');
  assertEquals(voiceFormatFromMime('audio/wav'), 'wav');
  assertEquals(voiceFormatFromMime('audio/mpeg'), 'mp3');
  assertEquals(voiceFormatFromMime('audio/mp4'), 'm4a');
  assertEquals(voiceFormatFromMime('audio/aac'), 'm4a');
  assertEquals(voiceFormatFromMime('AUDIO/OGG'), 'ogg');
  assertEquals(voiceFormatFromMime('application/octet-stream'), undefined);
  assertEquals(voiceNoteName(t, 'webm'), 'voice.webm');
  assertEquals(voiceNoteName(t, undefined), 'voice note');
});

Deno.test('shouldForwardMicFrame, liveTranscriptFromEvidence, applyLiveToolTurnEvent', () => {
  assertEquals(
    shouldForwardMicFrame({
      isMuted: false,
      socketOpen: true,
      modelPlaying: false,
      rms: 0.1,
      bargeInRmsWhileSpeaking: 0.3,
    }),
    true,
  );
  assertEquals(
    shouldForwardMicFrame({
      isMuted: true,
      socketOpen: true,
      modelPlaying: false,
      rms: 0.5,
      bargeInRmsWhileSpeaking: 0.3,
    }),
    false,
  );
  assertEquals(
    shouldForwardMicFrame({
      isMuted: false,
      socketOpen: false,
      modelPlaying: false,
      rms: 0.5,
      bargeInRmsWhileSpeaking: 0.3,
    }),
    false,
  );
  assertEquals(
    shouldForwardMicFrame({
      isMuted: false,
      socketOpen: true,
      modelPlaying: true,
      rms: 0.2,
      bargeInRmsWhileSpeaking: 0.3,
    }),
    false,
  );

  const transcript = (evidence: ProviderEvidence, text?: string) =>
    liveTranscriptFromEvidence({
      type: 'evidence',
      evidence,
      ...(text === undefined ? {} : { text }),
    });
  assertEquals(
    transcript({ provider: 'google', kind: 'input_transcription', interim: true }, 'abc'),
    {
      text: 'abc',
      isUser: true,
      interim: true,
    },
  );
  assertEquals(transcript({ provider: 'google', kind: 'output_transcription' }, 'def'), {
    text: 'def',
    isUser: false,
    interim: false,
  });
  assertEquals(transcript({ provider: 'google', kind: 'voice_activity' }, 'def'), null);
  assertEquals(transcript({ provider: 'google', kind: 'input_transcription' }, ''), null);
  assertEquals(transcript({ provider: 'google', kind: 'input_transcription' }), null);

  const accum = { cancelledToolIds: new Set<string>(), toolCalls: [] as LiveToolCallDraft[] };
  applyLiveToolTurnEvent(
    toolEvent({ name: 'search', callId: 'c1' }, { phase: 'cancel' }).tool,
    accum,
  );
  assertEquals([...accum.cancelledToolIds], ['c1']);

  applyLiveToolTurnEvent(
    toolCallRequestEvent({ name: 'search', callId: 't1' }, { q: 'hi' }).tool,
    accum,
  );
  const bad = { name: 'calc', callId: 't2' };
  for (const event of malformedToolCall(bad, 'oops', '{')) {
    if (event.type === 'tool') applyLiveToolTurnEvent(event.tool, accum);
  }
  // The session answered the malformed call; only the usable one runs.
  assertEquals(accum.toolCalls, [{ id: 't1', name: 'search', arguments: { q: 'hi' } }]);
});

Deno.test('composer drawer summary names what is waiting, by kind', () => {
  const kinds = (...list: ('steer' | 'queue' | 'stash')[]) => list.map((kind) => ({ kind }));
  assertEquals(composerDrawerSummary({ pendingMessages: [], attachmentCount: 0 }), null);
  const queued = composerDrawerSummary({
    pendingMessages: kinds('queue', 'queue'),
    attachmentCount: 0,
  });
  assertEquals(queued, { count: 2, parts: [{ kind: 'queue', n: 2 }] });
  assertEquals(queued && composerDrawerLabel(t, queued), 'queued');
  const attached = composerDrawerSummary({ pendingMessages: [], attachmentCount: 1 });
  assertEquals(attached && composerDrawerLabel(t, attached), 'attached');
  const mixed = composerDrawerSummary({
    pendingMessages: kinds('stash', 'queue', 'queue', 'steer'),
    attachmentCount: 1,
  });
  assertEquals(mixed?.count, 5);
  assertEquals(
    mixed && composerDrawerLabel(t, mixed),
    '1 steering · 2 queued · 1 stashed · 1 attached',
  );
});

Deno.test('composer hint suggests stashing only when the whole draft is selected', () => {
  const full = resolveComposerHint({
    draftText: 'plan the launch',
    selectedText: 'plan the launch',
    canStash: true,
  });
  assertEquals(full?.id, 'stash-selected-draft');
  assertEquals(full && t(`@theorem.composer.hint.${full.id}.message`), 'Replacing this?');
  assertEquals(
    resolveComposerHint({ draftText: 'plan the launch', selectedText: 'plan', canStash: true }),
    null,
  );
  assertEquals(resolveComposerHint({ draftText: '', selectedText: '', canStash: true }), null);
  assertEquals(
    resolveComposerHint({
      draftText: 'plan the launch',
      selectedText: 'plan the launch',
      canStash: false,
    }),
    null,
  );
});

Deno.test('stash shortcut is mod+shift+S', () => {
  const key = { code: 'KeyS', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false };
  assertEquals(isStashShortcut({ ...key, metaKey: true }), true);
  assertEquals(isStashShortcut({ ...key, ctrlKey: true }), true);
  assertEquals(isStashShortcut(key), false);
  assertEquals(isStashShortcut({ ...key, metaKey: true, shiftKey: false }), false);
  assertEquals(isStashShortcut({ ...key, metaKey: true, altKey: true }), false);
});

Deno.test('composeAssistantTurn streams the answer after the latest tool in the body', () => {
  const tool: TranscriptBlock = {
    id: 't',
    kind: 'tool',
    tool: foldedCall({ name: 'plan_day', callId: 'p1' }, {}, { phase: 'complete', output: {} }),
  };
  const blocks: TranscriptBlock[] = [
    { id: 'r', kind: 'thought', text: 'Planning' },
    { id: 'n', kind: 'text', text: 'Let me check.' },
    tool,
    { id: 'm', kind: 'media', mimeType: 'image/jpeg', url: 'https://example.com/a.jpg' },
    { id: 'a', kind: 'text', text: 'Here is **the plan**.' },
  ];
  const turn = composeAssistantTurn(blocks);
  assertEquals(
    turn.trace.map((item) => item.kind),
    ['reasoning', 'narration', 'tool'],
  );
  assertEquals(
    turn.body.map((block) => block.id),
    ['m', 'a'],
  );
});

Deno.test('groupTranscriptBlocks keeps tools and text in one assistant turn', () => {
  const blocks = [
    { id: 'user-1', kind: 'user-text', text: 'hi' },
    { id: 'tool-1', kind: 'tool', tool: { name: 'joke', phase: 'complete', output: { a: 1 } } },
    { id: 'turn-1', kind: 'text', text: 'punchline' },
    { id: 'user-2', kind: 'user-text', text: 'lol' },
  ] as TranscriptBlock[];
  const groups = groupTranscriptBlocks(blocks);
  assertEquals(
    groups.map((group) => group.kind),
    ['user', 'assistant', 'user'],
  );
  assertEquals(groups[1]?.blocks.length, 2);
});

Deno.test('composeAssistantTurn keeps a plain reply in the body', () => {
  const turn = composeAssistantTurn([{ id: 't-1', kind: 'text', text: 'hello **world**' }]);
  assertEquals(turn.hasTrace, false);
  assertEquals(
    turn.body.map((block) => block.kind),
    ['text'],
  );
});

/** The default UI's status line for a turn's work. */
function workLine(args: Parameters<typeof workStatus>[0]): string {
  return workStatusLabel(t, workStatus(args));
}

Deno.test('workStatus is working while streaming and worked after; workStatusLabel words it', () => {
  assertEquals(workLine({ streaming: true, hasTrace: false }), 'Working…');
  assertEquals(workLine({ streaming: true, hasTrace: true }), 'Working…');
  assertEquals(workLine({ streaming: false, hasTrace: false }), '');
  assertEquals(workLine({ streaming: false, hasTrace: true, elapsedMs: 2300 }), 'Worked for 2.3s');
  assertEquals(workLine({ streaming: false, hasTrace: false, elapsedMs: 2300 }), 'Worked for 2.3s');
  assertEquals(workLine({ streaming: false, hasTrace: true }), 'Worked');
});

Deno.test('formatAttachmentSize covers B/KB/MB', () => {
  assertEquals(formatAttachmentSize(0), '');
  assertEquals(formatAttachmentSize(512), '512 B');
  assertEquals(formatAttachmentSize(2048), '2.0 KB');
  assertEquals(formatAttachmentSize(2 * 1024 * 1024), '2.0 MB');
});

Deno.test('resolveAttachPreviewStyle opens above when there is room, else below', () => {
  const above = resolveAttachPreviewStyle(
    { left: 40, top: 220, bottom: 250 },
    { width: 800, height: 600 },
  );
  assertEquals([above.left, above.bottom, above.top], [40, 600 - 220 + 6, undefined]);
  const below = resolveAttachPreviewStyle(
    { left: 40, top: 40, bottom: 70 },
    { width: 800, height: 600 },
  );
  assertEquals([below.top, below.bottom], [70 + 6, undefined]);
});

Deno.test('resolveScrollToBottomScrollTop targets the live edge', () => {
  assertEquals(resolveScrollToBottomScrollTop({ scrollHeight: 1400, clientHeight: 600 }), 800);
  assertEquals(resolveScrollToBottomScrollTop({ scrollHeight: 400, clientHeight: 600 }), 0);
});

Deno.test('a committed reply carries its work on its latest turn-done, and its group reads it', () => {
  const prompt: TranscriptBlock = { id: 'user-1', kind: 'user-text', text: 'hi' };
  const reply: TranscriptBlock[] = [
    { id: 'turn-1', kind: 'text', text: 'on it' },
    { id: 'turn-2', kind: 'turn-done' },
    { id: 'turn-3', kind: 'text', text: 'done' },
    { id: 'turn-4', kind: 'turn-done' },
  ];
  const merged = applyTurnResultToTranscript({
    blocks: [prompt],
    streamBlocks: [],
    session: emptyInterfaceTurnSession(),
    assistantBlocks: reply,
    worked: { workedMs: 4200, endedAt: 99 },
  });
  assertEquals(merged.blocks.at(-1), {
    id: 'turn-4',
    kind: 'turn-done',
    workedMs: 4200,
    endedAt: 99,
  });
  assertEquals(merged.blocks.at(-3), { id: 'turn-2', kind: 'turn-done' });
  const reread = groupTranscriptBlocks(merged.blocks).at(-1);
  assertEquals(
    reread?.kind === 'assistant' ? [reread.workedMs, reread.endedAt] : undefined,
    [4200, 99],
  );
});

Deno.test('assistantTurnTiming keys replies by their prompt; a stopped reply reads its time from its blocks', () => {
  const user = (key: string): TranscriptTurnGroup => ({ kind: 'user', key, blocks: [] });
  const reply = (key: string, workedMs?: number): TranscriptTurnGroup => ({
    kind: 'assistant',
    key,
    blocks: [],
    ...(workedMs === undefined ? {} : { workedMs, endedAt: 15 }),
  });
  // Block ids restart every reply, so both replies' groups carry the same key.
  const groups = [user('u1'), reply('turn-1', 2), user('u2'), reply('turn-1')];
  const timeOf = (key: string) => (key === 'u1' ? 10 : 20);
  // u2 paused 3 on an approval before it streamed again.
  const spans = new Map([['u2', { pausedMs: 3 }]]);
  assertEquals(replyKey(groups, 1), 'u1:reply');
  assertEquals(replyKey(groups, 3), 'u2:reply');
  assertEquals(assistantTurnTiming({ groups, index: 1, streaming: true, timeOf, spans }), {
    key: 'u1:reply',
    live: false,
    workedMs: 2,
    endedAt: 15,
  });
  assertEquals(assistantTurnTiming({ groups, index: 3, streaming: true, timeOf, spans }), {
    key: 'u2:reply',
    live: true,
    startedAt: 23,
  });
  // Stopped without a stamp (a host that doesn't stamp, a failed run): untimed.
  assertEquals(assistantTurnTiming({ groups, index: 3, streaming: false, timeOf, spans }), {
    key: 'u2:reply',
    live: false,
  });
  // The stamp needs no span: it survives a remount or a reload of saved blocks.
  assertEquals(
    assistantTurnTiming({ groups, index: 1, streaming: false, timeOf, spans: new Map() }),
    {
      key: 'u1:reply',
      live: false,
      workedMs: 2,
      endedAt: 15,
    },
  );
  assertEquals(
    assistantTurnTiming({ groups: [reply('a0')], index: 0, streaming: false, timeOf, spans }),
    {
      key: 'a0',
      live: false,
    },
  );
  assertEquals(pendingPromptOf(groups), undefined);
  assertEquals(pendingPromptOf(groups.slice(0, 3))?.key, 'u2');
});

Deno.test('composerActionState gates the primary button on payload, phase and recording', () => {
  const iface = interfaceFromProfile(
    defineProfile({
      id: 'react.composer.actions',
      type: 'text',
      identity: { handle: 'composer_bot', system: 'You reply.' },
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true, ...CHAT_MEDIA_LIMITS },
    }),
    defaultKernelScope.tools,
  );
  if (iface.type !== 'text') throw new Error('expected a text interface');
  assertEquals(iface.allowSteering, true);
  const base = {
    iface,
    draftText: '',
    pendingFiles: [],
    pendingVoice: [],
    recording: false,
  } as const;
  const empty = composerActionState({ ...base, phase: 'idle' });
  assertEquals(empty.primary, 'none');
  assertEquals(empty.primaryDisabled, true);
  assertEquals(empty.menuActions, []);
  const drafted = composerActionState({ ...base, phase: 'idle', draftText: 'hi' });
  assertEquals(drafted.primaryDisabled, false);
  assertEquals(
    composerActionState({ ...base, phase: 'idle', draftText: 'hi', recording: true })
      .primaryDisabled,
    true,
  );
  const voiced = composerActionState({
    ...base,
    phase: 'idle',
    pendingVoice: [new File(['a'], 'v.webm')],
  });
  assertEquals(voiced.primaryDisabled, false);
  const filed = composerActionState({
    ...base,
    phase: 'idle',
    pendingFiles: [new File(['a'], 'a.txt', { type: 'text/plain' })],
  });
  assertEquals(filed.primaryDisabled, false);
  const streaming = composerActionState({ ...base, phase: 'streaming' });
  assertEquals(streaming.primary, 'stop');
  assertEquals(streaming.primaryDisabled, false);
  const steering = composerActionState({ ...base, phase: 'streaming', draftText: 'more' });
  assertEquals(steering.primary, 'queue');
  assertEquals(steering.menuActions, ['queue', 'steer', 'send_now', 'stash']);
});

Deno.test('source citations link only http(s) sources', () => {
  const web = (title: string, uri: string): Source => ({ type: 'web', title, uri });
  const citations = citationsFromBlock({
    kind: 'citation',
    id: 'c1',
    sources: [
      web('Docs', 'http://example.org/docs'),
      web('', 'https://www.example.com/a'),
      web('', 'data:text/html,<script>alert(1)</script>'),
      web('', 'javascript:alert(1)'),
      web('', 'httpx://example.com'),
    ],
  });
  assertEquals(
    citations.map((citation) => [citation.title, citation.href]),
    [
      ['Docs', 'http://example.org/docs'],
      ['example.com', 'https://www.example.com/a'],
      ['web', undefined],
      ['web', undefined],
      ['example.com', undefined],
    ],
  );
});

Deno.test('a source favicon names only its site, never the page', () => {
  const web = (title: string, uri: string): Source => ({ type: 'web', title, uri });
  const favicon = (site: string) => `https://www.google.com/s2/favicons?domain=${site}&sz=32`;
  const citations = citationsFromBlock({
    kind: 'citation',
    id: 'c1',
    sources: [
      web('Docs', 'https://docs.example.org/a/b?q=secret'),
      // Gemini grounding links through a redirect and names the site in the title.
      web('lisboa.pt', 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc'),
      web(
        'Lisbon travel guide',
        'https://vertexaisearch.cloud.google.com/grounding-api-redirect/def',
      ),
      web('', 'javascript:alert(1)'),
    ],
  });
  assertEquals(
    citations.map((citation) => citation.icon),
    [favicon('docs.example.org'), favicon('lisboa.pt'), undefined, undefined],
  );
});

Deno.test('a tool row reads as its filled activity label, else the tool name in words', () => {
  const call = { name: 'save_to_collection', callId: 'c1', arguments: {}, artifacts: [] };
  assertEquals(toolCallLabel(call), 'Save to collection');
  const running = {
    ...call,
    activity: 'Saving Monty to your collection',
    activityPast: 'Saved Monty',
  };
  assertEquals(toolCallLabel(running), 'Saving Monty to your collection');
  const complete = {
    ...running,
    state: { phase: 'complete' as const, name: call.name, callId: 'c1', at: 1, output: {} },
  };
  assertEquals(toolCallLabel(complete), 'Saved Monty');
  assertEquals(toolCallLabel({ ...complete, activityPast: undefined }), 'Save to collection');
  const failed = {
    ...running,
    state: {
      phase: 'error' as const,
      name: call.name,
      callId: 'c1',
      at: 1,
      failure: { code: 'upstream', kind: 'failed' as const, message: 'x' },
    },
  };
  assertEquals(toolCallLabel(failed), 'Save to collection');
});
