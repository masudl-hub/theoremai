import '../fixtures/test-host.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { labelText } from '../../src/guardrails/labels.ts';
import { getProfile, registerProfile } from '../../src/kernel/default-scope.ts';
import { assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { authorizeToolReplay } from '../../src/kernel/tools/execute.ts';
import type { ToolOperationOutcome } from '../../src/kernel/tools/operation.ts';
import { geminiModels } from '../fixtures/models.ts';

registerProfile(
  defineProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id: 'hidden_replay_probe',
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 2,
    tools: { allow: ['hidden_from_model_tool'] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 10 } },
  }),
);

function outcomeWith(finding?: string): ToolOperationOutcome {
  return {
    event: {
      type: 'tool',
      tool: {
        operationId: 'op',
        callId: 'c1',
        name: 'hidden_from_model_tool',
        at: 0,
        phase: 'complete',
        output: { finding: 'done', secret: 'classified' },
      },
    },
    effects: 'completed',
    replay: finding === undefined ? {} : { modelResult: { finding } },
  };
}

function authorize(finding?: string): void {
  const profile = getProfile('hidden_replay_probe');
  authorizeToolReplay({
    tools: defaultKernelScope.tools,
    profile,
    name: 'hidden_from_model_tool',
    resume: undefined,
    outcome: outcomeWith(finding),
  });
}

Deno.test('a replayed hidden function tool passes only with the fixed hidden finding', () => {
  const profile = getProfile('hidden_replay_probe');
  authorize(labelText('tool.completed_hidden', {}, profile.labels));
  assertThrows(
    () => authorize('classified'),
    TheoremError,
    labelText('detect.output_blocked', {}, profile.labels),
  );
});

Deno.test('a replayed hidden function tool with no saved model result is blocked, not crashed', () => {
  const profile = getProfile('hidden_replay_probe');
  assertThrows(
    () => authorize(undefined),
    TheoremError,
    labelText('detect.output_blocked', {}, profile.labels),
  );
});
