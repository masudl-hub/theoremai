import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { useCallback, useEffect, useState } from 'react';
import type { ToolGate } from '../../../src/kernel/mod.ts';
import { isOAuthComplete } from '../client/oauth-popup';
import type { LabelText } from './labels';
import { TheoremLabelsProvider, useLabels } from './labels-provider';

export type ToolDecision = 'allow' | 'deny';

/** What an approval means is the tool registrant's call: `session_consent` lasts the session. */
function decisionLabel(t: LabelText, decision: ToolDecision, gate: ToolGate): string {
	if (decision === 'deny') return t('@theorem.gate.approval.denied');
	return t(
		gate.permission === 'session_consent'
			? '@theorem.gate.approval.approved_session'
			: '@theorem.gate.approval.approved_once',
	);
}

function formatInput(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined || value === null) return '';
	return JSON.stringify(value, null, 2);
}

function CardHeader(props: { badge: string; title: string; toolName: string; tag: string }) {
	return (
		<HStack justify="between" align="center" gap={2}>
			<VStack gap={1}>
				<Badge variant="warning" label={props.badge} />
				<Heading level={4}>
					{props.title} <code>{props.toolName}</code>
				</Heading>
			</VStack>
			<Badge variant="neutral" label={props.tag} />
		</HStack>
	);
}

export type ApprovalCardProps = {
	gate: ToolGate;
	toolName: string;
	input?: unknown;
	onDecision?: (action: ToolDecision) => void;
};

export function ApprovalCard(props: ApprovalCardProps) {
	return (
		<TheoremLabelsProvider>
			<ApprovalBody {...props} />
		</TheoremLabelsProvider>
	);
}

function ApprovalBody({ gate, toolName, input, onDecision }: ApprovalCardProps) {
	const t = useLabels();
	const [decided, setDecided] = useState<ToolDecision | null>(null);
	const args = formatInput(input);

	function decide(action: ToolDecision) {
		setDecided(action);
		onDecision?.(action);
	}

	return (
		<Card padding={4}>
			<VStack gap={3}>
				<CardHeader
					badge={t('@theorem.gate.approval.badge')}
					title={t('@theorem.gate.approval.title')}
					toolName={toolName}
					tag={t(`@theorem.gate.tag.${gate.permission ?? gate.kind}`)}
				/>
				{gate.summary ? <Text>{gate.summary}</Text> : null}
				{args ? (
					<Collapsible trigger={<Text size="sm">{t('@theorem.gate.approval.input')}</Text>}>
						<CodeBlock code={args} language="json" size="sm" />
					</Collapsible>
				) : null}
				{decided === null ? (
					<HStack gap={2} justify="end">
						<Button label={t('@theorem.gate.approval.deny')} variant="ghost" onClick={() => decide('deny')} />
						<Button label={t('@theorem.gate.approval.approve')} variant="primary" onClick={() => decide('allow')} />
					</HStack>
				) : (
					<Badge variant={decided === 'deny' ? 'error' : 'success'} label={decisionLabel(t, decided, gate)} />
				)}
			</VStack>
		</Card>
	);
}

export type AuthChallengeCardProps = {
	gate: ToolGate;
	toolName: string;
	/**
	 * Signed in: `secret` is the key the user typed, for the server to save; after
	 * an OAuth sign-in (the popup's `notifyOAuthComplete`) there is none.
	 */
	onAuthenticated?: (secret?: string) => void;
};

type AuthChallenge = Partial<NonNullable<ToolGate['authChallenge']>>;

function AuthChallengeDetails({ challenge }: { challenge: AuthChallenge }) {
	const t = useLabels();
	return (
		<>
			<Text>{challenge.message || t('@theorem.gate.auth.message')}</Text>
			{challenge.resource ? (
				<Text size="sm" color="secondary">
					{t('@theorem.gate.auth.resource', { resource: challenge.resource })}
				</Text>
			) : null}
			{challenge.requiredScopes?.length ? (
				<HStack gap={1} wrap="wrap">
					{challenge.requiredScopes.map((scope) => (
						<Token key={scope} label={scope} size="sm" />
					))}
				</HStack>
			) : null}
		</>
	);
}

