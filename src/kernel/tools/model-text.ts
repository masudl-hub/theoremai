import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import { composeToolText, guardToolFailureText } from '../../guardrails/tool-result.ts';
import type { Provenance } from '../../guardrails/types.ts';
import type { ModelToolResult, ToolFailure } from './types.ts';

/**
 * Every transport and replay formats through here, so the model's view of a call cannot drift.
 * Never embeds `parts[].data`: media travels on `TurnHistoryMessage.parts`. A result without
 * `modelText` (a host replaying a transcript) is guarded here under full detection.
 */
export function formatToolResult(result: ModelToolResult): string {
  if (result.modelText !== undefined) {
    return result.modelText;
  }
  return sanitizeText(composeToolText(result.finding, result.data));
}

/** The message is remote-authored on HTTP and MCP tools, so it is redacted before the kernel frames it. */
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
    // why: The finding already says the code and message; only details are new.
    ...(failure.details !== undefined ? { data: { details: failure.details } } : {}),
  };
}
