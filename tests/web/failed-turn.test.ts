import { assertEquals } from '@std/assert';
import { TheoremError } from '../../mod.ts';
import {
  type ComposerProfileInterface,
  emptyInterfaceTurnSession,
  interfaceFromProfile,
  type TranscriptBlock,
} from '../../src/interface/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { streamInterfaceTurn } from '../../web/src/client/run-session.ts';
import {
  hostError,
  type TheoremTransport,
  type TheoremTurnRequest,
} from '../../web/src/client/transport.ts';
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
/** A host that keeps the conversation: `turn` streams what the test gives it. */
function hostTransport(turn: TheoremTransport['turn']): TheoremTransport {
  return {
    turn,
    invoke: () => Promise.reject(new Error('unused')),
    steer: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
    conversation: () => Promise.reject(new Error('unused')),
    rewind: () => Promise.reject(new Error('unused')),
    stop: () => Promise.reject(new Error('unused')),
  };
}
/** Posts the message, streams the start of a reply, then fails the way a provider does mid-stream. */
function failingTransport(error: TheoremError): TheoremTransport {
  return hostTransport((_request, onLine) => {
    onLine({ type: 'conversation', ref: 'ref-1', posted: true });
    onLine({ type: 'text', text: 'The first half' });
    return Promise.reject(error);
  });
}
/** A run of `transport`, with the blocks the page was told the message posted. */
async function run(transport: TheoremTransport, view = unskippedView) {
  const posted: TranscriptBlock[][] = [];
  const outcome = await streamInterfaceTurn({
    iface: textInterface(),
    transport,
    session: emptyInterfaceTurnSession(),
    scope: {},
    view,
    onUserBlocks: (blocks) => posted.push(blocks),
    text: 'Tell me a story',
    pendingFiles: [],
    pendingVoice: [],
  });
  return { outcome, posted };
}
Deno.test('a turn that fails partway keeps the posted message and what the reply got through', async () => {
  const { outcome } = await run(failingTransport(new TheoremError('rate_limit', 'quota')));
  assertEquals(outcome.failure?.errorKind, 'rate_limit');
  assertEquals(outcome.posted, true);
  assertEquals(outcome.events, [{ type: 'text', text: 'The first half' }]);
});
Deno.test("a stopped turn is the user's stop, and its message stays posted", async () => {
  const { outcome } = await run(failingTransport(new TheoremError('cancelled', 'stopped')));
  assertEquals(outcome.failure?.aborted, true);
  assertEquals(outcome.posted, true);
});
Deno.test('a turn that fails before the host posts its message leaves nothing posted', async () => {
  const { outcome, posted } = await run(
    hostTransport(() => Promise.reject(new TheoremError('unavailable', 'down'))),
  );
  assertEquals(outcome.failure?.errorKind, 'unavailable');
  assertEquals(outcome.posted, false);
  assertEquals(outcome.events, []);
  // The page drew the message as it went out; the run says it never posted.
  assertEquals(posted.length, 1);
});
Deno.test("a reply that ends without its message posting is the host's failure", async () => {
  const { outcome } = await run(
    hostTransport((_request, onLine) => {
      onLine({ type: 'conversation', ref: 'ref-1' });
      onLine({ type: 'text', text: 'orphan' });
      return Promise.resolve();
    }),
  );
  assertEquals(outcome.failure?.errorKind, 'internal');
  assertEquals(outcome.posted, false);
  assertEquals(outcome.events, []);
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
  const { outcome } = await run(
    hostTransport((_request, onLine) => {
      onLine({ type: 'conversation', ref: 'ref-1', posted: true });
      onLine({ type: 'text', text: 'The first half' });
      onLine({ type: 'malformed', error: left });
      onLine({ type: 'text', text: ', and the rest.' });
      return Promise.resolve();
    }),
    { blocks: () => {}, skipped: (error) => skipped.push(error) },
  );
  assertEquals(outcome.failure, undefined);
  assertEquals(skipped, [left]);
  assertEquals(outcome.events, [
    { type: 'text', text: 'The first half' },
    { type: 'text', text: ', and the rest.' },
  ]);
});

const EARLIER: TranscriptBlock[] = [{ id: 'u0', kind: 'user-text', text: 'Earlier.' }];
/** The host's answer to a ref it can't open, as the wire carries it. */
const lost = () =>
  hostError(
    { errorKind: 'not_found', errorCopy: { key: 'session.conversation_unknown' } },
    'not_found',
  );
/** A run on conversation `ref-0`, with the page's transcript before the message. */
async function runOnLostRef(turn: TheoremTransport['turn']) {
  return await streamInterfaceTurn({
    iface: textInterface(),
    transport: hostTransport(turn),
    session: emptyInterfaceTurnSession(),
    scope: { conversation: 'ref-0' },
    view: unskippedView,
    onUserBlocks: () => {},
    text: 'And now?',
    pendingFiles: [],
    pendingVoice: [],
    transcript: EARLIER,
  });
}
Deno.test('a message on a conversation the host lost goes again, once, with the page’s transcript', async () => {
  const sent: TheoremTurnRequest[] = [];
  const outcome = await runOnLostRef((request, onLine) => {
    sent.push(request);
    if (!request.transcript) return Promise.reject(lost());
    onLine({ type: 'conversation', ref: 'ref-1', posted: true });
    onLine({ type: 'text', text: 'Going on.' });
    return Promise.resolve();
  });
  assertEquals(outcome.failure, undefined);
  assertEquals(outcome.posted, true);
  assertEquals(
    sent.map((request) => request.transcript),
    [undefined, EARLIER],
  );
});
Deno.test('a host that still can’t open the conversation fails the message after one more try', async () => {
  let tries = 0;
  const outcome = await runOnLostRef(() => {
    tries += 1;
    return Promise.reject(lost());
  });
  assertEquals(tries, 2);
  assertEquals(outcome.posted, false);
  assertEquals(outcome.failure?.errorKind, 'not_found');
});
Deno.test('any other refused message is not sent again', async () => {
  let tries = 0;
  const outcome = await runOnLostRef(() => {
    tries += 1;
    return Promise.reject(hostError({ errorKind: 'request' }, 'request'));
  });
  assertEquals(tries, 1);
  assertEquals(outcome.posted, false);
});
