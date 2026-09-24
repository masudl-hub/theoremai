/** Display label for a composer voice attachment from MIME / filename. */
export function voiceFormatLabel(file: File): string {
	const mime = file.type.toLowerCase();
	const fromMime = voiceExtensionFromMime(mime);
	if (fromMime) return `voice.${fromMime}`;
	const ext = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
	return ext ? `voice.${ext}` : 'voice.audio';
}

/** Format label for a voice note pill from MIME type; undefined when the format is unknown. */
export function voiceLabelFromMime(mime: string): string | undefined {
	const fromMime = voiceExtensionFromMime(mime.toLowerCase());
	return fromMime ? `voice.${fromMime}` : undefined;
}

function voiceExtensionFromMime(mime: string): string | undefined {
	if (mime.includes('webm')) return 'webm';
	if (mime.includes('wav')) return 'wav';
	if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
	if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
	if (mime.includes('ogg')) return 'ogg';
	return undefined;
}
