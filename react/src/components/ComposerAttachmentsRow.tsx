import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { createPortal } from 'react-dom';
import type { AttachPreviewStyle } from '../client/attachment-hover-preview';
import {
	formatAttachmentSize,
	resolveAttachPreviewStyle,
} from '../client/attachment-hover-preview';
import { voiceFormatLabel } from '../client/voice-label';
import { InkWaveform } from './InkWaveform';
import { VoiceNotePill } from './VoiceNotePill';

export type ComposerAttachmentItem = {
	id: string;
	kind: 'file' | 'voice';
	file: File;
	/** Object URL for image / voice preview; caller owns lifecycle when provided. */
	previewUrl?: string;
};

export type ComposerAttachmentsRowProps = {
	items?: readonly ComposerAttachmentItem[];
	recording?: boolean;
	inputLevel?: number;
	onRemove?: (id: string) => void;
};

function isImage(file: File): boolean {
	return file.type.startsWith('image/');
}

function labelFor(item: ComposerAttachmentItem): string {
	if (item.kind === 'voice') return voiceFormatLabel(item.file);
	return item.file.name;
}

function mimeLabel(item: ComposerAttachmentItem): string {
	if (item.file.type) return item.file.type;
	if (item.kind === 'voice') return 'audio';
	return isImage(item.file) ? 'image' : 'file';
}

function applyPreviewBox(node: HTMLElement, style: AttachPreviewStyle) {
	node.style.left = `${String(style.left)}px`;
	node.style.top = style.top !== undefined ? `${String(style.top)}px` : '';
	node.style.bottom = style.bottom !== undefined ? `${String(style.bottom)}px` : '';
}

function useAttachmentHoverPreview(items: readonly ComposerAttachmentItem[]) {
	const [hoverId, setHoverId] = useState<string | null>(null);
	const hoverIdRef = useRef<string | null>(null);
	const hoverElRef = useRef<HTMLElement | null>(null);
	const previewElRef = useRef<HTMLDivElement | null>(null);
	const [previewStyle, setPreviewStyle] = useState<AttachPreviewStyle | null>(null);

	hoverIdRef.current = hoverId;

	const hoverItem = hoverId ? (items.find((item) => item.id === hoverId) ?? null) : null;

	const syncPreviewPosition = useCallback(() => {
		if (!hoverElRef.current) {
			setPreviewStyle(null);
			return;
		}
		setPreviewStyle(resolveAttachPreviewStyle(hoverElRef.current.getBoundingClientRect()));
	}, []);

	function openPreview(id: string, el: HTMLElement) {
		setHoverId(id);
		hoverElRef.current = el;
		setPreviewStyle(resolveAttachPreviewStyle(el.getBoundingClientRect()));
	}

	function closePreview(id: string) {
		if (hoverIdRef.current !== id) return;
		setHoverId(null);
		hoverElRef.current = null;
		setPreviewStyle(null);
	}

	useEffect(() => {
		if (hoverId && !items.some((item) => item.id === hoverId)) {
			setHoverId(null);
			hoverElRef.current = null;
			setPreviewStyle(null);
		}
	}, [hoverId, items]);

	useEffect(() => {
		if (!hoverId) return;
		const onChange = () => {
			syncPreviewPosition();
		};
		globalThis.addEventListener('resize', onChange);
		globalThis.addEventListener('scroll', onChange, { capture: true });
		return () => {
			globalThis.removeEventListener('resize', onChange);
			globalThis.removeEventListener('scroll', onChange, { capture: true });
		};
	}, [hoverId, syncPreviewPosition]);

	useEffect(() => {
		if (!previewElRef.current || !previewStyle) return;
		applyPreviewBox(previewElRef.current, previewStyle);
	}, [previewStyle]);

	return {
		hoverItem,
		previewStyle,
		previewElRef,
		openPreview,
		closePreview,
	};
}

function VoiceAttachmentItem({
	item,
	onRemove,
}: {
	item: ComposerAttachmentItem;
	onRemove?: (id: string) => void;
}) {
	const label = labelFor(item);
	return (
		<div className="iface-attach-voice" role="group" aria-label={label}>
			<VoiceNotePill
				label={label}
				mimeType={item.file.type || 'audio/webm'}
				src={item.previewUrl ?? ''}
			/>
			<button
				className="iface-attach-pill__remove"
				aria-label={`Remove ${label}`}
				onClick={() => onRemove?.(item.id)}
				type="button"
			>
				×
			</button>
		</div>
	);
}

function PillContent({
	item,
	recording,
	inputLevel,
}: {
	item: ComposerAttachmentItem;
	recording: boolean;
	inputLevel: number;
}) {
	const label = labelFor(item);
	if (item.kind === 'voice') {
		return (
			<div className="iface-attach-pill__wave" aria-hidden="true">
				<InkWaveform
					frozen={!recording}
					inputLevel={inputLevel}
					outputLevel={0}
					status={recording ? 'listening' : 'ready'}
					variant="pill"
				/>
			</div>
		);
	}
	if (item.previewUrl && isImage(item.file)) {
		return (
			<>
				<img alt="" className="iface-attach-pill__thumb" draggable={false} src={item.previewUrl} />
				<span className="iface-attach-pill__label" title={label}>
					{label}
				</span>
			</>
		);
	}
	return (
		<span className="iface-attach-pill__label" title={label}>
			{label}
		</span>
	);
}

