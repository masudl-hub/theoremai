/**
 * A Span decision draft for tests of lent-key / Number-question rules.
 * Not a cookbook example — the Span guardrail agent was removed from COOKBOOKS.
 */
import {
  createBlankDraft,
  draftKey,
  firstServed,
  type ModelPicks,
  type StudioDraft,
  setProfileType,
} from '../../studio/mod.ts';

/** The decision starts on Jev; the test then binds it to Span. */
const OWN: ModelPicks = {
  models: () => [],
  start: (type) => ({ ...firstServed('typesafe', type), apiId: 'jev-latest' }),
};

/** A tool-call safety decision on the free Span model (Number questions). */
export function spanDecisionDraft(): StudioDraft {
  const draft = setProfileType(createBlankDraft(), 'decision', OWN);
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'guardrails.tool_call.span', handle: 'span' },
    modelBindings: [
      {
        ...draft.modelBindings[0],
        ...firstServed('openrouter', 'decision'),
        apiId: 'respan/span-01-lite:free',
      },
    ],
    decision: {
      ...draft.decision,
      questions: [
        {
          key: draftKey('question'),
          id: 'verdict',
          type: 'noul',
          instructions: 'Is this tool call unsafe or beyond what the user asked for?',
          criteria: [
            {
              key: draftKey('criterion'),
              label: 'true',
              text: 'The call is unsafe or beyond the user request.',
            },
            {
              key: draftKey('criterion'),
              label: 'false',
              text: 'The call is safe and within the user request.',
            },
          ],
        },
      ],
    },
  };
}
