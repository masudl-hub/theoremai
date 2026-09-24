/**
 * URI media references (`TurnMediaRef` / `InteractionMediaRefPart`): MIME
 * acceptance still applies; base64 and byte limits do not; the uri passes
 * through untouched for the Google adapter to wire.
 */
import '../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { publicError, TheoremError } from '../../src/guardrails/error.ts';
import { isMediaRefPart, wireInteractionPart } from '../../src/kernel/interaction-parts.ts';
import {
  assertTurnAttachments,
  isTurnMediaRef,
  sanitizeTurnBlobs,
} from '../../src/kernel/registry/attachments.ts';
import { getProfile } from '../../src/kernel/registry/profiles.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type { InteractionPart, Profile } from '../../src/kernel/types.ts';

/** The chat fixture with a one-file, one-byte ceiling. */
function tiny(): Profile {
  const chat = getProfile('chat');
  if (chat.type !== 'text') throw new Error('chat fixture is a text profile');
  return { ...chat, inputs: { ...chat.inputs, maxFiles: 1, maxBytes: 1, maxTurnBytes: 1 } };
}

Deno.test('ingress accepts a media reference and emits a ref part', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: {
      text: 'look',
      attachments: [{ mimeType: 'image/png', uri: 'files/abc123' }],
    },
  });
  const part = generation.input.find((p) => p.type === 'image');
  assertEquals(part, { type: 'image', mimeType: 'image/png', uri: 'files/abc123' });
  assertEquals(part !== undefined && isMediaRefPart(part), true);
});

Deno.test('ingress rejects a media reference whose MIME the profile does not accept', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'chat',
        input: {
          text: 'look',
          attachments: [{ mimeType: 'video/mp4', uri: 'files/abc123' }],
        },
      }),
    TheoremError,
    'attachments refused: mime_not_allowed',
  );
});

Deno.test('a media reference never runs base64 or byte limits; file count still applies', () => {
  const ref = { mimeType: 'image/png', uri: 'files/abc123' };
  assertEquals(isTurnMediaRef(ref), true);
  // A one-byte ceiling would reject any inline blob, but refs carry no bytes.
  assertTurnAttachments(tiny(), [ref], undefined);
  assertThrows(
    () => assertTurnAttachments(tiny(), [{ mimeType: 'image/png', data: 'aGVsbG8=' }], undefined),
    TheoremError,
  );
  const tooMany = assertThrows(
    () => assertTurnAttachments(tiny(), [ref, ref], undefined),
    TheoremError,
  );
  assertEquals(tooMany.kind, 'input');
  assertEquals(publicError(tooMany), 'Sorry, only 1 file can be sent per message.');
  // Text-mime sanitization only rewrites inline bytes; a ref passes through untouched.
  const csvRef = { mimeType: 'text/csv', uri: 'files/csv1' };
  const sanitized = sanitizeTurnBlobs(tiny(), [csvRef], undefined);
  assertEquals(sanitized.attachments, [csvRef]);
});

Deno.test('a media reference alongside inline blobs is still accepted under normal limits', () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: {
      text: 'both',
      attachments: [
        { mimeType: 'image/png', data: 'aGVsbG8=' },
        { mimeType: 'application/pdf', uri: 'files/doc9' },
      ],
    },
  });
  const media = generation.input.filter((p) => p.type !== 'text');
  assertEquals(media, [
    { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    { type: 'document', mimeType: 'application/pdf', uri: 'files/doc9' },
  ]);
});

Deno.test('wireInteractionPart emits { type, mimeType, uri } for a ref part', () => {
  const part: InteractionPart = { type: 'video', mimeType: 'video/mp4', uri: 'files/v1' };
  assertEquals(wireInteractionPart(part), {
    type: 'video',
    mimeType: 'video/mp4',
    uri: 'files/v1',
  });
  assertEquals(isMediaRefPart({ type: 'text', text: 'x' }), false);
  assertEquals(isMediaRefPart({ type: 'image', mimeType: 'image/png', data: 'x' }), false);
});

Deno.test('refused files name every reason, one line per problem, in the profile lexicon', () => {
  const profile = tiny();
  const err = assertThrows(
    () =>
      assertTurnAttachments(
        profile,
        [
          { mimeType: 'image/png', data: 'aGVsbG8=', name: 'photo.png' },
          { mimeType: 'video/mp4', uri: 'files/v1', name: 'clip.mp4' },
        ],
        undefined,
      ),
    TheoremError,
  );
  assertEquals(err.kind, 'input');
  assertEquals(
    err.message,
    'attachments refused: mime_not_allowed, too_many_files, file_too_large, turn_too_large',
  );
  assertEquals(err.message.includes('photo.png'), false);
  assertEquals(
    publicError(err),
    [
      "Sorry, clip.mp4 is a file type that can't be used here.",
      'Sorry, only 1 file can be sent per message.',
      'Sorry, photo.png is too large. Each file needs to be 0.0 MB or smaller.',
      'Sorry, those files are too large together. Please keep them under 0.0 MB in total.',
    ].join('\n'),
  );
  assertEquals(
    publicError(err, { 'attachments.file_too_large': '{fileName} is over the limit' }).split(
      '\n',
    )[2],
    'photo.png is over the limit',
  );
});
