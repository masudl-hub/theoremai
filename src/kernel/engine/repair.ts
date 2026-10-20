import { type LabelOverrides, labelText } from '../../guardrails/labels.ts';
import type { Profile, TurnHistoryMessage, TurnRepairRequest } from '../types.ts';

const MAX_REPAIR_HISTORY_EXCHANGES = 2;
const MAX_REPAIR_HISTORY_MESSAGES = MAX_REPAIR_HISTORY_EXCHANGES * 2;

function scopeHistory(history: TurnHistoryMessage[] | undefined): TurnHistoryMessage[] {
  if (!history || history.length === 0) {
    return [];
  }
  return history.slice(-MAX_REPAIR_HISTORY_MESSAGES);
}

function formatHistoryBlock(
  messages: TurnHistoryMessage[],
  labels: LabelOverrides | undefined,
): string {
  if (messages.length === 0) {
    return '';
  }
  const lines = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  const heading = labelText('repair.history_heading', { count: messages.length }, labels);
  return `${heading}\n${lines.join('\n')}\n\n`;
}

function synthesizeRepairPrompt(args: {
  profile: Profile;
  repair: TurnRepairRequest;
  history?: TurnHistoryMessage[];
}): string {
  const { profile, repair, history } = args;
  const guidance = repair.guidance || labelText('repair.default_guidance', {}, profile.labels);

  const historyBlock = formatHistoryBlock(scopeHistory(history), profile.labels);

  let prompt = `${labelText('repair.prompt_header', {}, profile.labels)}\n\n`;
  prompt += `${labelText('repair.prompt_intro', {}, profile.labels)}\n\n`;

  prompt += `${labelText('repair.section_previous_output', {}, profile.labels)}\n\`\`\`\n${repair.previousOutput.trim()}\n\`\`\`\n\n`;
  prompt += `${labelText('repair.section_validator_rejection', {}, profile.labels)}\n${repair.rejection.trim()}\n\n`;

  if (guidance.trim()) {
    prompt += `${labelText('repair.section_repair_guidance', {}, profile.labels)}\n${guidance.trim()}\n\n`;
  }

  if (historyBlock) {
    prompt += historyBlock;
  }

  prompt += `${labelText('repair.section_instructions', {}, profile.labels)}\n`;
  prompt += labelText('repair.prompt_instructions', {}, profile.labels);

  return prompt;
}

export { synthesizeRepairPrompt };
