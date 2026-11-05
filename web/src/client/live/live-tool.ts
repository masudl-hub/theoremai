import type { ToolGate } from '@theoremjs/agents/kernel';
import type { ToolGateResolution } from '../tool-resume.ts';

/** A gate the user is asked to answer, for the model's call `callId`. */
export type LiveToolGatePrompt = {
  callId: string;
  toolName: string;
  input: Record<string, unknown>;
  gate: ToolGate;
};

/** The user's answer to a live gate, or `withdrawn`: the model cancelled the call, so nothing is asked. */
export type LiveGateAnswer = ToolGateResolution | 'withdrawn';

/**
 * What the host sends for a gate: a refusal, or an approval (with the key the user typed at a
 * sign-in gate), or `withdrawn` when the model cancelled the call. `continueGatedToolInvocation`
 * turns the user's answer into one.
 */
export type LiveGateReply =
  | { decision: 'deny' }
  | { decision: 'approve'; secret?: string }
  | 'withdrawn';
