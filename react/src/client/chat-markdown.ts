/**
 * Chat markdown → sanitized HTML for assistant body rendering.
 * Kept intentionally small: GFM via marked, then DOMPurify (browser).
 */

import DOMPurify from 'dompurify';
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

/** Escape HTML so SSR/node never emits markup without DOMPurify. */
function escapeHtmlText(raw: string): string {
	return raw
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export function renderChatMarkdown(markdown: string): string {
	const raw = marked.parse(markdown, { async: false });
	if (typeof document === 'undefined') {
		// SSR / node tests: escape rather than half-strip tags (run UI is browser-only).
		return escapeHtmlText(typeof raw === 'string' ? raw : String(raw));
	}
	ensureLinkHooks();
	return DOMPurify.sanitize(raw, {
		USE_PROFILES: { html: true },
		ALLOW_DATA_ATTR: false,
		ADD_ATTR: ['target', 'rel'],
	});
}
