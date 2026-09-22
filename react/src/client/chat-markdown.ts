/**
 * Chat markdown → sanitized HTML for assistant body rendering.
 * Kept intentionally small: GFM via marked, then DOMPurify.
 */

import DOMPurify from 'isomorphic-dompurify';
import { marked } from 'marked';

marked.setOptions({
	gfm: true,
	breaks: true,
});

let hooksInstalled = false;

function ensureLinkHooks(): void {
	if (hooksInstalled || typeof document === 'undefined') return;
	hooksInstalled = true;
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node instanceof HTMLAnchorElement) {
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		}
	});
}

export function renderChatMarkdown(markdown: string): string {
	const raw = marked.parse(markdown, { async: false });
	ensureLinkHooks();
	return DOMPurify.sanitize(raw, {
		USE_PROFILES: { html: true },
		ALLOW_DATA_ATTR: false,
		ADD_ATTR: ['target', 'rel'],
	});
}
