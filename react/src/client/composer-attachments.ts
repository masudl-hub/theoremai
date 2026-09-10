/**
 * Stage file picks against profile `maxFiles` (shared with voice).
 * Excess incoming files are dropped; caller surfaces the notice.
 */

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
	/** Set when any incoming file was dropped for the limit. */
	notice?: string;
};

/** User-facing notice when picks exceed `maxFiles`. */
export function attachmentsDroppedMessage(limit: number, dropped: number): string {
	const verb = dropped === 1 ? 'attachment was' : 'attachments were';
	return `${String(limit)} is the limit, ${String(dropped)} ${verb} dropped.`;
}

/** Append `incoming` to `existing`, dropping overflow past maxFiles − voice. */
export function stageComposerFiles(args: StageComposerFilesArgs): StageComposerFilesResult {
	const voiceCount = Math.max(0, args.voiceCount ?? 0);
	const maxFiles = args.maxFiles;
	if (maxFiles === undefined || !Number.isFinite(maxFiles) || maxFiles < 0) {
		return { files: [...args.existing, ...args.incoming], dropped: 0 };
	}

	const room = Math.max(0, maxFiles - voiceCount - args.existing.length);
	if (args.incoming.length <= room) {
		return { files: [...args.existing, ...args.incoming], dropped: 0 };
	}

	const kept = room === 0 ? [] : args.incoming.slice(0, room);
	const dropped = args.incoming.length - kept.length;
	return {
		files: kept.length === 0 ? [...args.existing] : [...args.existing, ...kept],
		dropped,
		notice: attachmentsDroppedMessage(maxFiles, dropped),
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
