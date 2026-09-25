/**
 * Stage file picks against profile `maxFiles` (shared with voice). Excess
 * incoming files are dropped; the limit hit is an issue the caller words
 * (`attachmentIssueText`).
 */

import type { AttachmentValidationIssue } from '../../../src/interface/mod.ts';

export type StageComposerFilesArgs = {
	existing: readonly File[];
	incoming: readonly File[];
	/** Profile `inputs.maxFiles`. When omitted, no cap. */
	maxFiles?: number;
	/** Staged voice notes that share the same maxFiles budget. */
	voiceCount?: number;
};

export type StageComposerFilesResult = {
	files: File[];
	dropped: number;
	/** `too_many_files` when the cap dropped a file. */
	issues: AttachmentValidationIssue[];
};

/** Append `incoming` to `existing`, dropping overflow past maxFiles − voice. */
export function stageComposerFiles(args: StageComposerFilesArgs): StageComposerFilesResult {
	const { existing, incoming, maxFiles } = args;
	const voiceCount = Math.max(0, args.voiceCount ?? 0);
	if (maxFiles === undefined || !Number.isFinite(maxFiles) || maxFiles < 0) {
		return { files: [...existing, ...incoming], dropped: 0, issues: [] };
	}

	const room = Math.max(0, maxFiles - voiceCount - existing.length);
	if (incoming.length <= room) {
		return { files: [...existing, ...incoming], dropped: 0, issues: [] };
	}

	const kept = room === 0 ? [] : incoming.slice(0, room);
	return {
		files: [...existing, ...kept],
		dropped: incoming.length - kept.length,
		issues: [{ code: 'too_many_files', params: { maxFiles } }],
	};
}

/**
 * Whether a new voice note fits under maxFiles.
 * Recording clears any prior staged voice first, so only `fileCount` matters.
 */
export function canStageVoice(args: { fileCount: number; maxFiles?: number }): boolean {
	const maxFiles = args.maxFiles;
	if (maxFiles === undefined || !Number.isFinite(maxFiles)) return true;
	return args.fileCount < maxFiles;
}