export function AuthChallengeCard(props: AuthChallengeCardProps) {
	return (
		<TheoremLabelsProvider>
			<AuthChallengeBody {...props} />
		</TheoremLabelsProvider>
	);
}

/** Wait for the sign-in popup to report its slot signed in. */
function useOAuthPopup(slot: string, onComplete: () => void): (url: string) => void {
	const [popup, setPopup] = useState<Window | null>(null);
	useEffect(() => {
		if (!popup) return;
		function onMessage(event: MessageEvent) {
			if (!popup || !isOAuthComplete(event, { popup, slot, origin: globalThis.location.origin })) return;
			setPopup(null);
			onComplete();
		}
		globalThis.addEventListener('message', onMessage);
		return () => globalThis.removeEventListener('message', onMessage);
	}, [popup, slot, onComplete]);
	return (url) => setPopup(globalThis.open(url, '_blank', 'width=600,height=700'));
}

function AuthChallengeBody({ gate, toolName, onAuthenticated }: AuthChallengeCardProps) {
	const t = useLabels();
	const challenge: AuthChallenge = gate.authChallenge ?? {};
	const authType = challenge.authType || 'bearer';
	const slot = challenge.slot || 'default';
	const [secret, setSecret] = useState('');
	const [submitted, setSubmitted] = useState(false);
	const onOAuthComplete = useCallback(() => {
		setSubmitted(true);
		onAuthenticated?.();
	}, [onAuthenticated]);
	const openSignIn = useOAuthPopup(slot, onOAuthComplete);

	function submit() {
		const value = secret.trim();
		if (!value) return;
		// The key goes to the server once; the browser keeps no copy.
		setSecret('');
		setSubmitted(true);
		onAuthenticated?.(value);
	}

	return (
		<Card padding={4}>
			<VStack gap={3}>
				<CardHeader
					badge={t('@theorem.gate.auth.badge')}
					title={t('@theorem.gate.auth.title')}
					toolName={toolName}
					tag={t(`@theorem.gate.tag.${authType}`)}
				/>
				<AuthChallengeDetails challenge={challenge} />
				<AuthAction
					authType={authType}
					authUrl={challenge.authorizationUrl}
					slot={slot}
					secret={secret}
					submitted={submitted}
					onSecretChange={setSecret}
					onSubmit={submit}
					onOpenSignIn={openSignIn}
				/>
			</VStack>
		</Card>
	);
}

function AuthAction(props: {
	authType: string;
	authUrl?: string;
	slot: string;
	secret: string;
	submitted: boolean;
	onSecretChange: (value: string) => void;
	onSubmit: () => void;
	onOpenSignIn: (url: string) => void;
}) {
	const t = useLabels();
	if (props.submitted) {
		return <Badge variant="success" label={t('@theorem.gate.auth.provided', { slot: props.slot })} />;
	}
	if (props.authType === 'oauth2') {
		if (!props.authUrl) {
			return <Text color="secondary">{t('@theorem.gate.auth.no_oauth')}</Text>;
		}
		return (
			<Button
				label={t('@theorem.gate.auth.authorize')}
				variant="primary"
				onClick={() => {
					if (props.authUrl) props.onOpenSignIn(props.authUrl);
				}}
			/>
		);
	}
	const label = t(props.authType === 'api_key' ? '@theorem.gate.auth.api_key' : '@theorem.gate.auth.bearer');
	return (
		<HStack gap={2} align="end">
			<TextInput
				type="password"
				label={label}
				value={props.secret}
				placeholder={t('@theorem.gate.auth.secret_placeholder', { slot: props.slot })}
				autoComplete="off"
				onChange={props.onSecretChange}
				onEnter={props.onSubmit}
				width="100%"
			/>
			<Button
				label={t('@theorem.gate.auth.submit')}
				variant="primary"
				isDisabled={!props.secret.trim()}
				onClick={props.onSubmit}
			/>
		</HStack>
	);
}
