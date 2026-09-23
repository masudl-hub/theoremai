/**
 * Stage file picks against profile `maxFiles` (shared with voice) and, on
 * image profiles, `image.maxInputImages`. Excess incoming files are dropped;
 * caller surfaces the notice.
 */

export type StageComposerFilesArgs = {
	existing: readonly File[];
	incoming: readonly File[];
	/** Profile `inputs.maxFiles`. When omitted, no cap. */
	maxFiles?: number;
	/** Staged voice notes that share the same maxFiles budget. */
	voiceCount?: number;
	/** Image profile `image.maxInputImages`: cap on staged `image/*` files. When omitted, no cap. */
	maxImages?: number;
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

/** User-facing notice when picks exceed `maxInputImages`. */
export function imagesDroppedMessage(limit: number, dropped: number): string {
	const verb = dropped === 1 ? 'image was' : 'images were';
	return `${String(limit)} ${limit === 1 ? 'image is' : 'images is'} the limit, ${String(dropped)} ${verb} dropped.`;
}

/** Whether a staged file counts against `maxInputImages` (the kernel counts `image/*`). */
export function isImageFile(file: File): boolean {
	return file.type.startsWith('image/');
}

/**
 * Drop incoming images past `maxImages`, counting images already staged.
 * Non-image files always pass through; `maxFiles` is applied afterwards.
 */
export function capIncomingImages(
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
	const imageNotice =
		images.dropped > 0 && args.maxImages !== undefined ? imagesDroppedMessage(args.maxImages, images.dropped) : undefined;
	const incoming = images.kept;
	const voiceCount = Math.max(0, args.voiceCount ?? 0);
	const maxFiles = args.maxFiles;
	if (maxFiles === undefined || !Number.isFinite(maxFiles) || maxFiles < 0) {
		return { files: [...args.existing, ...incoming], dropped: images.dropped, notice: imageNotice };
	}

	const room = Math.max(0, maxFiles - voiceCount - args.existing.length);
	if (incoming.length <= room) {
		return { files: [...args.existing, ...incoming], dropped: images.dropped, notice: imageNotice };
	}

	const kept = room === 0 ? [] : incoming.slice(0, room);
	const dropped = incoming.length - kept.length;
	const fileNotice = attachmentsDroppedMessage(maxFiles, dropped);
	return {
		files: kept.length === 0 ? [...args.existing] : [...args.existing, ...kept],
		dropped: images.dropped + dropped,
		notice: imageNotice ? `${imageNotice} ${fileNotice}` : fileNotice,
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
