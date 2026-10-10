import { assertEquals } from '@std/assert';
import {
  compileStudio,
  createExampleDraft,
  type StudioRunPayload,
  setProfileType,
} from '../mod.ts';
import { pageInputsOf, sentPageValues } from '../ui/lib/studio-page.ts';

function payloadOf(draft: ReturnType<typeof createExampleDraft>): StudioRunPayload {
  const compiled = compileStudio(draft);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  return { agentId: 'agent', profile: compiled.profile, customTools: compiled.customTools };
}

function withPage(type: 'text' | 'live') {
  const draft = setProfileType(createExampleDraft(), type);
  draft.inputs = {
    ...draft.inputs,
    slotsJson: '{"language":["en","fr"]}',
    contextFrom: ['client'],
    contextMaxChars: 2000,
  };
  const at = draft.toolSpecs.findIndex((tool) => tool.toolType === 'function');
  draft.toolSpecs = draft.toolSpecs.map((tool, index) =>
    index === at ? { ...tool, answeredBy: 'page' as const } : tool,
  );
  return { payload: payloadOf(draft), toolName: draft.toolSpecs[at]?.toolName };
}

Deno.test('an agent that takes nothing from a page has no page inputs', () => {
  assertEquals(pageInputsOf(payloadOf(createExampleDraft())), null);
});

Deno.test('a slot sends its first value until one is picked, and a dropped value falls back', () => {
  const inputs = pageInputsOf(withPage('text').payload);
  assertEquals(sentPageValues(inputs, { slots: {}, contextJson: '' }), {
    slots: { language: 'en' },
  });
  const picked = { slots: { language: 'fr' }, contextJson: '{"page":"Checkout"}' };
  assertEquals(sentPageValues(inputs, picked), {
    slots: { language: 'fr' },
    context: { page: 'Checkout' },
  });
  assertEquals(sentPageValues(inputs, { slots: { language: 'de' }, contextJson: '{' }), {
    slots: { language: 'en' },
    contextError: 'Context must be JSON.',
  });
});

Deno.test('a call and a chat both ask the page to answer a tool', () => {
  for (const type of ['live', 'text'] as const) {
    const agent = withPage(type);
    assertEquals(pageInputsOf(agent.payload)?.pageTools, [agent.toolName]);
  }
});
