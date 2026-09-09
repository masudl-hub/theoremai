/**
 * Encode composer fields into a serializable `UserTurnDraft` for pending intents.
 */

import type { UserTurnDraft } from 'theorum/interface';
import { encodeFiles } from './encode-files';

export async function encodeComposerDraft(args: {
	text: string;
	pendingFiles?: readonly File[];
	pendingVoice?: readonly File[];
}): Promise<UserTurnDraft> {
	const text = args.text.trim();
	const files = args.pendingFiles ?? [];
	const voice = args.pendingVoice ?? [];
	const encodedFiles = files.length ? await encodeFiles(files) : [];
	const encodedVoice = voice.length ? await encodeFiles(voice) : [];
	return {
		...(text ? { text } : {}),
		...(encodedFiles.length
			? {
					attachments: encodedFiles.map((blob, index) => ({
						name: blob.name,
						mimeType: blob.mimeType,
						sizeBytes: files[index]?.size ?? 0,
						data: blob.data,
					})),
				}
			: {}),
		...(encodedVoice.length
			? {
					voice: encodedVoice.map((blob, index) => ({
						name: blob.name,
						mimeType: blob.mimeType,
						sizeBytes: voice[index]?.size ?? 0,
						data: blob.data,
					})),
				}
			: {}),
	};
}
