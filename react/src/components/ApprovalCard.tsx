import { useState } from 'react';
import type { ToolGate } from 'theorum/kernel';
import '../styles/renderable-card.css';

export type ApprovalCardProps = {
	gate: ToolGate;
	toolName: string;
	/** Tool call arguments for display. */
	input?: unknown;
	onDecision?: (action: 'allow' | 'allow_session' | 'deny') => void;
	/** @deprecated Use `gate`. */
	pause?: ToolGate & { input?: unknown };
};

function formatUnknownDisplay(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	if (value === undefined || value === null) return '';
	return JSON.stringify(value, null, 2);
}

export function ApprovalCard({
	gate: gateProp,
	toolName,
	input,
	onDecision,
	pause,
}: ApprovalCardProps) {
	const gate = gateProp ?? pause;
	if (!gate) {
		throw new Error('ApprovalCard requires gate');
	}
	const accessKind = gate.permission ?? 'session_consent';
	const inputFormatted = formatUnknownDisplay(input ?? pause?.input);

	const [decided, setDecided] = useState<'allowed' | 'allowed_session' | 'denied' | null>(null);

	function handleAction(action: 'allow' | 'allow_session' | 'deny') {
		if (action === 'allow') setDecided('allowed');
		else if (action === 'allow_session') setDecided('allowed_session');
		else setDecided('denied');
		onDecision?.(action);
	}

	const cardClass =
		decided !== null
			? 'renderable-card approval-card approval-card--decided'
			: 'renderable-card approval-card';

	return (
		<article className={cardClass}>
			<header className="card-header">
				<div className="card-title-group">
					<span className="card-badge card-badge--shield">Approval required</span>
					<h4 className="card-title">
						Tool: <code>{toolName}</code>
					</h4>
				</div>
				<span className="card-badge card-badge--tier">{accessKind}</span>
			</header>

			{gate.summary ? <p className="card-summary">{gate.summary}</p> : null}

			<details className="card-details">
				<summary className="details-toggle">View Input Arguments</summary>
				<pre className="card-code">{inputFormatted}</pre>
			</details>

			<footer className="card-footer">
				{decided === null ? (
					<div className="action-buttons">
						<button
							className="btn-action btn-action--deny"
							onClick={() => {
								handleAction('deny');
							}}
							type="button"
						>
							Deny
						</button>
						<button
							className="btn-action btn-action--allow"
							onClick={() => {
								handleAction('allow');
							}}
							type="button"
						>
							Approve
						</button>
						<button
							className="btn-action btn-action--always"
							onClick={() => {
								handleAction('allow_session');
							}}
							type="button"
						>
							Always Allow this Session
						</button>
					</div>
				) : (
					<div
						className={
							decided === 'denied'
								? 'decision-outcome decision-outcome--denied'
								: 'decision-outcome'
						}
					>
						{decided === 'denied' ? (
							<span>✗ Execution Denied</span>
						) : decided === 'allowed_session' ? (
							<span>✓ Approved for entire session</span>
						) : (
							<span>✓ Approved for single execution</span>
						)}
					</div>
				)}
			</footer>
		</article>
	);
}
