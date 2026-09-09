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

export function LiveCaptionRail({
	handle,
	turns = [],
	interimUser = '',
	interimAgent = '',
	focus = null,
	onFocusChange,
}: LiveCaptionRailProps) {
	const handleLabel = `@${handle}`;
	const visible = turns.length > 0 || interimUser.length > 0 || interimAgent.length > 0;
	const captionsEl = useRef<HTMLElement | null>(null);
	const railEl = useRef<HTMLDivElement | null>(null);
	const scrollKey = `${String(turns.length)}:${turns.at(-1)?.id ?? ''}:${turns.at(-1)?.text ?? ''}:${interimUser}:${interimAgent}`;

	// Always follow the tail — pin on content change and while text grows in place.
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
	}, [scrollKey, visible]);

	if (!visible) return null;

	return (
		<aside ref={captionsEl} className="live-captions" aria-live="polite">
			<div ref={railEl} className="live-captions__rail">
				{turns.map((turn, index) => {
					const lineClass = [
						'live-captions__line',
						turn.role === 'user' ? 'live-captions__line--user' : 'live-captions__line--agent',
						focus === turn.id ? 'live-captions__line--focused' : '',
						index === turns.length - 1 ? 'live-captions__line--latest' : '',
					]
						.filter(Boolean)
						.join(' ');

					return (
						<button
							key={turn.id}
							type="button"
							className={lineClass}
							onClick={() => onFocusChange?.(focus === turn.id ? null : turn.id)}
						>
							<span className="live-captions__role">{roleLabel(turn.role, handleLabel)}</span>
							<span className="live-captions__text">{turn.text}</span>
						</button>
					);
				})}
				{interimUser ? (
					<div className="live-captions__line live-captions__line--user live-captions__line--interim">
						<span className="live-captions__role">you</span>
						<span className="live-captions__text">{interimUser}</span>
					</div>
				) : null}
				{interimAgent ? (
					<div className="live-captions__line live-captions__line--agent live-captions__line--interim">
						<span className="live-captions__role">{handleLabel}</span>
						<span className="live-captions__text">{interimAgent}</span>
					</div>
				) : null}
			</div>
		</aside>
	);
}
