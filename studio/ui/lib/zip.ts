import { strToU8, zipSync } from 'fflate';

/** 1 January 1980, the earliest date a zip can hold: every export has the same bytes. */
const ZIP_EPOCH = new Date(1980, 0, 1);

/** The files as a .zip, each at its path. */
export function zipFiles(
	files: readonly { path: string; code: string }[],
): Uint8Array<ArrayBuffer> {
	const entries = Object.fromEntries(files.map((file) => [file.path, strToU8(file.code)]));
	return new Uint8Array(zipSync(entries, { mtime: ZIP_EPOCH }));
}
