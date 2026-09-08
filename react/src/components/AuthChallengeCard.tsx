import { useState } from 'react';
import type { ToolCredential, ToolPause } from 'theorum/kernel';
import '../styles/renderable-card.css';

export type AuthChallengeCardProps = {
	pause: ToolPause;
	toolName: string;
	onSubmitCredential?: (slot: string, credential: ToolCredential) => void;
};

export function AuthChallengeCard({ pause, toolName, onSubmitCredential }: AuthChallengeCardProps) {
	const challenge = pause.authChallenge;
	const authType = challenge?.authType ?? 'bearer';
	const slot = challenge?.slot ?? 'default';
	const authUrl = challenge?.authorizationUrl;

	const [secretInput, setSecretInput] = useState('');
	const [submitted, setSubmitted] = useState(false);

	function handleSubmit() {
		if (!secretInput.trim()) return;
		setSubmitted(true);
		if (authType === 'api_key') {
			onSubmitCredential?.(slot, { type: 'api_key', key: secretInput.trim() });
		} else {
			onSubmitCredential?.(slot, { type: 'bearer', token: secretInput.trim() });
		}
	}

	function handleOAuthAuthorize() {
		if (authUrl) {
			window.open(authUrl, '_blank', 'width=600,height=700');
		}
	}

	const cardClass = submitted
		? 'renderable-card auth-card auth-card--submitted'
		: 'renderable-card auth-card';

	return (
		<article className={cardClass}>
			<header className="card-header">
				<div className="card-title-group">
					<span className="card-badge card-badge--auth">Auth challenge</span>
					<h4 className="card-title">
						Authentication: <code>{toolName}</code>
					</h4>
				</div>
				<span className="card-badge card-badge--type">{authType}</span>
			</header>

			<p className="card-summary">
				{challenge?.message ?? 'This tool requires valid authentication credentials to proceed.'}
			</p>

			{challenge?.resource ? (
				<div className="card-meta-row">
					<span className="meta-label">Resource:</span>
					<span className="meta-val">{challenge.resource}</span>
				</div>
			) : null}

			{challenge?.requiredScopes?.length ? (
				<div className="card-meta-row">
					<span className="meta-label">Scopes:</span>
					<div className="meta-scopes">
						{challenge.requiredScopes.map((scope) => (
							<span key={scope} className="scope-pill">
								{scope}
							</span>
						))}
					</div>
				</div>
			) : null}

			<div className="auth-action-area">
				{authType === 'oauth2' ? (
					authUrl ? (
						<div className="oauth-prompt">
							<p className="oauth-desc">
								Authorize this tool via your identity provider using PKCE:
							</p>
							<button className="btn-oauth" onClick={handleOAuthAuthorize} type="button">
								Authorize with Provider ↗
							</button>
						</div>
					) : (
						<p className="oauth-desc">OAuth 2.1 authorization endpoint not pre-configured.</p>
					)
				) : !submitted ? (
					<div className="credential-input-form">
						<label className="cred-label">
							<span>Provide {authType === 'api_key' ? 'API Key' : 'Bearer Token'}:</span>
							<input
								className="cred-input"
								autoComplete="off"
								value={secretInput}
								onChange={(event) => {
									setSecretInput(event.currentTarget.value);
								}}
								placeholder={`Enter secret for slot '${slot}'`}
								type="password"
							/>
						</label>
						<button
							className="btn-submit-cred"
							disabled={!secretInput.trim()}
							onClick={handleSubmit}
							type="button"
						>
							Submit & Continue
						</button>
					</div>
				) : (
					<div className="submitted-notice">
						<span>
							✓ Credential provided for slot: <code>{slot}</code>
						</span>
					</div>
				)}
			</div>
		</article>
	);
}
