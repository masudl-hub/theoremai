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
