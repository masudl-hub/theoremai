import { assertEquals } from '@std/assert';
import { TheoremError } from '../../mod.ts';
import { streamInterfaceTurn } from '../../react/src/client/run-session.ts';
import type { TheoremTransport } from '../../react/src/client/transport.ts';
import {
  type ComposerProfileInterface,
  emptyInterfaceTurnSession,
  interfaceFromProfile,
} from '../../src/interface/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { CHAT_MEDIA_LIMITS, HOST_BINDINGS } from '../fixtures/models.ts';
import { unskippedView } from '../fixtures/stream-view.ts';

registerGooglePreset();
function textInterface(): ComposerProfileInterface {
  const iface = interfaceFromProfile(
    defineProfile({
      id: 'failed_turn_bot',
      type: 'text',
      identity: { handle: 'failed_turn_bot', system: 'You reply.' },
      models: { fast: HOST_BINDINGS.gemini35FlashLite },
      tools: { allow: [] },
      inputs: { text: true, ...CHAT_MEDIA_LIMITS },
    }),
    defaultKernelScope.tools,
  );
  if (iface.type !== 'text') throw new Error('expected a text interface');
  return iface;
}
/** Streams the start of a reply, then fails the way a provider does mid-stream. */
function failingTransport(error: TheoremError): TheoremTransport {
  return {
    turn: (_request, onEvent) => {
      onEvent({ type: 'text', text: 'The first half' });
      return Promise.reject(error);
    },
    invoke: () => Promise.reject(new Error('unused')),
    steer: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
  };
}
Deno.test('a turn that fails partway keeps the message and what the reply got through', async () => {
  const result = await streamInterfaceTurn({
    iface: textInterface(),
    transport: failingTransport(new TheoremError('rate_limit', 'quota')),
    session: emptyInterfaceTurnSession(),
    view: unskippedView,
    text: 'Tell me a story',
    pendingFiles: [],
    pendingVoice: [],
  });
  if (result.ok) throw new Error('expected a failure');
  assertEquals(result.errorKind, 'rate_limit');
  assertEquals(result.session?.history, [
    { role: 'user', content: 'Tell me a story' },
    { role: 'assistant', content: 'The first half' },
  ]);
  assertEquals(result.session?.pendingUserDraft, null);
});
Deno.test('a stopped turn keeps the message but not the reply it dropped', async () => {
  const result = await streamInterfaceTurn({
    iface: textInterface(),
    transport: failingTransport(new TheoremError('cancelled', 'stopped')),
    session: emptyInterfaceTurnSession(),
    view: unskippedView,
    text: 'Tell me a story',
    pendingFiles: [],
    pendingVoice: [],
  });
  if (result.ok) throw new Error('expected a failure');
  assertEquals(result.aborted, true);
  assertEquals(result.session?.history, [{ role: 'user', content: 'Tell me a story' }]);
});
Deno.test('a line the stream left out is named, and the reply goes on without it', async () => {
  const skipped: TheoremError[] = [];
  const left = new TheoremError(
    'bad_response',
    "a 'text' line failed its wire check: text invalid_type",
    {
      copy: { key: 'session.part_skipped' },
    },
  );
  const result = await streamInterfaceTurn({
    iface: textInterface(),
    transport: {
      turn: (_request, onEvent) => {
        onEvent({ type: 'text', text: 'The first half' });
        onEvent({ type: 'malformed', error: left });
        onEvent({ type: 'text', text: ', and the rest.' });
        return Promise.resolve();
      },
      invoke: () => Promise.reject(new Error('unused')),
      steer: () => Promise.reject(new Error('unused')),
      describe: () => Promise.reject(new Error('unused')),
    },
    session: emptyInterfaceTurnSession(),
    view: { blocks: () => {}, skipped: (error) => skipped.push(error) },
    text: 'Tell me a story',
    pendingFiles: [],
    pendingVoice: [],
  });
  if (!result.ok) throw new Error('expected the reply to commit');
  assertEquals(skipped, [left]);
  assertEquals(result.session.history, [
    { role: 'user', content: 'Tell me a story' },
    { role: 'assistant', content: 'The first half, and the rest.' },
  ]);
});
