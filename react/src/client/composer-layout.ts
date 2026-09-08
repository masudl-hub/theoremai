export function isComposerExpanded(
	textLength: number,
	attachmentCount: number,
	voiceCount = 0,
	voiceMode = false,
): boolean {
	return textLength > 0 || attachmentCount > 0 || voiceCount > 0 || voiceMode;
}

export function measureComposerTextareaHeight(args: {
	scrollHeight: number;
	maxHeight: number;
	isExpanded: boolean;
}): {
	heightPx: number;
	overflowY: 'auto' | 'hidden';
	contentHeightFallback: number;
} {
	if (!args.isExpanded) {
		return { heightPx: 36, overflowY: 'hidden', contentHeightFallback: 46 };
	}
	if (args.scrollHeight > args.maxHeight) {
		return {
			heightPx: args.maxHeight,
			overflowY: 'auto',
			contentHeightFallback: args.maxHeight + 10,
		};
	}
	return {
		heightPx: Math.max(args.scrollHeight, 36),
		overflowY: 'hidden',
		contentHeightFallback: args.scrollHeight + 10,
	};
}

export function composerShellHeight(args: { isExpanded: boolean; contentHeight: number }): number {
	return args.isExpanded ? args.contentHeight : 46;
}
