/** Stable attachment ids for composer preview / remove routing. */

export function fileAttachmentId(file: File, index: number): string {
	return `file:${String(index)}:${file.name}:${String(file.size)}:${String(file.lastModified)}`;
}

export function voiceAttachmentId(file: File, index: number): string {
	return `voice:${String(index)}:${file.name}:${String(file.size)}:${String(file.lastModified)}`;
}
