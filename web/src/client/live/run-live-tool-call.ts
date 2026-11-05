import type { ExecuteToolOnRelay } from '../live-messages.ts';
import type { PageTools } from './live-page-tool.ts';
import type { LiveGateReply, LiveToolGatePrompt } from './live-tool.ts';

/** Page tools already said to have no handler, so the console says it once for each name. */
const unhandled = new Set<string>();

/**
 * One call the model made, run to its end: the relay checks it, the page answers a call
 * dispatched to it, and `onGate` answers any other gate. Every step is answered: a page tool
 * with no handler, or one that throws, answers with no answer, and with no `onGate` a gate is
 * refused. A call the model cancels while its gate is open is gone: nothing is sent.
 */
export async function runLiveToolCall(args: {
  executeToolOnRelay: ExecuteToolOnRelay;
  pageTools?: PageTools;
  onGate?: (prompt: LiveToolGatePrompt) => Promise<LiveGateReply>;
  name: string;
  toolArgs: Record<string, unknown>;
  callId: string;
  operationId: string;
}): Promise<void> {
  const { executeToolOnRelay, name, toolArgs, callId, operationId } = args;
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
      if (!pageTool && !unhandled.has(name)) {
        unhandled.add(name);
        // labels-exempt: builder diagnostic
        console.warn(
          `Theorem: page tool '${name}' has no handler in pageTools; the agent gets no answer.`,
        );
      }
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
    // why: The page answers only a dispatched call; an old page gate is refused.
    const reply =
      gate.kind === 'page' || !args.onGate
        ? ({ decision: 'deny' } as const)
        : await args.onGate({
            callId,
            toolName: name,
            input: gate.preparedArguments ?? toolArgs,
            gate,
          });
    if (reply === 'withdrawn') return;
    if (reply.decision === 'deny') {
      // why: The session settles the refusal; its tool event tells the user.
      await executeToolOnRelay({ callId, operationId, decision: 'deny' });
      return;
    }
    // why: Signed in: a typed key goes once, with the approval; after an OAuth callback there is none.
    step = await executeToolOnRelay({
      callId,
      decision: 'approve',
      operationId,
      ...(reply.secret !== undefined ? { secret: reply.secret } : {}),
    });
  }
}
