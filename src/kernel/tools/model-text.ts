import { redactDetectors } from '../../guardrails/detect-at.ts';
import { DETECTORS } from '../../guardrails/detectors.ts';
import { composeToolText } from '../../guardrails/tool-result.ts';
import type { ModelToolResult, ToolFailure } from './types.ts';

/**
 * Every transport and replay formats through here, so the model's view of a call cannot drift.
 * Never embeds `parts[].data`: media travels on `TurnHistoryMessage.parts`. A result without
 * `modelText` (a host replaying a transcript) has no profile in hand, so every detector's
 * matches are replaced.
 */
export function formatToolResult(result: ModelToolResult): string {
  if (result.modelText !== undefined) {
    return result.modelText;
  }
  return redactDetectors(composeToolText(result.finding, result.data), DETECTORS);
}

/** A failure as the kernel reports it to the model. The message is used as given. */
export function frameToolFailure(
  failure: Pick<ToolFailure, 'code' | 'message' | 'details'>,
): ModelToolResult {
  return {
    finding: `Tool error (${failure.code}): ${failure.message}`,
    // why: The finding already says the code and message; only details are new.
    ...(failure.details !== undefined ? { data: { details: failure.details } } : {}),
  };
}

/**
 * A failure framed with no profile in hand: the message is remote-authored on HTTP and MCP
 * tools, so every detector's matches are replaced first. A call that settles through the
 * executor reads the message at its own boundary instead.
 */
export function formatToolFailureForModel(
  failure: Pick<ToolFailure, 'code' | 'message' | 'details'>,
): ModelToolResult {
  return frameToolFailure({ ...failure, message: redactDetectors(failure.message, DETECTORS) });
}
