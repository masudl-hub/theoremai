/**
 * Transcript scroll geometry — pure helpers.
 */

export function resolveScrollToBottomScrollTop(args: {
	scrollHeight: number;
	clientHeight: number;
}): number {
	return Math.max(0, args.scrollHeight - args.clientHeight);
}
