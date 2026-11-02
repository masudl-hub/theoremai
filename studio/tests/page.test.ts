import { assertEquals } from '@std/assert';
import { TEST_KEYS } from '../../tests/fixtures/lent-keys.ts';
import { ON_OWN_KEYS } from '../lent-keys.ts';
import {
  compileStudio,
  createExampleDraft,
  type OptionDraft,
  type StudioRunPayload,
  setProfileType,
} from '../mod.ts';
import { pageInputsOf, sentPageValues } from '../ui/lib/studio-page.ts';

/** An option row: each choice a value, or a value and its description. */
function option(
  name: string,
  choices: (string | [string, string])[],
  { label = '', isShownInChat = true }: { label?: string; isShownInChat?: boolean } = {},
): OptionDraft {
  return {
    key: `option-${name}`,
    name,
    label,
    isShownInChat,
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
  draft.identity.options = [option('language', ['en', 'fr'])];
  draft.inputs = {
    ...draft.inputs,
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

Deno.test('a shown option sends its first value until one is picked, and a dropped value falls back', () => {
  const inputs = pageInputsOf(withPage('text').payload);
  assertEquals(sentPageValues(inputs, { options: {}, contextJson: '' }), {
    options: { language: 'en' },
  });
  const picked = {
    options: { language: 'fr' },
    contextJson: '{"page":"Checkout"}',
  };
  assertEquals(sentPageValues(inputs, picked), {
    options: { language: 'fr' },
    context: { page: 'Checkout' },
  });
  assertEquals(sentPageValues(inputs, { options: { language: 'de' }, contextJson: '{' }), {
    options: { language: 'en' },
    contextError: 'Context must be JSON.',
  });
});

Deno.test("code options send their first value until picked, and path goes as the turn's own", () => {
  const draft = createExampleDraft();
  draft.identity.options = [
    option('path', ['web', 'voice'], { isShownInChat: false }),
    option('plan', ['free', 'paid'], { isShownInChat: false }),
  ];
  const inputs = pageInputsOf(payloadOf(draft));
  assertEquals(sentPageValues(inputs, { options: {}, contextJson: '' }).stated, {
    path: 'web',
    options: { plan: 'free' },
  });
  const picked = { options: { path: 'voice', plan: 'gone' }, contextJson: '' };
  assertEquals(sentPageValues(inputs, picked).stated, {
    path: 'voice',
    options: { plan: 'free' },
  });
  assertEquals(
    sentPageValues(pageInputsOf(payloadOf(createExampleDraft())), picked).stated,
    undefined,
  );
});

Deno.test('a labeled option compiles and still sends its choice values', () => {
  const draft = setProfileType(createExampleDraft(), 'text', TEST_KEYS);
  draft.identity.options = [
    option(
      'language',
      [
        ['en', 'English'],
        ['fr', 'French'],
      ],
      { label: 'Language' },
    ),
  ];
  const payload = payloadOf(draft);
  const inputs = 'inputs' in payload.profile ? payload.profile.inputs : undefined;
  const declared = inputs && 'options' in inputs ? inputs.options : undefined;
  assertEquals(declared, {
    language: {
      label: 'Language',
      choices: [
        { value: 'en', description: 'English' },
        { value: 'fr', description: 'French' },
      ],
    },
  });
  assertEquals(pageInputsOf(payload)?.person, { language: ['en', 'fr'] });
  assertEquals(sentPageValues(pageInputsOf(payload), { options: {}, contextJson: '' }), {
    options: { language: 'en' },
  });
});

Deno.test('a call and a chat both ask the page to answer a tool', () => {
  for (const type of ['live', 'text'] as const) {
    const agent = withPage(type);
    assertEquals(pageInputsOf(agent.payload)?.pageTools, [agent.toolName]);
  }
});
