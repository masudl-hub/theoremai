import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerAttachmentItem } from './ComposerAttachmentsRow';
import { fileAttachmentId, voiceAttachmentId } from './composer-attachment-ids';

function ensurePreviewUrl(
	map: Map<string, string>,
	id: string,
	file: File,
	keep: string[],
): void {
	keep.push(id);
	if (!map.has(id)) map.set(id, URL.createObjectURL(file));
}

function syncPreviewUrls(
	map: Map<string, string>,
	pendingFiles: readonly File[],
	pendingVoice: readonly File[],
): void {
	const keep: string[] = [];
	for (const [index, file] of pendingFiles.entries()) {
		if (!file.type.startsWith('image/')) continue;
		ensurePreviewUrl(map, fileAttachmentId(file, index), file, keep);
	}
	for (const [index, file] of pendingVoice.entries()) {
		ensurePreviewUrl(map, voiceAttachmentId(file, index), file, keep);
	}
	for (const id of [...map.keys()]) {
		if (keep.includes(id)) continue;
		const url = map.get(id);
		if (url) URL.revokeObjectURL(url);
		map.delete(id);
	}
}

function toAttachItems(
	pendingFiles: readonly File[],
	pendingVoice: readonly File[],
	urls: Map<string, string>,
): ComposerAttachmentItem[] {
	const files = pendingFiles.map((file, index) => {
		const id = fileAttachmentId(file, index);
		return { id, kind: 'file' as const, file, previewUrl: urls.get(id) };
	});
	const voices = pendingVoice.map((file, index) => {
		const id = voiceAttachmentId(file, index);
		return { id, kind: 'voice' as const, file, previewUrl: urls.get(id) };
	});
	return [...files, ...voices];
}

/** Object-URL previews for staged image/voice attachments. */
export function useComposerAttachmentPreviews(
	pendingFiles: readonly File[],
	pendingVoice: readonly File[],
) {
	const previewUrlsRef = useRef(new Map<string, string>());
	const [previewTick, setPreviewTick] = useState(0);

	const revokeAllPreviews = useCallback(() => {
		for (const url of previewUrlsRef.current.values()) {
			URL.revokeObjectURL(url);
		}
		previewUrlsRef.current.clear();
	}, []);

	useEffect(() => {
		syncPreviewUrls(previewUrlsRef.current, pendingFiles, pendingVoice);
		setPreviewTick((v) => v + 1);
	}, [pendingFiles, pendingVoice]);

	const attachItems = useMemo(
		() => toAttachItems(pendingFiles, pendingVoice, previewUrlsRef.current),
		[pendingFiles, pendingVoice, previewTick],
	);

	return { attachItems, revokeAllPreviews };
}
