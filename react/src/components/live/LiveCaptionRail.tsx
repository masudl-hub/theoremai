import { useEffect, useRef } from 'react';
import type { CaptionFocus } from '../../client/live/caption-focus';
import type { LiveCaptionTurn } from '../../client/live/live-captions';
import { resolveScrollToBottomScrollTop } from '../../client/transcript-scroll';

export type LiveCaptionRailProps = {
	handle: string;
	turns?: LiveCaptionTurn[];
	interimUser?: string;
	interimAgent?: string;
	focus?: CaptionFocus;
	onFocusChange?: (focus: CaptionFocus) => void;
};

function roleLabel(role: LiveCaptionTurn['role'], handleLabel: string): string {
	return role === 'user' ? 'you' : handleLabel;
}

function stickCaptionsToBottom(el: HTMLElement): void {
	el.scrollTop = resolveScrollToBottomScrollTop({
		scrollHeight: el.scrollHeight,
		clientHeight: el.clientHeight,
	});
}

function useCaptionsFollowTail(
	captionsEl: React.RefObject<HTMLElement | null>,
	railEl: React.RefObject<HTMLDivElement | null>,
	scrollKey: string,
	visible: boolean,
) {
	useEffect(() => {
		const el = captionsEl.current;
		if (!el || !visible) return;

		const stick = () => {
			stickCaptionsToBottom(el);
		};
		stick();
		const frame = requestAnimationFrame(stick);

		const ro = new ResizeObserver(() => {
			stick();
		});
		ro.observe(el);
		const rail = railEl.current;
		if (rail) ro.observe(rail);

		return () => {
			cancelAnimationFrame(frame);
			ro.disconnect();
		};
	}, [captionsEl, railEl, scrollKey, visible]);
}

function CaptionTurnButton({
	turn,
	index,
	total,
	focus,
	handleLabel,
	onFocusChange,
}: {
	turn: LiveCaptionTurn;
	index: number;
	total: number;
	focus: CaptionFocus;
	handleLabel: string;
	onFocusChange?: (focus: CaptionFocus) => void;
}) {
	const lineClass = [
		'live-captions__line',
		turn.role === 'user' ? 'live-captions__line--user' : 'live-captions__line--agent',
		focus === turn.id ? 'live-captions__line--focused' : '',
		index === total - 1 ? 'live-captions__line--latest' : '',
	]
		.filter(Boolean)
		.join(' ');

	return (
		<button
			type="button"
			className={lineClass}
			onClick={() => onFocusChange?.(focus === turn.id ? null : turn.id)}
		>
			<span className="live-captions__role">{roleLabel(turn.role, handleLabel)}</span>
			<span className="live-captions__text">{turn.text}</span>
		</button>
	);
}

function InterimCaptionLine({
	role,
	text,
	handleLabel,
}: {
	role: 'user' | 'agent';
	text: string;
	handleLabel: string;
}) {
	if (!text) return null;
	const isUser = role === 'user';
	return (
		<div
			className={`live-captions__line ${
				isUser ? 'live-captions__line--user' : 'live-captions__line--agent'
			} live-captions__line--interim`}
		>
			<span className="live-captions__role">{isUser ? 'you' : handleLabel}</span>
			<span className="live-captions__text">{text}</span>
		</div>
	);
}

function hasCaptions(turns: LiveCaptionTurn[], interimUser: string, interimAgent: string): boolean {
	return turns.length > 0 || interimUser.length > 0 || interimAgent.length > 0;
}

function resolveCaptionsScrollKey(turns: LiveCaptionTurn[], interimUser: string, interimAgent: string): string {
	const lastTurn = turns.at(-1);
	return `${String(turns.length)}:${lastTurn?.id ?? ''}:${lastTurn?.text ?? ''}:${interimUser}:${interimAgent}`;
}

export function LiveCaptionRail({
	handle,
	turns = [],
	interimUser = '',
	interimAgent = '',
	focus = null,
	onFocusChange,
}: LiveCaptionRailProps) {
	const handleLabel = `@${handle}`;
	const visible = hasCaptions(turns, interimUser, interimAgent);
	const captionsEl = useRef<HTMLElement | null>(null);
	const railEl = useRef<HTMLDivElement | null>(null);
	const scrollKey = resolveCaptionsScrollKey(turns, interimUser, interimAgent);

	useCaptionsFollowTail(captionsEl, railEl, scrollKey, visible);

	if (!visible) return null;

	return (
		<aside ref={captionsEl} className="live-captions" aria-live="polite">
			<div ref={railEl} className="live-captions__rail">
				{turns.map((turn, index) => (
					<CaptionTurnButton
						key={turn.id}
						turn={turn}
						index={index}
						total={turns.length}
						focus={focus}
						handleLabel={handleLabel}
						onFocusChange={onFocusChange}
					/>
				))}
				<InterimCaptionLine role="user" text={interimUser} handleLabel={handleLabel} />
				<InterimCaptionLine role="agent" text={interimAgent} handleLabel={handleLabel} />
			</div>
		</aside>
	);
}