function PillAttachmentItem({
	item,
	recording,
	inputLevel,
	onRemove,
	onOpenPreview,
	onClosePreview,
}: {
	item: ComposerAttachmentItem;
	recording: boolean;
	inputLevel: number;
	onRemove?: (id: string) => void;
	onOpenPreview: (id: string, el: HTMLElement) => void;
	onClosePreview: (id: string) => void;
}) {
	const label = labelFor(item);
	const pillClass = [
		'iface-attach-pill',
		item.kind === 'voice' ? 'iface-attach-pill--voice' : '',
		item.kind === 'file' && isImage(item.file) ? 'iface-attach-pill--image' : '',
	]
		.filter(Boolean)
		.join(' ');

	return (
		<div
			className={pillClass}
			role="group"
			aria-label={label}
			onPointerEnter={(event) => {
				onOpenPreview(item.id, event.currentTarget);
			}}
			onPointerLeave={() => {
				onClosePreview(item.id);
			}}
		>
			<PillContent item={item} recording={recording} inputLevel={inputLevel} />
			<button
				className="iface-attach-pill__remove"
				aria-label={`Remove ${label}`}
				disabled={recording && item.kind === 'voice'}
				onClick={() => onRemove?.(item.id)}
				type="button"
			>
				×
			</button>
		</div>
	);
}

function AttachmentPreviewPortal({
	hoverItem,
	previewStyle,
	previewElRef,
}: {
	hoverItem: ComposerAttachmentItem | null;
	previewStyle: AttachPreviewStyle | null;
	previewElRef: React.RefObject<HTMLDivElement | null>;
}) {
	if (!hoverItem || !previewStyle) return null;
	return createPortal(
		<div ref={previewElRef} className="iface-attach-preview" role="tooltip">
			{hoverItem.previewUrl && isImage(hoverItem.file) ? (
				<div className="iface-attach-preview__media">
					<img alt={hoverItem.file.name} src={hoverItem.previewUrl} />
				</div>
			) : null}
			<div className="iface-attach-preview__meta">
				<span className="iface-attach-preview__name" title={labelFor(hoverItem)}>
					{labelFor(hoverItem)}
				</span>
				<div className="iface-attach-preview__row">
					<span className="iface-attach-preview__mime">{mimeLabel(hoverItem)}</span>
					{formatAttachmentSize(hoverItem.file.size) ? (
						<span className="iface-attach-preview__size">
							{formatAttachmentSize(hoverItem.file.size)}
						</span>
					) : null}
				</div>
			</div>
		</div>,
		document.body,
	);
}

export function ComposerAttachmentsRow({
	items = [],
	recording = false,
	inputLevel = 0,
	onRemove,
}: ComposerAttachmentsRowProps) {
	const showRecordingPill = recording && !items.some((item) => item.kind === 'voice');
	const visible = items.length > 0 || showRecordingPill;
	const rowRef = useRef<HTMLDivElement | null>(null);

	const { hoverItem, previewStyle, previewElRef, openPreview, closePreview } =
		useAttachmentHoverPreview(items);

	// Keep the live recording pill in view when the row already has file pills.
	useLayoutEffect(() => {
		if (!showRecordingPill) return;
		const row = rowRef.current;
		if (!row) return;
		row.scrollLeft = row.scrollWidth;
	}, [showRecordingPill, items.length]);

	if (!visible) return null;

	return (
		<>
			<div ref={rowRef} className="iface-attach-row" aria-label="Pending attachments">
				{items.map((item) =>
					item.kind === 'voice' && item.previewUrl && !recording ? (
						<VoiceAttachmentItem key={item.id} item={item} onRemove={onRemove} />
					) : (
						<PillAttachmentItem
							key={item.id}
							item={item}
							recording={recording}
							inputLevel={inputLevel}
							onRemove={onRemove}
							onOpenPreview={openPreview}
							onClosePreview={closePreview}
						/>
					),
				)}

				{showRecordingPill ? (
					<div className="iface-attach-pill iface-attach-pill--voice iface-attach-pill--recording">
						<div className="iface-attach-pill__wave" aria-hidden="true">
							<InkWaveform
								frozen={false}
								inputLevel={inputLevel}
								outputLevel={0}
								status="listening"
								variant="pill"
							/>
						</div>
						<button
							className="iface-attach-pill__remove"
							aria-label="Cancel recording"
							onClick={() => onRemove?.('__recording__')}
							type="button"
						>
							×
						</button>
					</div>
				) : null}
			</div>

			<AttachmentPreviewPortal
				hoverItem={hoverItem}
				previewStyle={previewStyle}
				previewElRef={previewElRef}
			/>
		</>
	);
}
