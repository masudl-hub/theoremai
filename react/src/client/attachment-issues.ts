/**
 * Render headless attachment validation issues (semantic codes + params) as
 * user-facing strings via the kernel lexicon defaults. Hosts override copy
 * with `overrideLexicon` from `theorum` or by rendering codes themselves.
 */

import { type LexiconKey, lexiconText } from 'theorum';
import type { AttachmentValidationIssue } from 'theorum/interface';

const ISSUE_LEXICON: Record<AttachmentValidationIssue['code'], LexiconKey> = {
	mime_not_allowed: 'attachments.mime_not_allowed',
	too_many_files: 'attachments.too_many_files',
	file_too_large: 'attachments.file_too_large',
	turn_too_large: 'attachments.turn_too_large',
	attachments_not_accepted: 'attachments.not_accepted',
	voice_not_accepted: 'attachments.not_accepted',
	limits_unconfigured: 'attachments.limits_unconfigured',
};

const PARAM_KEYS = [
	'maxFiles',
	'maxBytes',
	'maxTurnBytes',
	'mimeType',
	'channel',
] as const satisfies ReadonlyArray<keyof NonNullable<AttachmentValidationIssue['params']>>;

function lexiconParams(issue: AttachmentValidationIssue): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	if (issue.fileName !== undefined) out.fileName = issue.fileName;
	const params = issue.params;
	if (!params) return out;
	for (const key of PARAM_KEYS) {
		const value = params[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

export function attachmentIssueText(issue: AttachmentValidationIssue): string {
	return lexiconText(ISSUE_LEXICON[issue.code], lexiconParams(issue));
}
