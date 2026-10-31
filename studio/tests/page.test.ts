import { assertEquals } from '@std/assert';
import { TEST_KEYS } from '../../tests/fixtures/lent-keys.ts';
import { ON_OWN_KEYS } from '../lent-keys.ts';
import {
  compileStudio,
  createExampleDraft,
  type SlotDraft,
  type StudioRunPayload,
  setProfileType,
} from '../mod.ts';
import { pageInputsOf, sentPageValues } from '../ui/lib/studio-page.ts';

/** A slot row: each choice a value, or a value and its description. */
function slot(name: string, choices: (string | [string, string])[], label = ''): SlotDraft {
  return {
    key: `slot-${name}`,
    name,
    label,
    choices: choices.map((choice) => {
      const [value, description] = typeof choice === 'string' ? [choice, ''] : choice;
      return { key: `choice-${value}`, value, description };
    }),
  };
}

function payloadOf(draft: ReturnType<typeof createExampleDraft>): StudioRunPayload {
  const compiled = compileStudio(draft, ON_OWN_KEYS);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  return { agentId: 'agent', profile: compiled.profile, customTools: compiled.customTools };
}

function withPage(type: 'text' | 'live') {
  const draft = setProfileType(createExampleDraft(), type, TEST_KEYS);
  draft.inputs = {
    ...draft.inputs,
    slots: [slot('language', ['en', 'fr'])],
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
  assertEquals(sentPageValues(inputs, { slots: {}, conditions: {}, contextJson: '' }), {
    slots: { language: 'en' },
  });
  const picked = {
    slots: { language: 'fr' },
    conditions: {},
    contextJson: '{"page":"Checkout"}',
  };
  assertEquals(sentPageValues(inputs, picked), {
    slots: { language: 'fr' },
    context: { page: 'Checkout' },
  });
  assertEquals(
    sentPageValues(inputs, { slots: { language: 'de' }, conditions: {}, contextJson: '{' }),
    {
      slots: { language: 'en' },
      contextError: 'Context must be JSON.',
    },
  );
});

Deno.test("conditions send their first value until picked, and path goes as the turn's own", () => {
  const draft = createExampleDraft();
  draft.identity.conditionsJson = '{"path":["web","voice"],"plan":["free","paid"]}';
  const inputs = pageInputsOf(payloadOf(draft));
  assertEquals(sentPageValues(inputs, { slots: {}, conditions: {}, contextJson: '' }).stated, {
    path: 'web',
    conditions: { plan: 'free' },
  });
  const picked = { slots: {}, conditions: { path: 'voice', plan: 'gone' }, contextJson: '' };
  assertEquals(sentPageValues(inputs, picked).stated, {
    path: 'voice',
    conditions: { plan: 'free' },
  });
  assertEquals(
    sentPageValues(pageInputsOf(payloadOf(createExampleDraft())), picked).stated,
    undefined,
  );
});

Deno.test('a labeled slot decl compiles and still sends its choice values', () => {
  const draft = setProfileType(createExampleDraft(), 'text', TEST_KEYS);
  draft.inputs = {
    ...draft.inputs,
    slots: [
      slot(
        'language',
        [
          ['en', 'English'],
          ['fr', 'French'],
        ],
        'Language',
      ),
    ],
  };
  const payload = payloadOf(draft);
  const inputs = 'inputs' in payload.profile ? payload.profile.inputs : undefined;
  const slots = inputs && 'slots' in inputs ? inputs.slots : undefined;
  assertEquals(slots, {
    language: {
      label: 'Language',
      choices: [
        { value: 'en', description: 'English' },
        { value: 'fr', description: 'French' },
      ],
    },
  });
  assertEquals(pageInputsOf(payload)?.slots, { language: ['en', 'fr'] });
  assertEquals(
    sentPageValues(pageInputsOf(payload), { slots: {}, conditions: {}, contextJson: '' }),
    {
      slots: { language: 'en' },
    },
  );
});

Deno.test('a call and a chat both ask the page to answer a tool', () => {
  for (const type of ['live', 'text'] as const) {
    const agent = withPage(type);
    assertEquals(pageInputsOf(agent.payload)?.pageTools, [agent.toolName]);
  }
});
