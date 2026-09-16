/**
 * Round-trip pending attachment encode/decode used by stash restore.
 */
import { assertEquals } from '@std/assert';
import { composerFieldsFromDraft } from '../../react/src/client/decode-composer-draft.ts';
import { encodeComposerDraft } from '../../react/src/client/encode-composer-draft.ts';
import { pendingAttachmentsToFiles } from '../../react/src/client/encode-files.ts';

Deno.test('pendingAttachmentsToFiles restores bytes and name/mime', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 250]);
  const data = btoa(String.fromCharCode(...bytes));
  const files = pendingAttachmentsToFiles([
    { name: 'probe.bin', mimeType: 'application/octet-stream', sizeBytes: 5, data },
    { name: 'skip.txt', mimeType: 'text/plain', sizeBytes: 0 },
  ]);
  assertEquals(files.length, 1);
  assertEquals(files[0]?.name, 'probe.bin');
  assertEquals(files[0]?.type, 'application/octet-stream');
  assertEquals(files[0]?.size, 5);
});

Deno.test('encodeComposerDraft → composerFieldsFromDraft restores text, files, voice', async () => {
  const file = new File([new Uint8Array([9, 8, 7])], 'note.txt', { type: 'text/plain' });
  const voice = new File([new Uint8Array([4, 5])], 'voice.webm', { type: 'audio/webm' });
  const draft = await encodeComposerDraft({
    text: '  hello stash  ',
    pendingFiles: [file],
    pendingVoice: [voice],
  });
  const restored = composerFieldsFromDraft(draft);
  assertEquals(restored.text, 'hello stash');
  assertEquals(restored.files.length, 1);
  assertEquals(restored.voice.length, 1);
  assertEquals(restored.files[0]?.name, 'note.txt');
  assertEquals(restored.voice[0]?.name, 'voice.webm');
  assertEquals(restored.files[0]?.size, 3);
  assertEquals(restored.voice[0]?.size, 2);
});
