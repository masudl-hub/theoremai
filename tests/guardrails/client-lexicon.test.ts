import { assertEquals } from '@std/assert';
import {
  attachmentIssueText,
  CLIENT_LEXICON_KEYS,
  overrideLexicon,
  resetLexicon,
} from '../../mod.ts';
import { clientLexicon } from '../../src/guardrails/lexicon.ts';
import { attachmentIssues } from '../../src/kernel/registry/attachments.ts';

Deno.test('clientLexicon sends only client keys, the profile over the process override', () => {
  overrideLexicon({ 'error.timeout': 'Process timeout.', 'error.network': 'Process network.' });
  try {
    const lexicon = clientLexicon({
      'error.timeout': 'Profile timeout.',
      'taint.reason_tainted': 'Host-only line.',
    });
    assertEquals(lexicon, {
      'error.timeout': 'Profile timeout.',
      'error.network': 'Process network.',
    });
    for (const key of Object.keys(lexicon)) {
      assertEquals((CLIENT_LEXICON_KEYS as readonly string[]).includes(key), true);
    }
  } finally {
    resetLexicon();
  }
});

Deno.test('clientLexicon is empty without overrides', () => {
  assertEquals(clientLexicon(), {});
});

Deno.test('attachmentIssueText words an issue with its file name and the profile lexicon', () => {
  assertEquals(
    attachmentIssueText({ code: 'too_many_images', params: { maxImages: 1 } }),
    'Sorry, only 1 image can be sent per message.',
  );
  assertEquals(
    attachmentIssueText({ code: 'too_many_images', params: { maxImages: 3 } }),
    'Sorry, only 3 images can be sent per message.',
  );
  assertEquals(
    attachmentIssueText(
      { code: 'too_many_images', params: { maxImages: 2 } },
      { 'attachments.too_many_images': 'Max {maxImages} pictures.' },
    ),
    'Max 2 pictures.',
  );
  const [named] = attachmentIssues(
    { attachments: ['image/png'], limits: { maxBytes: 1, maxTurnBytes: 10, maxFiles: 5 } },
    [{ name: 'huge.png', mimeType: 'image/png', sizeBytes: 2 }],
    [],
  );
  assertEquals(
    attachmentIssueText(named),
    'Sorry, huge.png is too large. Each file needs to be 0.0 MB or smaller.',
  );
});

Deno.test('attachmentIssues reports too_many_images past the image cap', () => {
  const png = { mimeType: 'image/png', sizeBytes: 1 };
  assertEquals(
    attachmentIssues(
      {
        attachments: ['image/png'],
        maxImages: 1,
        limits: { maxBytes: 10, maxTurnBytes: 100, maxFiles: 5 },
      },
      [png, png],
      [],
    ),
    [{ code: 'too_many_images', params: { maxImages: 1 } }],
  );
});
