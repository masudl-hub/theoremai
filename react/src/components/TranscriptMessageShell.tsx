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

function useMessageRelativeTime(at?: number) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (at == null) return;
		let timeoutId: number | undefined;
		let cancelled = false;

		const schedule = () => {
			if (cancelled) return;
			timeoutId = globalThis.setTimeout(() => {
				setNow(Date.now());
				schedule();
			}, msUntilRelativeTimeChange(at));
		};

		setNow(Date.now());
		schedule();

		return () => {
			cancelled = true;
			if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
		};
	}, [at]);
	return now;
}

function MessageCopyButton({ copyText }: { copyText: string }) {
	const [copied, setCopied] = useState(false);
	if (!copyText.trim()) return null;

	async function copy() {
		await navigator.clipboard.writeText(copyText);
		setCopied(true);
		globalThis.setTimeout(() => {
			setCopied(false);
		}, 1500);
	}

	return (
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
	);
}

function MessageTimeLabel({ at, now }: { at?: number; now: number }) {
	if (at == null) return null;
	const timeLabel = formatRelativeTime(at, now);
	return (
		<time className="iface-msg__chrome-time" dateTime={new Date(at).toISOString()}>
			{timeLabel}
		</time>
	);
}

function MessageBranchButton({ onBranch }: { onBranch?: () => void }) {
	if (!onBranch) return null;
	return (
		<button
			type="button"
			className="iface-msg__chrome-btn"
			aria-label="Branch"
			title="Branch"
			onClick={onBranch}
		>
			<IconGitBranch size={12} stroke={1.9} aria-hidden="true" />
		</button>
	);
}

function MessageChrome({
	at,
	now,
	copyText,
	onBranch,
	showChrome,
}: {
	at?: number;
	now: number;
	copyText: string;
	onBranch?: () => void;
	showChrome: boolean;
}) {
	if (!showChrome) return null;
	const hasContent = at != null || copyText.trim().length > 0 || onBranch != null;
	if (!hasContent) return null;

	return (
		<div className="iface-msg__chrome">
			<MessageTimeLabel at={at} now={now} />
			<MessageCopyButton copyText={copyText} />
			<MessageBranchButton onBranch={onBranch} />
		</div>
	);
}

export function TranscriptMessageShell({
	align = 'assistant',
	at,
	copyText,
	onBranch,
	showChrome = true,
	children,
}: TranscriptMessageShellProps) {
	const now = useMessageRelativeTime(at);
	const wrapClass = align === 'user' ? 'iface-msg-wrap iface-msg-wrap--user' : 'iface-msg-wrap';

	return (
		<div className={wrapClass}>
			{children}
			<MessageChrome
				at={at}
				now={now}
				copyText={copyText}
				onBranch={onBranch}
				showChrome={showChrome}
			/>
		</div>
	);
}
