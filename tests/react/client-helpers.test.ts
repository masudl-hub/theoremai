import { assertEquals } from '@std/assert';
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
  liveTranscriptFromEvidence,
  shouldForwardMicFrame,
} from '../../react/src/client/live/live-mic-forward.ts';
import { liveStateLabel } from '../../react/src/client/live/live-state.ts';
import { transcriptBlockCopyText } from '../../react/src/client/transcript-block-text.ts';
import { formatAttachmentSize, resolveAttachPreviewStyle } from '../../react/src/client/attachment-hover-preview.ts';
import { composeAssistantTurn, groupTranscriptBlocks, workStatusLabel } from '../../react/src/client/transcript-groups.ts';
import { resolveScrollToBottomScrollTop } from '../../react/src/client/transcript-scroll.ts';
import type { TranscriptBlock } from '../../src/interface/mod.ts';
import { voiceFormatLabel, voiceLabelFromMime } from '../../react/src/client/voice-label.ts';

Deno.test('transcriptBlockCopyText formats all block kinds', () => {
  assertEquals(transcriptBlockCopyText({ kind: 'user-text', id: '1', text: 'hello' }), 'hello');
  assertEquals(
    transcriptBlockCopyText({
      kind: 'user-attachment',
      id: '2',
      name: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    }),
    'doc.pdf',
  );
  assertEquals(
    transcriptBlockCopyText({
      kind: 'user-voice',
      id: '3',
      name: 'voice.wav',
      mimeType: 'audio/wav',
      sizeBytes: 200,
    }),
    'voice.wav',
  );
  assertEquals(
    transcriptBlockCopyText({ kind: 'thought', id: '4', text: 'thinking...' }),
    'thinking...',
  );
  assertEquals(transcriptBlockCopyText({ kind: 'text', id: '5', text: 'world' }), 'world');
  assertEquals(
    transcriptBlockCopyText({
      kind: 'tool',
      id: '6',
      tool: { name: 'calc', output: { res: 42 } },
    }),
    'Tool: calc\n\n{\n  "res": 42\n}',
  );
  assertEquals(
    transcriptBlockCopyText({
      kind: 'tool',
      id: '6b',
      tool: { name: 'calc', failure: { code: 'bad', message: 'err' } },
    }),
    'Tool: calc\n\n{\n  "code": "bad",\n  "message": "err"\n}',
  );
  assertEquals(
    transcriptBlockCopyText({ kind: 'tool', id: '6c', tool: { name: 'calc' } }),
    'Tool: calc',
  );
  assertEquals(
    transcriptBlockCopyText({ kind: 'structured', id: '7', value: { x: 1 } }),
    '{\n  "x": 1\n}',
  );
  assertEquals(
    transcriptBlockCopyText({
      kind: 'media',
      id: '8',
      mimeType: 'image/png',
      url: 'https://example.com/img.png',
    }),
    'https://example.com/img.png',
  );
  assertEquals(
    transcriptBlockCopyText({ kind: 'media', id: '8b', mimeType: 'image/png' }),
    '[image/png media]',
  );
  assertEquals(
    transcriptBlockCopyText({
      kind: 'grounding',
      id: '9',
      grounding: { sources: [] },
    }),
    '{\n  "sources": []\n}',
  );
  assertEquals(
    transcriptBlockCopyText({
      kind: 'evidence',
      id: '10',
      evidence: { provider: 'google', sources: [] },
    }),
    '{\n  "provider": "google",\n  "sources": []\n}',
  );
  assertEquals(transcriptBlockCopyText({ kind: 'error', id: '11', message: 'fatal' }), 'fatal');
  assertEquals(transcriptBlockCopyText({ kind: 'turn-done', id: '12' }), '');
});

