import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
	composerShellHeight,
	measureComposerTextareaHeight,
} from '../client/composer-layout';
import type { ComposerAttachmentItem } from './ComposerAttachmentsRow';

function heightWithoutTextarea(
	inner: HTMLDivElement | null,
	attachH: number,
	isExpanded: boolean,
): number {
	if (!isExpanded) return 46;
	return (inner?.offsetHeight ?? 46) + attachH + 2;
}

function heightWithTextarea(args: {
	ta: HTMLTextAreaElement;
	inner: HTMLDivElement | null;
	attachH: number;
	isExpanded: boolean;
	maxHeight: number;
}): number {
	const { ta, inner, attachH, isExpanded, maxHeight } = args;
	if (isExpanded) ta.style.height = 'auto';
	const measured = measureComposerTextareaHeight({
		scrollHeight: isExpanded ? ta.scrollHeight : 0,
		maxHeight,
		isExpanded,
	});
	ta.style.height = `${String(measured.heightPx)}px`;
	ta.style.overflowY = measured.overflowY;
	const innerH =
		isExpanded && inner ? inner.offsetHeight + 2 : measured.contentHeightFallback;
	return innerH + attachH;
}

function measureShellContentHeight(args: {
	textarea: HTMLTextAreaElement | null;
	inner: HTMLDivElement | null;
	attachH: number;
	isExpanded: boolean;
	maxHeight: number;
}): number {
	if (!args.textarea) {
		return heightWithoutTextarea(args.inner, args.attachH, args.isExpanded);
	}
	return heightWithTextarea({
		ta: args.textarea,
		inner: args.inner,
		attachH: args.attachH,
		isExpanded: args.isExpanded,
		maxHeight: args.maxHeight,
	});
}

export function useComposerShellLayout(args: {
	text: string;
	recording: boolean;
	isExpanded: boolean;
	attachmentCount: number;
	voiceCount: number;
	attachItems: readonly ComposerAttachmentItem[];
}) {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const innerRef = useRef<HTMLDivElement | null>(null);
	const shellRef = useRef<HTMLDivElement | null>(null);
	const attachRowRef = useRef<HTMLDivElement | null>(null);
	const [maxHeight, setMaxHeight] = useState(320);
	const [contentHeight, setContentHeight] = useState(46);

	const shellHeight = composerShellHeight({
		isExpanded: args.isExpanded,
		contentHeight,
		expandedFloor:
			args.attachmentCount > 0 || args.voiceCount > 0 || args.recording ? 92 : 46,
	});

	const syncMaxHeight = useCallback(() => {
		setMaxHeight(Math.round(window.innerHeight * 0.4));
	}, []);

	const layoutEpoch = `${String(args.text.length)}:${args.recording ? '1' : '0'}:${args.attachItems.map((item) => item.id).join('|')}`;

	useLayoutEffect(() => {
		setContentHeight(
			measureShellContentHeight({
				textarea: textareaRef.current,
				inner: innerRef.current,
				attachH: attachRowRef.current?.offsetHeight ?? 0,
				isExpanded: args.isExpanded,
				maxHeight,
			}),
		);
	}, [layoutEpoch, args.isExpanded, maxHeight]);

	useLayoutEffect(() => {
		const shell = shellRef.current;
		if (!shell) return;
		shell.style.height = `${String(shellHeight)}px`;
	}, [shellHeight]);

	return {
		textareaRef,
		innerRef,
		shellRef,
		attachRowRef,
		shellHeight,
		syncMaxHeight,
	};
}

export function useComposerMenuDismiss(menuOpen: boolean, setMenuOpen: (open: boolean) => void) {
	const menuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const onPointer = (event: MouseEvent) => {
			const target = event.target;
			if (target instanceof Node && menuRef.current?.contains(target)) return;
			setMenuOpen(false);
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape') setMenuOpen(false);
		};
		document.addEventListener('mousedown', onPointer);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onPointer);
			document.removeEventListener('keydown', onKey);
		};
	}, [menuOpen, setMenuOpen]);

	return menuRef;
}
