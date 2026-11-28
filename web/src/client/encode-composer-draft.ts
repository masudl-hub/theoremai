/**
 * Encode composer fields into a serializable `UserTurnDraft` for pending intents.
 */

import { messageParts, type UserPart, type UserTurnDraft } from '@theoremjs/agents/interface';
import { encodeFiles } from './encode-files.ts';

export async function encodeComposerDraft(args: {
  text: string;
  /** The words and refs `text` is the plain copy of. */
  parts?: readonly UserPart[];
  pendingFiles?: readonly File[];
  pendingVoice?: readonly File[];
}): Promise<UserTurnDraft> {
  const text = args.text.trim();
  const parts = messageParts(args.parts);
  const files = args.pendingFiles ?? [];
  const voice = args.pendingVoice ?? [];
  const encodedFiles = files.length ? await encodeFiles(files) : [];
  const encodedVoice = voice.length ? await encodeFiles(voice) : [];
  return {
    ...(text ? { text } : {}),
    ...(parts ? { parts } : {}),
    ...(encodedFiles.length
      ? {
          attachments: encodedFiles.map((blob, index) => ({
            name: blob.name,
            mimeType: blob.mimeType,
            sizeBytes: files[index]?.size ?? 0,
            data: blob.data,
          })),
        }
      : {}),
    ...(encodedVoice.length
      ? {
          voice: encodedVoice.map((blob, index) => ({
            name: blob.name,
            mimeType: blob.mimeType,
            sizeBytes: voice[index]?.size ?? 0,
            data: blob.data,
          })),
        }
      : {}),
  };
}