Deno.test('applyLiveTranscript merges interim and final text correctly', () => {
  let state = emptyLiveCaptionState();
  assertEquals(state.turns.length, 0);

  // Empty text does nothing
  assertEquals(applyLiveTranscript(state, '', true), state);

  // Interim user text
  state = applyLiveTranscript(state, 'Hello', true, true);
  assertEquals(state.interimUser, 'Hello');

  // Final user text
  state = applyLiveTranscript(state, 'Hello world', true, false);
  assertEquals(state.turns.length, 1);
  assertEquals(state.turns[0].text, 'Hello world');
  assertEquals(state.interimUser, '');

  // Second user turn with append
  state = applyLiveTranscript(state, 'again', true, false);
  assertEquals(state.turns.length, 1);
  assertEquals(state.turns[0].text, 'Hello world again');

  // Agent turn switches role
  state = applyLiveTranscript(state, 'Hi there', false, false);
  assertEquals(state.turns.length, 2);
  assertEquals(state.turns[1].role, 'agent');
  assertEquals(state.turns[1].text, 'Hi there');

  // Force new turn
  state = applyLiveTranscript(state, 'New prompt', false, false, { forceNew: true });
  assertEquals(state.turns.length, 3);
  assertEquals(state.turns[2].text, 'New prompt');

  // Interim agent text
  state = applyLiveTranscript(state, 'thinking', false, true);
  assertEquals(state.interimAgent, 'thinking');

  // clear interim
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

Deno.test('liveStateLabel maps all states and connect phases', () => {
  assertEquals(
    liveStateLabel({ status: 'ready', connectPhase: null, toolName: 'search', isMuted: false }),
    'calling search',
  );
  assertEquals(
    liveStateLabel({
      status: 'connecting',
      connectPhase: 'socket',
      toolName: null,
      isMuted: false,
    }),
    'connecting',
  );
  assertEquals(
    liveStateLabel({
      status: 'connecting',
      connectPhase: 'microphone',
      toolName: null,
      isMuted: false,
    }),
    'requesting mic',
  );
  assertEquals(
    liveStateLabel({ status: 'speaking', connectPhase: null, toolName: null, isMuted: false }),
    'speaking',
  );
  assertEquals(
    liveStateLabel({ status: 'listening', connectPhase: null, toolName: null, isMuted: false }),
    'listening',
  );
  assertEquals(
    liveStateLabel({ status: 'listening', connectPhase: null, toolName: null, isMuted: true }),
    'muted',
  );
  assertEquals(
    liveStateLabel({
      status: 'listening',
      connectPhase: null,
      toolName: null,
      isMuted: false,
      voiceEnabled: false,
    }),
    'connected',
  );
  assertEquals(
    liveStateLabel({ status: 'connecting', connectPhase: null, toolName: null, isMuted: false }),
    'connecting',
  );
  assertEquals(
    liveStateLabel({ status: 'error', connectPhase: null, toolName: null, isMuted: false }),
    'error',
  );
  assertEquals(
    liveStateLabel({ status: 'disconnected', connectPhase: null, toolName: null, isMuted: false }),
    'ended',
  );
});

Deno.test('voiceFormatLabel and voiceLabelFromMime parse voice formats', () => {
  assertEquals(voiceLabelFromMime('audio/webm'), 'voice.webm');
  assertEquals(voiceLabelFromMime('audio/wav'), 'voice.wav');
  assertEquals(voiceLabelFromMime('audio/mpeg'), 'voice.mp3');
  assertEquals(voiceLabelFromMime('audio/mp4'), 'voice.m4a');
  assertEquals(voiceLabelFromMime('audio/ogg'), 'voice.ogg');
  assertEquals(voiceLabelFromMime('application/octet-stream'), 'voice note');

  const fileWebm = new File([''], 'test.webm', { type: 'audio/webm' });
  assertEquals(voiceFormatLabel(fileWebm), 'voice.webm');

  const fileCustom = new File([''], 'sample.flac', { type: '' });
  assertEquals(voiceFormatLabel(fileCustom), 'voice.flac');

  const fileFallback = new File([''], 'unknown', { type: '' });
  assertEquals(voiceFormatLabel(fileFallback), 'voice.audio');
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

  assertEquals(
    liveTranscriptFromEvidence({ kind: 'input_transcription', text: 'abc', interim: true }),
    {
      text: 'abc',
      isUser: true,
      interim: true,
    },
  );
  assertEquals(liveTranscriptFromEvidence({ kind: 'output_transcription', text: 'def' }), {
    text: 'def',
    isUser: false,
    interim: false,
  });
  assertEquals(liveTranscriptFromEvidence({ kind: 'unknown', text: 'def' }), null);
  assertEquals(liveTranscriptFromEvidence({ kind: 'input_transcription', text: '' }), null);

  const accum = {
    cancelledToolIds: new Set<string>(),
    toolCalls: [] as Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      error?: string;
    }>,
  };
  applyLiveToolTurnEvent({ id: 'c1', phase: 'cancel' }, accum);
  assertEquals(accum.cancelledToolIds.has('c1'), true);

  applyLiveToolTurnEvent({ id: 't1', name: 'search', arguments: { q: 'hi' } }, accum);
  assertEquals(accum.toolCalls.length, 1);
  assertEquals(accum.toolCalls[0].name, 'search');

  applyLiveToolTurnEvent(
    { id: 't2', name: 'calc', phase: 'error', failure: { message: 'oops' } },
    accum,
  );
  assertEquals(accum.toolCalls.length, 2);
  assertEquals(accum.toolCalls[1].error, 'oops');
});

Deno.test('composer drawer summary names what is waiting, by kind', async () => {
  const { composerDrawerSummary } = await import('../../react/src/client/composer-drawer.ts');
  const kinds = (...list: ('steer' | 'queue' | 'stash')[]) => list.map((kind) => ({ kind }));
  assertEquals(composerDrawerSummary({ pendingMessages: [], attachmentCount: 0 }), null);
  assertEquals(composerDrawerSummary({ pendingMessages: kinds('queue', 'queue'), attachmentCount: 0 }), {
    count: 2,
    label: 'queued',
  });
  assertEquals(composerDrawerSummary({ pendingMessages: [], attachmentCount: 1 }), { count: 1, label: 'attached' });
  assertEquals(
    composerDrawerSummary({ pendingMessages: kinds('stash', 'queue', 'queue', 'steer'), attachmentCount: 1 }),
    { count: 5, label: '1 steering · 2 queued · 1 stashed · 1 attached' },
  );
});

Deno.test('composer hint suggests stashing only when the whole draft is selected', async () => {
  const { resolveComposerHint } = await import('../../react/src/client/composer-hints.ts');
  const full = resolveComposerHint({ draftText: 'plan the launch', selectedText: 'plan the launch', canStash: true });
  assertEquals(full?.id, 'stash-selected-draft');
  assertEquals(full?.message, 'Replacing this?');
  assertEquals(resolveComposerHint({ draftText: 'plan the launch', selectedText: 'plan', canStash: true }), null);
  assertEquals(resolveComposerHint({ draftText: '', selectedText: '', canStash: true }), null);
  assertEquals(
    resolveComposerHint({ draftText: 'plan the launch', selectedText: 'plan the launch', canStash: false }),
    null,
  );
});

Deno.test('stash shortcut is mod+shift+S', async () => {
  const { isStashShortcut } = await import('../../react/src/client/composer-hints.ts');
  const key = { code: 'KeyS', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false };
  assertEquals(isStashShortcut({ ...key, metaKey: true }), true);
  assertEquals(isStashShortcut({ ...key, ctrlKey: true }), true);
  assertEquals(isStashShortcut(key), false);
  assertEquals(isStashShortcut({ ...key, metaKey: true, shiftKey: false }), false);
  assertEquals(isStashShortcut({ ...key, metaKey: true, altKey: true }), false);
});

Deno.test('composeAssistantTurn streams the answer after the latest tool in the body', () => {
	const tool = { id: 't', kind: 'tool', tool: { name: 'plan_day', phase: 'complete' } } as TranscriptBlock;
	const blocks: TranscriptBlock[] = [
		{ id: 'r', kind: 'thought', text: 'Planning' },
		{ id: 'n', kind: 'text', text: 'Let me check.' },
		tool,
		{ id: 'm', kind: 'media', mimeType: 'image/jpeg', url: 'https://example.com/a.jpg' },
		{ id: 'a', kind: 'text', text: 'Here is **the plan**.' },
	];
	const turn = composeAssistantTurn(blocks);
	assertEquals(turn.trace.map((item) => item.kind), ['reasoning', 'narration', 'tool']);
	assertEquals(turn.body.map((block) => block.id), ['m', 'a']);
});

Deno.test('groupTranscriptBlocks keeps tools and text in one assistant turn', () => {
	const blocks = [
		{ id: 'user-1', kind: 'user-text', text: 'hi' },
		{ id: 'tool-1', kind: 'tool', tool: { name: 'joke', phase: 'complete', output: { a: 1 } } },
		{ id: 'turn-1', kind: 'text', text: 'punchline' },
		{ id: 'user-2', kind: 'user-text', text: 'lol' },
	] as TranscriptBlock[];
	const groups = groupTranscriptBlocks(blocks);
	assertEquals(groups.map((group) => group.kind), ['user', 'assistant', 'user']);
	assertEquals(groups[1]?.blocks.length, 2);
});

Deno.test('composeAssistantTurn keeps a plain reply in the body', () => {
	const turn = composeAssistantTurn([{ id: 't-1', kind: 'text', text: 'hello **world**' }]);
	assertEquals(turn.hasTrace, false);
	assertEquals(turn.body.map((block) => block.kind), ['text']);
});

Deno.test('workStatusLabel says Working… while streaming and Worked for <duration> after', () => {
	assertEquals(workStatusLabel({ streaming: true, hasTrace: false }), 'Working…');
	assertEquals(workStatusLabel({ streaming: true, hasTrace: true }), 'Working…');
	assertEquals(workStatusLabel({ streaming: false, hasTrace: false }), '');
	assertEquals(workStatusLabel({ streaming: false, hasTrace: true, elapsedMs: 2300 }), 'Worked for 2.3s');
	assertEquals(workStatusLabel({ streaming: false, hasTrace: false, elapsedMs: 2300 }), 'Worked for 2.3s');
	assertEquals(workStatusLabel({ streaming: false, hasTrace: true }), 'Worked');
});

Deno.test('formatAttachmentSize covers B/KB/MB', () => {
	assertEquals(formatAttachmentSize(0), '');
	assertEquals(formatAttachmentSize(512), '512 B');
	assertEquals(formatAttachmentSize(2048), '2.0 KB');
	assertEquals(formatAttachmentSize(2 * 1024 * 1024), '2.0 MB');
});

Deno.test('resolveAttachPreviewStyle opens above when there is room, else below', () => {
	const above = resolveAttachPreviewStyle({ left: 40, top: 220, bottom: 250 }, { width: 800, height: 600 });
	assertEquals([above.left, above.bottom, above.top], [40, 600 - 220 + 6, undefined]);
	const below = resolveAttachPreviewStyle({ left: 40, top: 40, bottom: 70 }, { width: 800, height: 600 });
	assertEquals([below.top, below.bottom], [70 + 6, undefined]);
});

Deno.test('resolveScrollToBottomScrollTop targets the live edge', () => {
	assertEquals(resolveScrollToBottomScrollTop({ scrollHeight: 1400, clientHeight: 600 }), 800);
	assertEquals(resolveScrollToBottomScrollTop({ scrollHeight: 400, clientHeight: 600 }), 0);
});
