import type { ToolCredential, ToolGate } from 'theorum/kernel';
import { useState } from 'react';
import '../styles/renderable-card.css';

export type AuthChallengeCardProps = {
	gate: ToolGate;
	toolName: string;
	onSubmitCredential?: (slot: string, credential: ToolCredential) => void;
};

type ResolvedChallenge = {
	authType: string;
	slot: string;
	authUrl: string | undefined;
	message: string;
	resource: string | undefined;
	scopes: readonly string[] | undefined;
};

const DEFAULT_CHALLENGE: ResolvedChallenge = {
	authType: 'bearer',
	slot: 'default',
	authUrl: undefined,
	message: 'This tool requires valid authentication credentials to proceed.',
	resource: undefined,
	scopes: undefined,
};

function resolveChallenge(gate: ToolGate): ResolvedChallenge {
	const challenge = gate.authChallenge;
	if (!challenge) return DEFAULT_CHALLENGE;
	return {
		authType: challenge.authType || DEFAULT_CHALLENGE.authType,
		slot: challenge.slot || DEFAULT_CHALLENGE.slot,
		authUrl: challenge.authorizationUrl,
		message: challenge.message || DEFAULT_CHALLENGE.message,
		resource: challenge.resource,
		scopes: challenge.requiredScopes,
	};
}

function credentialFromSecret(authType: string, secret: string): ToolCredential {
	if (authType === 'api_key') return { type: 'api_key', key: secret };
	return { type: 'bearer', token: secret };
}

function AuthMeta(props: { resource?: string; scopes?: readonly string[] }) {
	if (!props.resource && !props.scopes?.length) return null;
	return (
		<>
			{props.resource ? (
				<div className="card-meta-row">
					<span className="meta-label">Resource:</span>
					<span className="meta-val">{props.resource}</span>
				</div>
			) : null}
			{props.scopes?.length ? (
				<div className="card-meta-row">
					<span className="meta-label">Scopes:</span>
					<div className="meta-scopes">
						{props.scopes.map((scope) => (
							<span key={scope} className="scope-pill">
								{scope}
							</span>
						))}
					</div>
				</div>
			) : null}
		</>
	);
}

function OAuthAction(props: { authUrl?: string; onAuthorize: () => void }) {
	if (!props.authUrl) {
		return <p className="oauth-desc">OAuth 2.1 authorization endpoint not pre-configured.</p>;
	}
	return (
		<div className="oauth-prompt">
			<p className="oauth-desc">Authorize this tool via your identity provider using PKCE:</p>
			<button className="btn-oauth" onClick={props.onAuthorize} type="button">
				Authorize with Provider ↗
			</button>
		</div>
	);
}

function SecretForm(props: {
	authType: string;
	slot: string;
	secretInput: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
}) {
	const label = props.authType === 'api_key' ? 'API Key' : 'Bearer Token';
	return (
		<div className="credential-input-form">
			<label className="cred-label">
				<span>Provide {label}:</span>
				<input
					className="cred-input"
					autoComplete="off"
					value={props.secretInput}
					onChange={(event) => {
						props.onChange(event.currentTarget.value);
					}}
					placeholder={`Enter secret for slot '${props.slot}'`}
					type="password"
				/>
			</label>
			<button
				className="btn-submit-cred"
				disabled={!props.secretInput.trim()}
				onClick={props.onSubmit}
				type="button"
			>
				Submit & Continue
			</button>
		</div>
	);
}

function SubmittedNotice(props: { slot: string }) {
	return (
		<div className="submitted-notice">
			<span>
				✓ Credential provided for slot: <code>{props.slot}</code>
			</span>
		</div>
	);
}

function AuthActionArea(props: {
	authType: string;
	slot: string;
	authUrl?: string;
	submitted: boolean;
	secretInput: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	onAuthorize: () => void;
}) {
	if (props.authType === 'oauth2') {
		return <OAuthAction authUrl={props.authUrl} onAuthorize={props.onAuthorize} />;
	}
	if (props.submitted) return <SubmittedNotice slot={props.slot} />;
	return (
		<SecretForm
			authType={props.authType}
			slot={props.slot}
			secretInput={props.secretInput}
			onChange={props.onChange}
			onSubmit={props.onSubmit}
		/>
	);
}

function AuthCardHeader(props: { toolName: string; authType: string }) {
	return (
		<header className="card-header">
			<div className="card-title-group">
				<span className="card-badge card-badge--auth">Auth challenge</span>
				<h4 className="card-title">
					Authentication: <code>{props.toolName}</code>
				</h4>
			</div>
			<span className="card-badge card-badge--type">{props.authType}</span>
		</header>
	);
}

function authCardClass(submitted: boolean): string {
	return submitted
		? 'renderable-card auth-card auth-card--submitted'
		: 'renderable-card auth-card';
}

export function AuthChallengeCard({
	gate,
	toolName,
	onSubmitCredential,
}: AuthChallengeCardProps) {
	const challenge = resolveChallenge(gate);
	const [secretInput, setSecretInput] = useState('');
	const [submitted, setSubmitted] = useState(false);

	function handleSubmit() {
		const secret = secretInput.trim();
		if (!secret) return;
		setSubmitted(true);
		onSubmitCredential?.(challenge.slot, credentialFromSecret(challenge.authType, secret));
	}

	return (
		<article className={authCardClass(submitted)}>
			<AuthCardHeader toolName={toolName} authType={challenge.authType} />
			<p className="card-summary">{challenge.message}</p>
			<AuthMeta resource={challenge.resource} scopes={challenge.scopes} />
			<div className="auth-action-area">
				<AuthActionArea
					authType={challenge.authType}
					slot={challenge.slot}
					authUrl={challenge.authUrl}
					submitted={submitted}
					secretInput={secretInput}
					onChange={setSecretInput}
					onSubmit={handleSubmit}
					onAuthorize={() => {
						if (challenge.authUrl) {
							globalThis.open(challenge.authUrl, '_blank', 'width=600,height=700');
						}
					}}
				/>
			</div>
		</article>
	);
}
