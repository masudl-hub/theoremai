/**
 * URI media references (`TurnMediaRef` / `InteractionMediaRefPart`): MIME
 * acceptance still applies; base64 and byte limits do not; the uri passes
 * through untouched for the Google adapter to wire.
 */
import '../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { TheorumError } from '../../src/guardrails/error.ts';
import { isMediaRefPart, wireInteractionPart } from '../../src/kernel/interaction-parts.ts';
import {
  assertAttachmentLimits,
  isTurnMediaRef,
  sanitizeTurnBlobs,
} from '../../src/kernel/registry/attachments.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type { InteractionPart, MediaLimits } from '../../src/kernel/types.ts';

const TINY: MediaLimits = { maxFiles: 1, maxBytes: 1, maxTurnBytes: 1 };

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
    TheorumError,
    "MIME 'video/mp4' is not accepted on chat",
  );
});

Deno.test('a media reference never runs base64 or byte limits; file count still applies', () => {
  const ref = { mimeType: 'image/png', uri: 'files/abc123' };
  assertEquals(isTurnMediaRef(ref), true);
  // A one-byte ceiling would reject any inline blob, but refs carry no bytes.
  assertAttachmentLimits([ref], TINY);
  assertThrows(
    () => assertAttachmentLimits([{ mimeType: 'image/png', data: 'aGVsbG8=' }], TINY),
    TheorumError,
  );
  assertThrows(() => assertAttachmentLimits([ref, ref], TINY), TheorumError, 'Only 1 file');
  // Text-mime sanitization only rewrites inline bytes; a ref passes through untouched.
  const csvRef = { mimeType: 'text/csv', uri: 'files/csv1' };
  const sanitized = sanitizeTurnBlobs([csvRef], undefined, TINY);
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
