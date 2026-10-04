// A file attachment is read when its trial runs, not when the suite loads, so thousands of photos are never held at once.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { TheoremError } from '../guardrails/error.ts';
import type { EvalAttachment, EvalCase, EvalFileAttachment } from './types.ts';

async function hashedFile(path: string): Promise<{ bytes: Buffer; sha256: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new TheoremError(
      'config',
      `attachment ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`, // lexicon-exempt: developer contract error
    );
  }
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function fileBytes(attachment: EvalFileAttachment): Promise<Buffer> {
  const { bytes, sha256 } = await hashedFile(attachment.path);
  if (sha256 !== attachment.sha256) {
    throw new TheoremError(
      'config',
      `attachment ${attachment.path} hashes to ${sha256}, not the ${attachment.sha256} its case pins`, // lexicon-exempt: developer contract error
    );
  }
  return bytes;
}

async function attachmentData(attachment: EvalAttachment): Promise<string> {
  return 'data' in attachment ? attachment.data : (await fileBytes(attachment)).toString('base64');
}

async function pinCaseFiles(cases: EvalCase[], casesPath: string): Promise<EvalCase[]> {
  const pinned: EvalCase[] = [];
  for (const evalCase of cases) {
    const { input } = evalCase;
    if (!('attachments' in input) || input.attachments === undefined) {
      pinned.push(evalCase);
      continue;
    }
    const attachments: EvalAttachment[] = [];
    for (const attachment of input.attachments) {
      if ('data' in attachment) {
        attachments.push(attachment);
        continue;
      }
      const path = resolve(dirname(casesPath), attachment.path);
      try {
        await fileBytes({ ...attachment, path });
      } catch (error) {
        throw new TheoremError(
          'config',
          `case ${evalCase.id}: ${error instanceof Error ? error.message : String(error)}`, // lexicon-exempt: developer contract error
        );
      }
      attachments.push({ ...attachment, path });
    }
    pinned.push({ ...evalCase, input: { ...input, attachments } });
  }
  return pinned;
}

export { attachmentData, pinCaseFiles };
