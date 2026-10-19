import { assert, assertEquals } from '@std/assert';
import type { Profile, TurnEvent, TurnModel } from '../../mod.ts';
import { createSealedConversationStore } from '../../react/src/server/conversation-store.ts';
import { createMemorySteerInbox } from '../../react/src/server/steer-inbox.ts';
import { newConversationKey } from '../../studio/conversation-key.ts';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import {
  addAgent,
  agentDraft,
  compileWorkspace,
  createBlankDraft,
  createExampleDraft,
  defaultToolSpec,
  setProfileType,
  withAgentDraft,
  workspaceFromDraft,
  workspaceRunAgent,
} from '../../studio/mod.ts';
import { type StudioRuntime, streamStudioTurn } from '../../studio/runtime.ts';
import { TEST_KEYS } from '../fixtures/lent-keys.ts';

function must<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}
/** The concierge, with a tool that asks a helper agent on another provider. */
function conciergeRun() {
  const blank = setProfileType(createBlankDraft(), 'text', TEST_KEYS);
  const helper = {
    ...blank,
    identity: { ...blank.identity, agentId: 'travel.helper', handle: 'helper' },
    modelBindings: blank.modelBindings.map((binding) => ({
      ...binding,
      protocol: 'openRouter',
      provider: 'openrouter' as const,
      apiId: 'openrouter/free',
    })),
  };
  const workspace = addAgent(workspaceFromDraft(createExampleDraft()), helper);
  const [concierge, added] = workspace.agents;
  const draft = must(agentDraft(workspace, must(concierge).key));
  const tool = defaultToolSpec({
    toolName: 'ask_helper',
    toolType: 'agent',
    description: 'Asks the helper.',
    agentKey: must(added).key,
  });
  const compiled = compileWorkspace(
    withAgentDraft(workspace, must(concierge).key, {
      ...draft,
      toolSpecs: [...draft.toolSpecs, tool],
    }),
    ON_OWN_KEYS,
  );
  assert(compiled.ok, JSON.stringify(!compiled.ok && compiled.issues));
  return must(workspaceRunAgent(compiled, 'travel.concierge'));
}
/** The concierge asks the helper once, then says what came back; the helper answers. */
function providers(asked: string[]): StudioRuntime['provider'] {
  return (profile: Profile): TurnModel => {
    asked.push(profile.id);
    if (profile.id === 'travel.helper') {
      return {
        async *complete() {
          yield { type: 'text', text: 'From the helper.' };
        },
      };
    }
    let step = 0;
    return {
      async *complete() {
        step += 1;
        if (step === 1) {
          yield {
            type: 'tool',
            tool: { name: 'ask_helper', arguments: { text: 'Help?' }, callId: 'call_0' },
          };
          return;
        }
        yield { type: 'text', text: 'Done.' };
      },
    };
  };
}
async function run(runtime: StudioRuntime): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const line of streamStudioTurn({
    ...conciergeRun(),
    request: { input: { text: 'Hello' } },
    conversations: {
      sessionId: 'agent-run',
      store: createSealedConversationStore({ keys: { 1: newConversationKey() }, keyVersion: 1 }),
    },
    signal: new AbortController().signal,
    steer: createMemorySteerInbox(),
    runtime,
  })) {
    if (line.type !== 'trace' && line.type !== 'steer_inbox' && line.type !== 'conversation') {
      events.push(line);
    }
  }
  return events;
}
function toolPhase(events: TurnEvent[], phase: string) {
  return events.find(
    (event) => event.type === 'tool' && 'phase' in event.tool && event.tool.phase === phase,
  );
}
Deno.test('a called agent runs on a provider of its own', async () => {
  const asked: string[] = [];
  const events = await run({ mode: 'byok', provider: providers(asked) });
  assertEquals(asked, ['travel.concierge', 'travel.helper']);
  const complete = must(toolPhase(events, 'complete'));
  assert(complete.type === 'tool' && 'output' in complete.tool);
  assertEquals(complete.tool.output, { text: 'From the helper.' });
});
Deno.test('the runtime can refuse an agent call before it runs', async () => {
  const asked: string[] = [];
  const events = await run({
    mode: 'byok',
    provider: providers(asked),
    onAgentCall: () => ({ refuse: 'Spent.' }),
  });
  assertEquals(asked, ['travel.concierge']);
  const error = must(toolPhase(events, 'error'));
  assert(error.type === 'tool' && 'failure' in error.tool);
  assertEquals(
    [error.tool.failure.code, error.tool.failure.message],
    ['refused_by_host', 'Spent.'],
  );
});

Deno.test('a turn that fails sends its traces ahead of the failure, where the page still reads them', async () => {
  const lines: { type: string }[] = [];
  let failure: unknown;
  try {
    for await (const line of streamStudioTurn({
      ...conciergeRun(),
      request: { input: { text: 'Hello' } },
      conversations: {
        sessionId: 'agent-run',
        store: createSealedConversationStore({ keys: { 1: newConversationKey() }, keyVersion: 1 }),
      },
      signal: new AbortController().signal,
      steer: createMemorySteerInbox(),
      runtime: {
        mode: 'byok',
        provider: (): TurnModel => ({
          // biome-ignore lint/correctness/useYield: the model fails before it says anything.
          async *complete() {
            throw new Error('The model is down.');
          },
        }),
      },
    })) {
      lines.push(line);
    }
  } catch (err) {
    failure = err;
  }
  assert(failure instanceof Error, 'the turn fails');
  assert(
    lines.some((line) => line.type === 'trace'),
    `the failed turn left a trace: ${JSON.stringify(lines.map((line) => line.type))}`,
  );
});
