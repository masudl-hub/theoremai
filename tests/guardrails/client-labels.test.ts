import { assertEquals } from '@std/assert';
import { attachmentIssueText, CLIENT_LABEL_KEYS, overrideLabels, resetLabels } from '../../mod.ts';
import { clientLabels } from '../../src/guardrails/labels.ts';
import { attachmentIssues } from '../../src/kernel/registry/attachments.ts';

Deno.test('clientLabels sends only client keys, the profile over the process override', () => {
  overrideLabels({ 'error.timeout': 'Process timeout.', 'error.network': 'Process network.' });
  try {
    const labels = clientLabels({
      'error.timeout': 'Profile timeout.',
      'taint.reason_tainted': 'Host-only line.',
    });
    assertEquals(labels, {
      'error.timeout': 'Profile timeout.',
      'error.network': 'Process network.',
    });
    for (const key of Object.keys(labels)) {
      assertEquals((CLIENT_LABEL_KEYS as readonly string[]).includes(key), true);
    }
  } finally {
    resetLabels();
  }
});

Deno.test('clientLabels is empty without overrides', () => {
  assertEquals(clientLabels(), {});
});

Deno.test('attachmentIssueText words an issue with its file name and the profile labels', () => {
  assertEquals(
    attachmentIssueText({ code: 'too_many_files', params: { maxFiles: 1 } }),
    'Sorry, only 1 file can be sent per message.',
  );
  assertEquals(
    attachmentIssueText({ code: 'too_many_files', params: { maxFiles: 3 } }),
    'Sorry, only 3 files can be sent per message.',
  );
  assertEquals(
    attachmentIssueText(
      { code: 'too_many_files', params: { maxFiles: 2 } },
      { 'attachments.too_many_files': 'Max {maxFiles} files.' },
    ),
    'Max 2 files.',
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
