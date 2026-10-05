import type { ToolGate } from '@theoremjs/agents/kernel';
import { humanize } from '../client/shaped-data.ts';
import type { LabelText } from './labels.ts';

/** "@concierge wants to check the weather": the tool's `labels.request`, else its name in words. */
export function approvalHeading(
  t: LabelText,
  gate: ToolGate,
  toolName: string,
  agent?: string,
): string {
  const request =
    gate.request ??
    t('@theorem.gate.approval.use_tool', { tool: humanize(toolName).toLowerCase() });
  return agent
    ? t('@theorem.gate.approval.title', { agent, request })
    : t('@theorem.gate.approval.title_no_agent', { request });
}
