/**
 * Restore composer fields from a serializable pending `UserTurnDraft`.
 */

import type { UserPart, UserTurnDraft } from '@theoremjs/agents/interface';
import { pendingAttachmentsToFiles } from './encode-files.ts';

export type ComposerDraftFields = {
  text: string;
  parts?: UserPart[];
  files: File[];
  voice: File[];
};

/** Map an encoded pending draft back into live composer file fields. */
export function composerFieldsFromDraft(draft: UserTurnDraft): ComposerDraftFields {
  return {
    text: draft.text ?? '',
    ...(draft.parts ? { parts: draft.parts } : {}),
    files: pendingAttachmentsToFiles(draft.attachments ?? []),
    voice: pendingAttachmentsToFiles(draft.voice ?? []),
  };
}
