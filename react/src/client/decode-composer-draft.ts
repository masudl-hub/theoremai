/**
 * Restore composer fields from a serializable pending `UserTurnDraft`.
 */

import type { UserTurnDraft } from 'theorum/interface';
import { pendingAttachmentsToFiles } from './encode-files.ts';

export type ComposerDraftFields = {
	text: string;
	files: File[];
	voice: File[];
};

/** Map an encoded pending draft back into live composer file fields. */
export function composerFieldsFromDraft(draft: UserTurnDraft): ComposerDraftFields {
	return {
		text: draft.text ?? '',
		files: pendingAttachmentsToFiles(draft.attachments ?? []),
		voice: pendingAttachmentsToFiles(draft.voice ?? []),
	};
}
