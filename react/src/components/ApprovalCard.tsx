import { useState } from 'react';
import type { ToolPause } from 'theorum/kernel';
import '../styles/renderable-card.css';

export type ApprovalCardProps = {
	pause: ToolPause;
	toolName: string;
	onDecision?: (action: 'allow' | 'allow_session' | 'deny', interactiveValue?: unknown) => void;
};

function formatUnknownDisplay(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	if (value === undefined || value === null) return '';
	return JSON.stringify(value, null, 2);
}

export function ApprovalCard({ pause, toolName, onDecision }: ApprovalCardProps) {
	const accessKind = pause.permission ?? 'session_consent';
	const isInteractive = pause.kind === 'interactive';
	const interactiveOptions = pause.render?.options ?? [];
	const interactiveKind = isInteractive
		? (pause.render?.kind ?? (interactiveOptions.length > 0 ? 'choice' : 'text'))
		: null;
	const inputFormatted = formatUnknownDisplay(pause.input);

	const [decided, setDecided] = useState<'allowed' | 'allowed_session' | 'denied' | null>(null);
	const [selectedOption, setSelectedOption] = useState<string | null>(null);
	const [textDraft, setTextDraft] = useState('');
	const [submittedValue, setSubmittedValue] = useState<unknown>(undefined);

	function handleAction(action: 'allow' | 'allow_session' | 'deny', interactiveValue?: unknown) {
		if (action === 'allow') setDecided('allowed');
		else if (action === 'allow_session') setDecided('allowed_session');
		else setDecided('denied');

		if (interactiveValue !== undefined) {
			setSubmittedValue(interactiveValue);
		}

		onDecision?.(action, interactiveValue);
	}

	function chooseInteractive(option: string) {
		setSelectedOption(option);
		handleAction('allow', option);
	}

	function submitText() {
		const trimmed = textDraft.trim();
		if (!trimmed) return;
		handleAction('allow', trimmed);
	}

	const cardClass =
		decided !== null
			? 'renderable-card approval-card approval-card--decided'
			: 'renderable-card approval-card';

	const badgeClass = [
		'card-badge',
		isInteractive ? 'card-badge--interactive' : 'card-badge--shield',
	].join(' ');

	return (
		<article className={cardClass}>
			<header className="card-header">
				<div className="card-title-group">
					<span className={badgeClass}>
						{isInteractive ? 'Response required' : 'Approval required'}
					</span>
					<h4 className="card-title">
						{isInteractive ? 'Input' : 'Tool'}: <code>{toolName}</code>
					</h4>
				</div>
				{!isInteractive ? <span className="card-badge card-badge--tier">{accessKind}</span> : null}
			</header>

			{pause.summary ? <p className="card-summary">{pause.summary}</p> : null}

			{pause.render ? (
				<div className="card-interactive-view">
					<p className="interactive-prompt">{pause.render.prompt}</p>
					{interactiveKind === 'choice' && interactiveOptions.length ? (
						<div className="interactive-options">
							{interactiveOptions.map((opt) => (
								<button
									key={opt}
									className={
										selectedOption === opt
											? 'interactive-option-pill interactive-option-pill--selected'
											: 'interactive-option-pill'
									}
									disabled={decided !== null}
									onClick={() => {
										chooseInteractive(opt);
									}}
									type="button"
								>
									{opt}
								</button>
							))}
						</div>
					) : interactiveKind === 'text' ? (
						<label className="interactive-text-field">
							<span className="interactive-text-label">Your answer</span>
							<input
								value={textDraft}
								onChange={(event) => {
									setTextDraft(event.currentTarget.value);
								}}
								className="interactive-text-input"
								disabled={decided !== null}
								onKeyDown={(event) => {
									if (event.key === 'Enter') submitText();
								}}
								placeholder="Type your response"
								type="text"
							/>
						</label>
					) : null}
				</div>
			) : null}

			<details className="card-details">
				<summary className="details-toggle">View Input Arguments</summary>
				<pre className="card-code">{inputFormatted}</pre>
			</details>

			<footer className="card-footer">
				{decided === null ? (
					<div className="action-buttons">
						{isInteractive && interactiveKind === 'confirm' ? (
							<>
								<button
									className="btn-action btn-action--deny"
									onClick={() => {
										handleAction('deny');
									}}
									type="button"
								>
									Cancel
								</button>
								<button
									className="btn-action btn-action--allow"
									onClick={() => {
										handleAction('allow', true);
									}}
									type="button"
								>
									Confirm
								</button>
							</>
						) : (
							<>
								{!isInteractive ||
								interactiveKind !== 'choice' ||
								interactiveOptions.length === 0 ? (
									<button
										className="btn-action btn-action--deny"
										onClick={() => {
											handleAction('deny');
										}}
										type="button"
									>
										{isInteractive ? 'Cancel' : 'Deny'}
									</button>
								) : null}
								{interactiveKind === 'text' ? (
									<button
										className="btn-action btn-action--allow"
										disabled={!textDraft.trim()}
										onClick={submitText}
										type="button"
									>
										Submit
									</button>
								) : !isInteractive ||
									(interactiveKind !== 'choice' && interactiveKind !== 'confirm') ? (
									<button
										className="btn-action btn-action--allow"
										onClick={() => {
											handleAction('allow');
										}}
										type="button"
									>
										Approve
									</button>
								) : interactiveKind === 'choice' ? (
									<button
										className="btn-action btn-action--deny"
										onClick={() => {
											handleAction('deny');
										}}
										type="button"
									>
										Cancel
									</button>
								) : null}
								{!isInteractive ? (
									<button
										className="btn-action btn-action--always"
										onClick={() => {
											handleAction('allow_session');
										}}
										type="button"
									>
										Always Allow this Session
									</button>
								) : null}
							</>
						)}
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
							<span>✗ {isInteractive ? 'Cancelled' : 'Execution Denied'}</span>
						) : decided === 'allowed_session' ? (
							<span>✓ Approved for entire session</span>
						) : submittedValue !== undefined ? (
							<span>✓ {formatUnknownDisplay(submittedValue)}</span>
						) : (
							<span>✓ Approved for single execution</span>
						)}
					</div>
				)}
			</footer>
		</article>
	);
}
