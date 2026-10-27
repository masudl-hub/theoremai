import { assertEquals } from '@std/assert';
import type { ProfileDefinition, StageContext, TurnEvent, TurnModel } from '../../mod.ts';
import { memoryCredentialSource } from '../../src/kernel/auth/credential-source.ts';
import type { ToolCredential } from '../../src/kernel/auth/types.ts';
import { createHttpTransport } from '../../web/src/client/transport.ts';
import { createMemoryConversationStore, createTheoremHandler } from '../../web/src/server/mod.ts';
import { credentialsInOrder, stagesInOrder } from '../../web/src/server/turn-wiring.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

function profile(id: string): ProfileDefinition {
  return {
    type: 'text',
    id,
    identity: { handle: 'helper', system: 'profile persona' },
    models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: { detect: 'ignore' },
  };
}

/** Replies `text`, and keeps the system prompt of each request it got. */
function replying(text: string, systems: (string | undefined)[]): TurnModel {
  return {
    complete: (req) =>
      (async function* () {
        systems.push(req.system);
        yield { type: 'text' as const, text };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

async function turnOn(handler: (request: Request) => Promise<Response>): Promise<TurnEvent[]> {
  const transport = createHttpTransport({
    endpoint: 'http://host.test/api/theorem',
    fetch: (url, init) => handler(new Request(url, init)),
  });
  const events: TurnEvent[] = [];
  await transport.turn({ input: { text: 'hello' } }, (line) => {
    if (line.type !== 'conversation' && line.type !== 'unsupported' && line.type !== 'malformed') {
      events.push(line);
    }
  });
  return events;
}

const STAGE: StageContext = { stage: 'pre_turn', step: 1, history: [] };

Deno.test("a handler runs the application's own turn, given the application's context", async () => {
  const systems: (string | undefined)[] = [];
  const hosts: unknown[] = [];
  const handler = createTheoremHandler({
    profile: profile('wiring-system'),
    provider: () => fixtureHostOptions(replying('hi', systems)),
    conversationStore: createMemoryConversationStore(),
    host: () => ({ keeper: 'k1' }),
    prepare: (turn) => {
      hosts.push(turn.host);
      return { ...turn, system: 'the keeper waters on Sundays' };
    },
  });
  const events = await turnOn(handler);
  assertEquals(hosts, [{ keeper: 'k1' }]);
  assertEquals(systems[0]?.includes('the keeper waters on Sundays'), true);
  assertEquals(
    events.filter((event) => event.type === 'text').map((event) => event.text),
    ['hi'],
  );
});

Deno.test('a handler keeps its own profile whatever prepare returns', async () => {
  const systems: (string | undefined)[] = [];
  const handler = createTheoremHandler({
    profile: profile('wiring-kept'),
    provider: () => fixtureHostOptions(replying('kept', systems)),
    conversationStore: createMemoryConversationStore(),
    prepare: (turn) => ({ profile: 'someone-else', input: turn.input }),
  });
  const events = await turnOn(handler);
  assertEquals(
    events.filter((event) => event.type === 'text').map((event) => event.text),
    ['kept'],
  );
});

Deno.test("the application's stage handler goes first, and the handler's runs when it asks for nothing", async () => {
  const ran: string[] = [];
  const own = () => {
    ran.push('own');
    return { abort: true };
  };
  const quiet = stagesInOrder(() => {
    ran.push('app');
    return undefined;
  }, own);
  assertEquals(await quiet?.(STAGE), { abort: true });
  assertEquals(ran, ['app', 'own']);
  ran.length = 0;
  const acting = stagesInOrder(() => {
    ran.push('app');
    return { inject: [] };
  }, own);
  assertEquals(await acting?.(STAGE), { inject: [] });
  assertEquals(ran, ['app']);
});

Deno.test('credentials are read from the application first, and saved where the slot lives', async () => {
  const key = (value: string): ToolCredential => ({ type: 'api_key', key: value });
  const app = memoryCredentialSource({ github: key('app-token') });
  const session = memoryCredentialSource({ github: key('session-token'), notion: key('n1') });
  const both = credentialsInOrder(app, session);
  assertEquals(await both.get('github'), key('app-token'));
  assertEquals(await both.get('notion'), key('n1'));
  await both.set('github', key('refreshed'));
  await both.set('linear', key('signed-in'));
  assertEquals(await app.get('github'), key('refreshed'));
  assertEquals(await app.get('linear'), undefined);
  assertEquals(await session.get('linear'), key('signed-in'));
});
