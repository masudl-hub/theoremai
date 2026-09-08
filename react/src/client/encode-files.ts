import type { PendingAttachment, TranscriptBlock } from 'theorum/interface';

export function filesToPending(files: readonly File[]): PendingAttachment[] {
	return files.map((file) => ({
		name: file.name,
		mimeType: file.type || 'application/octet-stream',
		sizeBytes: file.size,
	}));
}

async function fileToBase64(file: File): Promise<string> {
	const buffer = await file.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export async function encodeFiles(
	files: readonly File[],
): Promise<Array<{ name: string; mimeType: string; data: string }>> {
	const out: Array<{ name: string; mimeType: string; data: string }> = [];
	for (const file of files) {
		out.push({
			name: file.name,
			mimeType: file.type || 'application/octet-stream',
			data: await fileToBase64(file),
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
