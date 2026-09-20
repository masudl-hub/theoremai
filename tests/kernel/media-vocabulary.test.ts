/**
 * One owner for "what media can a turn carry": `MEDIA_INPUT_KINDS` is the whole
 * vocabulary, a profile's `accept` lists are the whole host declaration, and the
 * only per-adapter media refusal is the reference part.
 */
import '../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import { mediaChannelForMime } from '../../src/kernel/registry/catalog.ts';
import { getProfile } from '../../src/kernel/registry/profiles.ts';
import { MEDIA_INPUT_KINDS } from '../../src/kernel/schema.ts';
import type { InteractionPart, MediaInputKind } from '../../src/kernel/types.ts';
import { wireMessageContent } from '../../src/providers/openrouter/openai/compat.ts';

/**
 * Google Interactions / Live documented input lists, verified 2026-09-12, plus
 * the provider alias essences the adapters also emit. Any change to the table
 * must be a deliberate change here first.
 *
 * The document row is Google's document-understanding list in full (PDF, text,
 * HTML, CSS, Markdown, CSV, XML, RTF, JavaScript, Python) plus the established
 * `application/json` row. TypeScript, `application/xml` and `application/rtf`
 * are not on Google's list, so they are not rows.
 */
const EXPECTED: Record<string, MediaInputKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/webp': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/aiff': 'audio',
  'audio/aac': 'audio',
  'audio/ogg': 'audio',
  'audio/flac': 'audio',
  'audio/webm': 'audio',
  'audio/mp4': 'audio',
  'audio/pcm': 'audio',
  'audio/m4a': 'audio',
  'audio/opus': 'audio',
  'audio/l16': 'audio',
  'audio/alaw': 'audio',
  'audio/mulaw': 'audio',
  'video/mp4': 'video',
  'video/mpeg': 'video',
  'video/quicktime': 'video',
  'video/mov': 'video',
  'video/x-msvideo': 'video',
  'video/avi': 'video',
  'video/x-flv': 'video',
  'video/mpg': 'video',
  'video/webm': 'video',
  'video/wmv': 'video',
  'video/x-ms-wmv': 'video',
  'video/3gpp': 'video',
  'application/pdf': 'document',
  'text/plain': 'document',
  'text/csv': 'document',
  'text/markdown': 'document',
  'text/md': 'document',
  'text/html': 'document',
  'text/css': 'document',
  'text/xml': 'document',
  'text/rtf': 'document',
  'text/javascript': 'document',
  'application/x-javascript': 'document',
  'text/x-python': 'document',
  'application/x-python': 'document',
  'application/json': 'document',
};

Deno.test('MEDIA_INPUT_KINDS is exactly the documented provider union', () => {
  assertEquals(Object.keys(MEDIA_INPUT_KINDS).sort(), Object.keys(EXPECTED).sort());
  for (const [mime, kind] of Object.entries(EXPECTED)) {
    assertEquals(MEDIA_INPUT_KINDS[mime], kind, mime);
  }
});

Deno.test('mediaChannelForMime answers acceptance from the profile alone', () => {
  const chat = getProfile('chat');
  assertEquals(mediaChannelForMime(chat, 'image/png'), 'attachments');
  assertEquals(mediaChannelForMime(chat, 'application/pdf'), 'attachments');
  assertEquals(mediaChannelForMime(chat, 'audio/wav'), 'voice');
  // Classifiable by the kernel, not on this profile's accept lists.
  assertEquals(mediaChannelForMime(chat, 'video/mp4'), undefined);
  // Not a media input type at all.
  assertEquals(mediaChannelForMime(chat, 'application/zip'), undefined);
  // Profile types with no `inputs` accept nothing.
  assertEquals(mediaChannelForMime(getProfile('speech'), 'image/png'), undefined);
});

Deno.test('mediaChannelForMime tolerates parameters and case like the kernel', () => {
  const chat = getProfile('chat');
  assertEquals(mediaChannelForMime(chat, 'IMAGE/PNG'), 'attachments');
  assertEquals(mediaChannelForMime(chat, 'text/csv; charset=utf-8'), 'attachments');
});

Deno.test('openAi compat wires every media kind and refuses only reference parts', () => {
  const parts: InteractionPart[] = [
    { type: 'text', text: 'hi' },
    { type: 'image', mimeType: 'image/png', data: 'AAA' },
    { type: 'audio', mimeType: 'audio/wav', data: 'BBB' },
    { type: 'video', mimeType: 'video/mp4', data: 'CCC' },
    { type: 'document', mimeType: 'application/pdf', data: 'DDD' },
  ];
  const wired = wireMessageContent(parts) as Array<Record<string, string>>;
  assertEquals(
    wired.map((p) => p.type),
    ['text', 'image_url', 'input_audio', 'file', 'file'],
  );

  assertThrows(
    () => wireMessageContent([{ type: 'image', mimeType: 'image/png', uri: 'files/abc' }]),
    TheoremError,
    'media references are not supported on openAi',
  );
});
