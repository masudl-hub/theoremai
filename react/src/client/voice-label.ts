/** A voice note's audio format (`webm`, `wav`, `mp3`, `m4a`, `ogg`) from its MIME type; undefined when unknown. */
export function voiceFormatFromMime(mime: string): string | undefined {
	const lower = mime.toLowerCase();
	if (lower.includes('webm')) return 'webm';
	if (lower.includes('wav')) return 'wav';
	if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
	if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'm4a';
	if (lower.includes('ogg')) return 'ogg';
	return undefined;
}
