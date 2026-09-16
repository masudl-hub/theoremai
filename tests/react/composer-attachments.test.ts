import { assertEquals } from '@std/assert';
import {
  attachmentsDroppedMessage,
  canStageVoice,
  stageComposerFiles,
} from '../../react/src/client/composer-attachments.ts';

function stubFile(name: string): File {
  return new File([new Uint8Array([1])], name, { type: 'application/octet-stream' });
}

Deno.test('stageComposerFiles keeps picks under maxFiles and reports drops', () => {
  const existing = [stubFile('a.pdf'), stubFile('b.pdf')];
  const incoming = [stubFile('c.pdf'), stubFile('d.pdf'), stubFile('e.pdf'), stubFile('f.pdf')];
  const staged = stageComposerFiles({
    existing,
    incoming,
    maxFiles: 5,
    voiceCount: 0,
  });
  assertEquals(staged.files.length, 5);
  assertEquals(staged.dropped, 1);
  assertEquals(staged.notice, attachmentsDroppedMessage(5, 1));
  assertEquals(
    staged.files.map((f) => f.name),
    ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'],
  );
});

Deno.test('stageComposerFiles reserves slots for staged voice', () => {
  const staged = stageComposerFiles({
    existing: [stubFile('a.pdf'), stubFile('b.pdf')],
    incoming: [stubFile('c.pdf'), stubFile('d.pdf'), stubFile('e.pdf')],
    maxFiles: 5,
    voiceCount: 1,
  });
  assertEquals(staged.files.length, 4);
  assertEquals(staged.dropped, 1);
  assertEquals(staged.notice, '5 is the limit, 1 attachment was dropped.');
});

Deno.test('stageComposerFiles drops the whole pick when already at capacity', () => {
  const staged = stageComposerFiles({
    existing: [stubFile('a.pdf'), stubFile('b.pdf'), stubFile('c.pdf')],
    incoming: [stubFile('d.pdf'), stubFile('e.pdf')],
    maxFiles: 3,
  });
  assertEquals(staged.files.length, 3);
  assertEquals(staged.dropped, 2);
  assertEquals(staged.notice, '3 is the limit, 2 attachments were dropped.');
});

Deno.test('canStageVoice blocks when files already fill maxFiles', () => {
  assertEquals(canStageVoice({ fileCount: 5, maxFiles: 5 }), false);
  assertEquals(canStageVoice({ fileCount: 4, maxFiles: 5 }), true);
  assertEquals(canStageVoice({ fileCount: 5 }), true);
});
