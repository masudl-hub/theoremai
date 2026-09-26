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

registerGooglePreset();

function textInterface(): ComposerProfileInterface {
  const iface = interfaceFromProfile(
    defineProfile({
      id: 'failed_turn_bot',
      type: 'text',
      identity: { handle: 'failed_turn_bot', system: 'You reply.' },
      models: { fast: HOST_BINDINGS.gemini35FlashLite },
      key: 'slotA',
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
    onStream: () => {},
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
    onStream: () => {},
    text: 'Tell me a story',
    pendingFiles: [],
    pendingVoice: [],
  });
  if (result.ok) throw new Error('expected a failure');
  assertEquals(result.aborted, true);
  assertEquals(result.session?.history, [{ role: 'user', content: 'Tell me a story' }]);
});
