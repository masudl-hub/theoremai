import { TheoremError } from '../../guardrails/error.ts';
import { credentialForSignInGate } from '../auth/typed-secret.ts';
import type { ApiKeyCredential, BearerCredential } from '../auth/types.ts';
import type { ToolPermission } from '../schema.ts';
import type { ToolAuthChallenge } from '../turn-events.ts';
import type { InvokeToolResume } from './types.ts';

/** What a sign-in gate asks for, minus the challenge's OAuth details. */
export type ToolGateAuth = Pick<ToolAuthChallenge, 'slot' | 'authType' | 'service'>;

const DEFAULT_GATE_TTL_MS = 30 * 60 * 1000;

/** A bad value is refused when `owner` is built, not when a gate expires. */
export function resolveGateTtlMs(owner: string, gateTtlMs: number | undefined): number {
  const ttl = gateTtlMs ?? DEFAULT_GATE_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new TheoremError(
      'config',
      `${owner} gateTtlMs must be a positive number of milliseconds; got ${ttl}.`, // lexicon-exempt: builder config error at setup; no user sees it
    );
  }
  return ttl;
}

/** True when the gate has waited as long as its time limit. */
export function gateExpired(createdAt: number, now: number, ttlMs: number): boolean {
  return now - createdAt >= ttlMs;
}

/** How a user can answer a tool gate: approve it, deny it or walk away. */
export const GATE_DECISIONS = ['approve', 'deny', 'abandon'] as const;
/** One of {@linkcode GATE_DECISIONS}. */
export type GateDecision = (typeof GATE_DECISIONS)[number];

/** `edited.from` is the input the model proposed. */
export type GateAnswer =
  | { decision: 'approve'; edited?: { from: Record<string, unknown> } }
  | { decision: 'deny' | 'abandon' };

/** `signIn` when the gate answered is a sign-in, so the model is told the person signed in or why not. */
export function resumeForAnswer(answer: GateAnswer, signIn = false): InvokeToolResume {
  if (answer.decision === 'approve') {
    return {
      granted: true,
      ...(answer.edited ? { edited: answer.edited } : {}),
      ...(signIn ? { signIn } : {}),
    };
  }
  return {
    granted: false,
    cause: answer.decision === 'deny' ? 'declined' : 'abandoned',
    ...(signIn ? { signIn } : {}),
  };
}

/** Only a `session_consent` approval lasts the session; any other gate is approved for this call only. */
export function sessionPermissionsAfterApproval(
  sessionPermissions: readonly string[],
  toolName: string,
  permission?: ToolPermission,
): string[] {
  if (permission !== 'session_consent' || sessionPermissions.includes(toolName)) {
    return [...sessionPermissions];
  }
  return [...sessionPermissions, toolName];
}

/** The user's answer to a held tool call. */
export type GateAnswerRequest = {
  callId: string;
  decision: GateDecision;
  /** The user's edit; approvals only. */
  input?: unknown;
  /** The key typed at a sign-in gate; approvals only. */
  secret?: string;
};

/** A tool call held at a gate, with what answering it needs. */
export type HeldGatedCall = {
  name: string;
  arguments: Record<string, unknown>;
  permission?: ToolPermission;
  /** Absent on any gate other than sign-in. */
  auth?: ToolGateAuth;
};

/** A tool call's gate once answered: how the call resumes and the permissions after. */
export type AnsweredGate = {
  resume: InvokeToolResume;
  input: unknown;
  sessionPermissions: string[];
  typed?: { slot: string; credential: BearerCredential | ApiKeyCredential };
};

/** Shared by `createTheoremHandler` and `runSession`. A refused key throws, so the gate keeps waiting for another. */
export function answerGatedCall(
  request: GateAnswerRequest,
  call: HeldGatedCall,
  sessionPermissions: readonly string[],
): AnsweredGate {
  const { callId, decision, input, secret } = request;
  if ((input !== undefined || secret !== undefined) && decision !== 'approve') {
    throw new TheoremError(
      'request',
      `only an approval takes edited input or a secret (call ${callId})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (decision !== 'approve') {
    return {
      resume: resumeForAnswer({ decision }, call.auth !== undefined),
      input: call.arguments,
      sessionPermissions: [...sessionPermissions],
    };
  }
  const typed = secret === undefined ? undefined : credentialForSignInGate(call.auth, secret);
  return {
    resume: resumeForAnswer(
      input === undefined ? { decision } : { decision, edited: { from: call.arguments } },
      call.auth !== undefined,
    ),
    input: input ?? call.arguments,
    sessionPermissions: sessionPermissionsAfterApproval(
      sessionPermissions,
      call.name,
      call.permission,
    ),
    ...(typed ? { typed } : {}),
  };
}
