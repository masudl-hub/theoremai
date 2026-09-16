import { useLayoutEffect, useRef } from 'react';
import { renderChatMarkdown } from '../client/chat-markdown';

export type MarkdownBodyProps = {
	text: string;
	streaming?: boolean;
	className?: string;
};

export function MarkdownBody({ text, streaming = false, className }: MarkdownBodyProps) {
	const html = renderChatMarkdown(text);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const classes = ['iface-md', streaming ? 'iface-md--streaming' : '', className ?? '']
		.filter(Boolean)
		.join(' ');

	useLayoutEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		// HTML is sanitized in renderChatMarkdown (DOMPurify).
		host.innerHTML = html;
	}, [html]);

	return <div ref={hostRef} className={classes} />;
}
