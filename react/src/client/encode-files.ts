import type { PendingAttachment, TranscriptBlock } from '../../../src/interface/mod.ts';
import { base64ToBytes, bytesToBase64 } from '../../../src/kernel/util/base64.ts';

export function filesToPending(files: readonly File[]): PendingAttachment[] {
	return files.map((file) => ({
		name: file.name,
		mimeType: file.type || 'application/octet-stream',
		sizeBytes: file.size,
	}));
}

/**
 * Rebuild `File`s from encoded pending attachments (stash / queue restore).
 * Attachments without `data` cannot be restored and are skipped.
 */
export function pendingAttachmentsToFiles(
	attachments: readonly PendingAttachment[],
): File[] {
	const files: File[] = [];
	for (const attachment of attachments) {
		if (typeof attachment.data !== 'string' || attachment.data.length === 0) continue;
		const bytes = base64ToBytes(attachment.data);
		const buffer = bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer;
		files.push(
			new File([buffer], attachment.name, {
				type: attachment.mimeType || 'application/octet-stream',
			}),
		);
	}
	return files;
}

export async function encodeFiles(
	files: readonly File[],
): Promise<Array<{ name: string; mimeType: string; data: string }>> {
	const out: Array<{ name: string; mimeType: string; data: string }> = [];
	for (const file of files) {
		out.push({
			name: file.name,
			mimeType: file.type || 'application/octet-stream',
			data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
		});
	}
	return out;
}

/** Copy encoded base64 onto matching user attachment/voice transcript blocks for UI preview. */
export function attachPreviewData(
	blocks: readonly TranscriptBlock[],
	attachments?: ReadonlyArray<{ data: string }>,
	voice?: ReadonlyArray<{ data: string }>,
): TranscriptBlock[] {
	let attachmentIndex = 0;
	let voiceIndex = 0;
	return blocks.map((block) => {
		if (block.kind === 'user-attachment') {
			const data = attachments?.[attachmentIndex]?.data;
			attachmentIndex += 1;
			return data !== undefined ? { ...block, data } : block;
		}
		if (block.kind === 'user-voice') {
			const data = voice?.[voiceIndex]?.data;
			voiceIndex += 1;
			return data !== undefined ? { ...block, data } : block;
		}
		return block;
	});
}
