import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { IconEye, IconFlame, IconPencil, type Icon as TablerIcon } from '@tabler/icons-react';
import type { ToolAccess, ToolGate } from '@theoremjs/agents/kernel';
import { useCallback, useEffect, useState } from 'react';
import { isOAuthComplete } from '../client/oauth-popup.ts';
import type { ToolDecisionAction } from '../client/tool-resume.ts';
import { approvalHeading } from './approval-heading.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';

export type ToolDecision = ToolDecisionAction;

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

const ACCESS_ICON: Record<ToolAccess, TablerIcon> = {
  'read-only': IconEye,
  'read-write': IconPencil,
  destructive: IconFlame,
};

function ToolAccessTag({ access }: { access: ToolAccess }) {
  const t = useLabels();
  return (
    <HStack gap={1} align="center">
      <Icon
        icon={ACCESS_ICON[access]}
        size="sm"
        color={access === 'destructive' ? 'error' : 'secondary'}
      />
      <Text type="supporting" textWrap="nowrap">
        {t(`@theorem.tool.access.${access}`)}
      </Text>
    </HStack>
  );
}

export type ApprovalCardProps = {
  gate: ToolGate;
  toolName: string;
  /** The agent asking, as its name is shown (`@concierge`); the heading names it. */
  agent?: string;
  input?: unknown;
  /** The decision on its way; its button shows loading and the other is disabled until the gate settles. */
  decided?: ToolDecision | null;
  onDecision?: (action: ToolDecision) => void;
};

export function ApprovalCard(props: ApprovalCardProps) {
  return (
    <TheoremLabelsProvider>
      <ApprovalBody {...props} />
    </TheoremLabelsProvider>
  );
}

function ApprovalBody({
  gate,
  toolName,
  agent,
  input,
  decided = null,
  onDecision,
}: ApprovalCardProps) {
  const t = useLabels();
  const args = formatInput(input);

  return (
    <Card elevation="low" maxWidth={400}>
      <VStack gap={3}>
        <HStack justify="between" align="start" gap={3}>
          <Text type="large" weight="semibold">
            {approvalHeading(t, gate, toolName, agent)}
          </Text>
          {gate.access ? <ToolAccessTag access={gate.access} /> : null}
        </HStack>
        {gate.summary ? <Text color="secondary">{gate.summary}</Text> : null}
        {args ? (
          <Collapsible
            defaultIsOpen={false}
            trigger={<Text type="supporting">{t('@theorem.gate.approval.input')}</Text>}
          >
            <CodeBlock code={args} language="json" size="sm" />
          </Collapsible>
        ) : null}
        <HStack gap={2} justify="end">
          <Button
            label={t('@theorem.gate.approval.deny')}
            variant="ghost"
            isLoading={decided === 'deny'}
            isDisabled={decided === 'allow'}
            onClick={() => onDecision?.('deny')}
          />
          <Button
            label={t('@theorem.gate.approval.approve')}
            variant="primary"
            isLoading={decided === 'allow'}
            isDisabled={decided === 'deny'}
            onClick={() => onDecision?.('allow')}
          />
        </HStack>
      </VStack>
    </Card>
  );
}

/** A gate that needs the user to sign in first. */
export type AuthGate = Extract<ToolGate, { kind: 'auth' }>;

export type AuthChallengeCardProps = {
  gate: AuthGate;
  toolName: string;
  /**
   * Signed in: `secret` is the key the user typed, for the server to save; after
   * an OAuth sign-in (the popup's `notifyOAuthComplete`) there is none.
   */
  onAuthenticated?: (secret?: string) => void;
  /** Signed in, and the answer is on its way; the sign-in returns if it fails. */
  submitted?: boolean;
};

type AuthChallenge = AuthGate['authChallenge'];

function AuthChallengeDetails({ challenge }: { challenge: AuthChallenge }) {
  const t = useLabels();
  return (
    <>
      <Text>{challenge.message}</Text>
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
      if (!popup || !isOAuthComplete(event, { popup, slot, origin: globalThis.location.origin }))
        return;
      setPopup(null);
      onComplete();
    }
    globalThis.addEventListener('message', onMessage);
    return () => globalThis.removeEventListener('message', onMessage);
  }, [popup, slot, onComplete]);
  return (url) => setPopup(globalThis.open(url, '_blank', 'width=600,height=700'));
}

function AuthChallengeBody({
  gate,
  toolName,
  onAuthenticated,
  submitted = false,
}: AuthChallengeCardProps) {
  const t = useLabels();
  const challenge = gate.authChallenge;
  const { authType, slot } = challenge;
  const [secret, setSecret] = useState('');
  const onOAuthComplete = useCallback(() => onAuthenticated?.(), [onAuthenticated]);
  const openSignIn = useOAuthPopup(slot, onOAuthComplete);

  function submit() {
    const value = secret.trim();
    if (!value) return;
    // why: The key goes to the server once; the browser keeps no copy.
    setSecret('');
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
    return (
      <Badge variant="success" label={t('@theorem.gate.auth.provided', { slot: props.slot })} />
    );
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
  const label = t(
    props.authType === 'api_key' ? '@theorem.gate.auth.api_key' : '@theorem.gate.auth.bearer',
  );
  const note = t('@theorem.gate.auth.secret_note').trim();
  return (
    <HStack gap={2} align="end">
      <TextInput
        type="password"
        label={label}
        {...(note ? { description: note } : {})}
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
