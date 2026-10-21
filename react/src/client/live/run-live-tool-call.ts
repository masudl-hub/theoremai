import type {
  ExecuteToolOnRelay,
  LiveGateAnswer,
  LiveToolGatePrompt,
  PageTools,
} from '@theoremjs/web/client';
import { continueGatedToolInvocation } from '@theoremjs/web/client';

/**
 * Live provider tool-call handler: the page answers the call if it is the
 * page's; else run the model's call on the relay; at a gate, ask the user and
 * send their decision. The session answers the model
 * however the call ends; its tool events tell the user. A call the model
 * cancels while its gate is open is gone: nothing is sent.
 */
export async function runLiveToolCall(args: {
  executeToolOnRelay: ExecuteToolOnRelay;
  /** The host's page tools, if it has any. */
  pageTools?: PageTools;
  name: string;
  toolArgs: Record<string, unknown>;
  callId: string;
  operationId: string;
  sessionPermissions: string[];
  setSessionPermissions: (next: string[]) => void;
  waitForGateDecision: (prompt: LiveToolGatePrompt) => Promise<LiveGateAnswer>;
}): Promise<void> {
  const { executeToolOnRelay, name, toolArgs, callId, operationId } = args;
  let sessionPermissions = args.sessionPermissions;
  // why: A name from the model is looked up among the host's own keys only.
  const pageTool =
    args.pageTools && Object.hasOwn(args.pageTools, name) ? args.pageTools[name] : undefined;
  let step = await executeToolOnRelay({ callId, operationId });
  const dispatched = new Set<string>();
  while (step.status !== 'settled') {
    if (step.status === 'dispatched') {
      if (dispatched.has(step.grantId)) return;
      dispatched.add(step.grantId);
      const grantId = step.grantId;
      const input = step.arguments;
      const answer = pageTool
        ? await Promise.resolve()
            .then(() => pageTool(input, { callId, operationId }))
            .catch(() => undefined)
        : undefined;
      step = await executeToolOnRelay({
        callId,
        operationId,
        grantId,
        ...(answer ? { output: answer.output } : { unanswered: true as const }),
      });
      continue;
    }
    const { gate } = step;
    if (gate.kind === 'page') {
      await executeToolOnRelay({ callId, operationId, decision: 'deny' });
      return;
    }
    const resolution = await args.waitForGateDecision({
      callId,
      toolName: name,
      input: gate.preparedArguments ?? toolArgs,
      gate,
    });
    if (resolution === 'withdrawn') return;
    const reply = continueGatedToolInvocation({
      toolName: name,
      gate,
      sessionPermissions,
      resolution,
    });
    if (reply.decision === 'deny') {
      // why: The session settles the refusal; its tool event tells the user.
      await executeToolOnRelay({ callId, operationId, decision: 'deny' });
      return;
    }
    sessionPermissions = reply.sessionPermissions;
    args.setSessionPermissions(reply.sessionPermissions);
    // why: Signed in: a typed key goes once, with the approval; after an OAuth callback there is none.
    step = await executeToolOnRelay({
      callId,
      decision: 'approve',
      operationId,
      ...(reply.secret !== undefined ? { secret: reply.secret } : {}),
    });
  }
}
