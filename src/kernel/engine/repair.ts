import { lexiconText } from '../../guardrails/lexicon.ts';
import { profileTurnOutputs } from '../registry/profile-outputs.ts';
import type { Profile, TurnHistoryMessage, TurnRepairRequest } from '../types.ts';

const MAX_REPAIR_HISTORY_EXCHANGES = 2;
const MAX_REPAIR_HISTORY_MESSAGES = MAX_REPAIR_HISTORY_EXCHANGES * 2;

function scopeHistory(history: TurnHistoryMessage[] | undefined): TurnHistoryMessage[] {
  if (!history || history.length === 0) {
    return [];
  }
  return history.slice(-MAX_REPAIR_HISTORY_MESSAGES);
}

function formatHistoryBlock(messages: TurnHistoryMessage[]): string {
  if (messages.length === 0) {
    return '';
  }
  const lines = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  const heading = lexiconText('repair.history_heading', { count: messages.length });
  return `${heading}\n${lines.join('\n')}\n\n`;
}

function synthesizeRepairPrompt(args: {
  profile: Profile;
  repair: TurnRepairRequest;
  history?: TurnHistoryMessage[];
}): string {
  const { profile, repair, history } = args;
  const guidance =
    repair.guidance ||
    profileTurnOutputs(profile)?.validation?.repairGuidance ||
    lexiconText('repair.default_guidance');

  const historyBlock = formatHistoryBlock(scopeHistory(history));

  let prompt = `${lexiconText('repair.prompt_header')}\n\n`;
  prompt += `${lexiconText('repair.prompt_intro')}\n\n`;

  prompt += `${lexiconText('repair.section_previous_output')}\n\`\`\`\n${repair.previousOutput.trim()}\n\`\`\`\n\n`;
  prompt += `${lexiconText('repair.section_validator_rejection')}\n${repair.rejection.trim()}\n\n`;

  if (guidance.trim()) {
    prompt += `${lexiconText('repair.section_repair_guidance')}\n${guidance.trim()}\n\n`;
  }

  if (historyBlock) {
    prompt += historyBlock;
  }

  prompt += `${lexiconText('repair.section_instructions')}\n`;
  prompt += lexiconText('repair.prompt_instructions');

  return prompt;
}

export { synthesizeRepairPrompt };
