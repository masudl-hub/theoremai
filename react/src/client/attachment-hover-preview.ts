/** Hover-card geometry for composer attachment pills (model-sculpt agent_chat parity). */

export const ATTACH_PREVIEW_WIDTH_PX = 240;
export const ATTACH_PREVIEW_OFFSET_PX = 6;
export const ATTACH_PREVIEW_VIEWPORT_PAD_PX = 8;
/** Prefer anchoring above the chip when this much space exists. */
export const ATTACH_PREVIEW_ABOVE_THRESHOLD_PX = 190;

export type AttachPreviewStyle = {
	left: number;
	top?: number;
	bottom?: number;
};

export function formatAttachmentSize(bytes?: number): string {
	if (!bytes || bytes <= 0) return '';
	if (bytes < 1024) return `${String(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function clampAttachPreviewLeft(anchorLeft: number, viewportWidth: number): number {
	const maxLeft = Math.max(
		ATTACH_PREVIEW_VIEWPORT_PAD_PX,
		viewportWidth - ATTACH_PREVIEW_WIDTH_PX - ATTACH_PREVIEW_VIEWPORT_PAD_PX,
	);
	return Math.min(Math.max(ATTACH_PREVIEW_VIEWPORT_PAD_PX, anchorLeft), maxLeft);
}

export function resolveAttachPreviewStyle(
	anchor: Pick<DOMRect, 'left' | 'top' | 'bottom'>,
	viewport: { width: number; height: number } = {
		width: typeof window !== 'undefined' ? window.innerWidth : 0,
		height: typeof window !== 'undefined' ? window.innerHeight : 0,
	},
): AttachPreviewStyle {
	const left = clampAttachPreviewLeft(anchor.left, viewport.width);
	const hasRoomAbove = anchor.top > ATTACH_PREVIEW_ABOVE_THRESHOLD_PX;
	if (hasRoomAbove) {
		return {
			left,
			bottom: Math.max(
				ATTACH_PREVIEW_VIEWPORT_PAD_PX,
				viewport.height - anchor.top + ATTACH_PREVIEW_OFFSET_PX,
			),
		};
	}
	return {
		left,
		top: Math.min(
			viewport.height - ATTACH_PREVIEW_VIEWPORT_PAD_PX,
			anchor.bottom + ATTACH_PREVIEW_OFFSET_PX,
		),
	};
}
