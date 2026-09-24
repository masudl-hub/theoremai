/**
 * Stage file picks against profile `maxFiles` (shared with voice) and, on
 * image profiles, `maxImages`. Excess incoming files are dropped; each limit
 * hit is an issue the caller words (`attachmentIssueText`).
 */

import type { AttachmentValidationIssue } from '../../../src/interface/mod.ts';

export type StageComposerFilesArgs = {
	existing: readonly File[];
	incoming: readonly File[];
	/** Profile `inputs.maxFiles`. When omitted, no cap. */
	maxFiles?: number;
	/** Staged voice notes that share the same maxFiles budget. */
	voiceCount?: number;
	/** Profile `inputs.maxImages`: cap on staged `image/*` files. When omitted, no cap. */
	maxImages?: number;
};

export type StageComposerFilesResult = {
	files: File[];
	dropped: number;
	/** One per limit that dropped a file (`too_many_images`, `too_many_files`). */
	issues: AttachmentValidationIssue[];
};

/** Whether a staged file counts against `maxInputImages` (the kernel counts `image/*`). */
function isImageFile(file: File): boolean {
	return file.type.startsWith('image/');
}

/**
 * Drop incoming images past `maxImages`, counting images already staged.
 * Non-image files always pass through; `maxFiles` is applied afterwards.
 */
function capIncomingImages(
	existing: readonly File[],
	incoming: readonly File[],
	maxImages: number | undefined,
): { kept: File[]; dropped: number } {
	if (maxImages === undefined || !Number.isFinite(maxImages) || maxImages < 0) {
		return { kept: [...incoming], dropped: 0 };
	}
	let room = Math.max(0, maxImages - existing.filter(isImageFile).length);
	const kept = incoming.filter((file) => {
		if (!isImageFile(file)) return true;
		if (room === 0) return false;
		room -= 1;
		return true;
	});
	return { kept, dropped: incoming.length - kept.length };
}

/** Append `incoming` to `existing`, dropping images past maxImages, then overflow past maxFiles − voice. */
export function stageComposerFiles(args: StageComposerFilesArgs): StageComposerFilesResult {
	const images = capIncomingImages(args.existing, args.incoming, args.maxImages);
	const issues: AttachmentValidationIssue[] =
		images.dropped > 0 && args.maxImages !== undefined
			? [{ code: 'too_many_images', params: { maxImages: args.maxImages } }]
			: [];
	const incoming = images.kept;
	const voiceCount = Math.max(0, args.voiceCount ?? 0);
	const maxFiles = args.maxFiles;
	if (maxFiles === undefined || !Number.isFinite(maxFiles) || maxFiles < 0) {
		return { files: [...args.existing, ...incoming], dropped: images.dropped, issues };
	}

	const room = Math.max(0, maxFiles - voiceCount - args.existing.length);
	if (incoming.length <= room) {
		return { files: [...args.existing, ...incoming], dropped: images.dropped, issues };
	}

	const kept = room === 0 ? [] : incoming.slice(0, room);
	return {
		files: [...args.existing, ...kept],
		dropped: images.dropped + incoming.length - kept.length,
		issues: [...issues, { code: 'too_many_files', params: { maxFiles } }],
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
