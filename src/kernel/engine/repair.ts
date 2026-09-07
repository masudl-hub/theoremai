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
  return `### RECENT CONVERSATION CONTEXT (LAST ${messages.length} TURNS)\n${lines.join('\n')}\n\n`;
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
    'Revise the previous output so it satisfies the validator rejection. Preserve the intended user-facing substance unless the guidance says otherwise.';

  const historyBlock = formatHistoryBlock(scopeHistory(history));

  let prompt = `## OUTPUT REPAIR REQUEST\n\n`;
  prompt += `The previous assistant output was rejected by a host validator and must be revised.\n\n`;

  prompt += `### PREVIOUS OUTPUT\n\`\`\`\n${repair.previousOutput.trim()}\n\`\`\`\n\n`;
  prompt += `### VALIDATOR REJECTION\n${repair.rejection.trim()}\n\n`;

  if (guidance.trim()) {
    prompt += `### REPAIR GUIDANCE\n${guidance.trim()}\n\n`;
  }

  if (historyBlock) {
    prompt += historyBlock;
  }

  prompt += `### INSTRUCTIONS\n`;
  prompt += `1. Inspect the previous output and validator rejection.\n`;
  prompt += `2. Apply the repair guidance without inventing unsupported facts.\n`;
  prompt += `3. Return only the corrected assistant output required by the active profile.`;

  return prompt;
}

export { synthesizeRepairPrompt };
