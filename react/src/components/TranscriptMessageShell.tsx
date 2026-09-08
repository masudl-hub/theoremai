import { IconCheck, IconCopy, IconGitBranch } from '@tabler/icons-react';
import { type ReactNode, useEffect, useState } from 'react';
import { formatRelativeTime, msUntilRelativeTimeChange } from '../client/relative-time';

export type TranscriptMessageShellProps = {
	align?: 'user' | 'assistant';
	at?: number;
	copyText: string;
	onBranch?: () => void;
	showChrome?: boolean;
	children: ReactNode;
};

export function TranscriptMessageShell({
	align = 'assistant',
	at,
	copyText,
	onBranch,
	showChrome = true,
	children,
}: TranscriptMessageShellProps) {
	const [now, setNow] = useState(() => Date.now());
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (at == null) return;
		let timeoutId: number | undefined;
		let cancelled = false;

		const schedule = () => {
			if (cancelled) return;
			timeoutId = window.setTimeout(() => {
				setNow(Date.now());
				schedule();
			}, msUntilRelativeTimeChange(at));
		};

		setNow(Date.now());
		schedule();

		return () => {
			cancelled = true;
			if (timeoutId !== undefined) window.clearTimeout(timeoutId);
		};
	}, [at]);

	const timeLabel = at != null ? formatRelativeTime(at, now) : null;
	const canCopy = copyText.trim().length > 0;

	async function copy() {
		if (!canCopy) return;
		await navigator.clipboard.writeText(copyText);
		setCopied(true);
		window.setTimeout(() => {
			setCopied(false);
		}, 1500);
	}

	const wrapClass = align === 'user' ? 'iface-msg-wrap iface-msg-wrap--user' : 'iface-msg-wrap';

	return (
		<div className={wrapClass}>
			{children}
			{showChrome && (timeLabel || canCopy || onBranch) ? (
				<div className="iface-msg__chrome">
					{timeLabel && at != null ? (
						<time className="iface-msg__chrome-time" dateTime={new Date(at).toISOString()}>
							{timeLabel}
						</time>
					) : null}
					{canCopy ? (
						<button
							type="button"
							className="iface-msg__chrome-btn"
							aria-label={copied ? 'Copied' : 'Copy'}
							title={copied ? 'Copied' : 'Copy'}
							onClick={() => {
								void copy();
							}}
						>
							{copied ? (
								<IconCheck size={12} stroke={1.8} aria-hidden="true" />
							) : (
								<IconCopy size={12} stroke={1.7} aria-hidden="true" />
							)}
						</button>
					) : null}
					{onBranch ? (
						<button
							type="button"
							className="iface-msg__chrome-btn"
							aria-label="Branch"
							title="Branch"
							onClick={onBranch}
						>
							<IconGitBranch size={12} stroke={1.9} aria-hidden="true" />
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
