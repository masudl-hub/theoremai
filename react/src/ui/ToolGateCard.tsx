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
import { useState } from 'react';
import type { ToolCredential, ToolGate } from '../../../src/kernel/mod.ts';

export type ToolDecision = 'allow' | 'allow_session' | 'deny';

const DECISION_LABEL: Record<ToolDecision, string> = {
	allow: 'Approved once',
	allow_session: 'Approved for this session',
	deny: 'Denied',
};

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

export function ApprovalCard({ gate, toolName, input, onDecision }: ApprovalCardProps) {
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
					badge="Approval required"
					title="Tool:"
					toolName={toolName}
					tag={gate.permission ?? 'session_consent'}
				/>
				{gate.summary ? <Text>{gate.summary}</Text> : null}
				{args ? (
					<Collapsible trigger={<Text size="sm">Input arguments</Text>}>
						<CodeBlock code={args} language="json" size="sm" />
					</Collapsible>
				) : null}
				{decided === null ? (
					<HStack gap={2} justify="end">
						<Button label="Deny" variant="ghost" onClick={() => decide('deny')} />
						<Button label="Always allow this session" variant="secondary" onClick={() => decide('allow_session')} />
						<Button label="Approve" variant="primary" onClick={() => decide('allow')} />
					</HStack>
				) : (
					<Badge variant={decided === 'deny' ? 'error' : 'success'} label={DECISION_LABEL[decided]} />
				)}
			</VStack>
		</Card>
	);
}

export type AuthChallengeCardProps = {
	gate: ToolGate;
	toolName: string;
	onSubmitCredential?: (slot: string, credential: ToolCredential) => void;
};

function credentialFromSecret(authType: string, secret: string): ToolCredential {
	if (authType === 'api_key') return { type: 'api_key', key: secret };
	return { type: 'bearer', token: secret };
}

export function AuthChallengeCard({ gate, toolName, onSubmitCredential }: AuthChallengeCardProps) {
	const challenge = gate.authChallenge;
	const authType = challenge?.authType || 'bearer';
	const slot = challenge?.slot || 'default';
	const authUrl = challenge?.authorizationUrl;
	const [secret, setSecret] = useState('');
	const [submitted, setSubmitted] = useState(false);

	function submit() {
		const value = secret.trim();
		if (!value) return;
		setSubmitted(true);
		onSubmitCredential?.(slot, credentialFromSecret(authType, value));
	}

	return (
		<Card padding={4}>
			<VStack gap={3}>
				<CardHeader badge="Sign-in required" title="Authentication:" toolName={toolName} tag={authType} />
				<Text>
					{challenge?.message || 'This tool requires valid authentication credentials to proceed.'}
				</Text>
				{challenge?.resource ? (
					<Text size="sm" color="secondary">
						Resource: {challenge.resource}
					</Text>
				) : null}
				{challenge?.requiredScopes?.length ? (
					<HStack gap={1} wrap="wrap">
						{challenge.requiredScopes.map((scope) => (
							<Token key={scope} label={scope} size="sm" />
						))}
					</HStack>
				) : null}
				<AuthAction
					authType={authType}
					authUrl={authUrl}
					slot={slot}
					secret={secret}
					submitted={submitted}
					onSecretChange={setSecret}
					onSubmit={submit}
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
}) {
	if (props.authType === 'oauth2') {
		if (!props.authUrl) {
			return <Text color="secondary">No OAuth authorization endpoint is configured.</Text>;
		}
		return (
			<Button
				label="Authorize with provider"
				variant="primary"
				onClick={() => {
					globalThis.open(props.authUrl, '_blank', 'width=600,height=700');
				}}
			/>
		);
	}
	if (props.submitted) {
		return <Badge variant="success" label={`Credential provided for ${props.slot}`} />;
	}
	const label = props.authType === 'api_key' ? 'API key' : 'Bearer token';
	return (
		<HStack gap={2} align="end">
			<TextInput
				type="password"
				label={label}
				value={props.secret}
				placeholder={`Secret for slot '${props.slot}'`}
				autoComplete="off"
				onChange={props.onSecretChange}
				onEnter={props.onSubmit}
				width="100%"
			/>
			<Button
				label="Submit & continue"
				variant="primary"
				isDisabled={!props.secret.trim()}
				onClick={props.onSubmit}
			/>
		</HStack>
	);
}
