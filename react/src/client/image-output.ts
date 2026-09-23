/** Display helpers for image-profile output. */

/**
 * Profile `image.aspectRatio` (`"16:9"`) as width / height, for Astryx
 * `AspectRatio`. Undefined when unset or malformed — the provider picks.
 */
export function parseAspectRatio(value: string | undefined): number | undefined {
	const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
	if (!match) return undefined;
	const width = Number(match[1]);
	const height = Number(match[2]);
	return width > 0 && height > 0 ? width / height : undefined;
}
