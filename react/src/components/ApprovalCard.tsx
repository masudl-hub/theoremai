import { useState } from 'react';
import type { ToolGate } from '../../../src/kernel/mod.ts';
import '../styles/renderable-card.css';

export type ApprovalCardProps = {
	gate: ToolGate;
	toolName: string;
	/** Tool call arguments for display. */
	input?: unknown;
	onDecision?: (action: 'allow' | 'allow_session' | 'deny') => void;
};

type Decision = 'allowed' | 'allowed_session' | 'denied';

function formatUnknownDisplay(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	if (value === undefined || value === null) return '';
	return JSON.stringify(value, null, 2);
}

function decisionFromAction(action: 'allow' | 'allow_session' | 'deny'): Decision {
	if (action === 'allow') return 'allowed';
	if (action === 'allow_session') return 'allowed_session';
	return 'denied';
}

function DecisionOutcome(props: { decided: Decision }) {
	if (props.decided === 'denied') {
		return (
			<div className="decision-outcome decision-outcome--denied">
				<span>✗ Execution Denied</span>
			</div>
		);
	}
	const label =
		props.decided === 'allowed_session'
			? '✓ Approved for entire session'
			: '✓ Approved for single execution';
	return (
		<div className="decision-outcome">
			<span>{label}</span>
		</div>
	);
}

function ActionButtons(props: { onAction: (action: 'allow' | 'allow_session' | 'deny') => void }) {
	return (
		<div className="action-buttons">
			<button
				className="btn-action btn-action--deny"
				onClick={() => {
					props.onAction('deny');
				}}
				type="button"
			>
				Deny
			</button>
			<button
				className="btn-action btn-action--allow"
				onClick={() => {
					props.onAction('allow');
				}}
				type="button"
			>
				Approve
			</button>
			<button
				className="btn-action btn-action--always"
				onClick={() => {
					props.onAction('allow_session');
				}}
				type="button"
			>
				Always Allow this Session
			</button>
		</div>
	);
}

export function ApprovalCard({ gate, toolName, input, onDecision }: ApprovalCardProps) {
	const accessKind = gate.permission ?? 'session_consent';
	const [decided, setDecided] = useState<Decision | null>(null);

	function handleAction(action: 'allow' | 'allow_session' | 'deny') {
		setDecided(decisionFromAction(action));
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
				<pre className="card-code">{formatUnknownDisplay(input)}</pre>
			</details>

			<footer className="card-footer">
				{decided === null ? (
					<ActionButtons onAction={handleAction} />
				) : (
					<DecisionOutcome decided={decided} />
				)}
			</footer>
		</article>
	);
}
