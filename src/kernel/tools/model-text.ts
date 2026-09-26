/**
 * The text the model reads for a tool call: a result, or a failure. Every
 * transport and every replay formats through here, so the model's view of a
 * call cannot drift between the turn, the live session and history.
 *
 * @module
 */

import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import { composeToolText, guardToolFailureText } from '../../guardrails/tool-result.ts';
import type { Provenance } from '../../guardrails/types.ts';
import type { ModelToolResult, ToolFailure } from './types.ts';

/**
 * Format model-facing tool output for provider history continuation.
 *
 * Text projection only — never embeds `parts[].data`; media travels on
 * `TurnHistoryMessage.parts` and adapters wire it from there.
 *
 * `executeRegisteredTool` guards at the boundary and leaves `modelText` behind, so
 * the common path returns already-fenced text. A result recorded elsewhere — a
 * host replaying a transcript — is guarded here instead, under full detection.
 */
export function formatToolResult(result: ModelToolResult): string {
  if (result.modelText !== undefined) {
    return result.modelText;
  }
  return sanitizeText(composeToolText(result.finding, result.data));
}

/**
 * Format a tool failure for provider history — structured so the model (or host)
 * sees the code.
 *
 * The message is remote-authored on HTTP and MCP tools, so it is redacted before
 * the kernel frames it as a system report.
 */
export function formatToolFailureForModel(
  failure: Pick<ToolFailure, 'code' | 'message' | 'details'>,
  provenance?: Provenance,
  policy: ReturnType<typeof resolveGuardrailPolicy> = resolveGuardrailPolicy(undefined),
): ModelToolResult {
  const safe = provenance
    ? guardToolFailureText(failure.message, provenance, policy).text
    : sanitizeText(failure.message);
  return {
    finding: `Tool error (${failure.code}): ${safe}`,
    // The finding already says the code and message; only details are new.
    ...(failure.details !== undefined ? { data: { details: failure.details } } : {}),
  };
}
