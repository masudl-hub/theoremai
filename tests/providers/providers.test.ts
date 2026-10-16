import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  callProtocol,
  checkBinding,
  createProviderRegistry,
} from '../../src/kernel/protocols/mod.ts';
import type { Authorize } from '../../src/kernel/protocols/provider.ts';
import type { JsonObject } from '../../src/kernel/provider-contract.ts';
import { geminiProvider } from '../../src/providers/gemini/provider.ts';
import { localProvider } from '../../src/providers/local/provider.ts';
import { openRouterProvider } from '../../src/providers/openrouter/provider.ts';
import { typesafeProvider } from '../../src/providers/typesafe/provider.ts';

interface Sent {
  url: string;
  headers: Headers;
}

function capture(reply: () => Response) {
  const sent: Sent[] = [];
  const send: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers) });
    return reply();
  };
  return { sent, send };
}

const chatReply = () =>
  Response.json({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });

async function chat(
  registry: ReturnType<typeof createProviderRegistry>,
  id: string,
  protocol: string,
  vault: Record<string, string>,
): Promise<Sent> {
  const provider = registry.require(id, 'm');
  const { sent, send } = capture(chatReply);
  const call = callProtocol({
    provider,
    binding: checkBinding(provider, { protocol, provider: id, apiId: 'm' }, 'text'),
    profileType: 'text',
    vault,
    fetch: send,
    wait: async () => {},
  });
  const request = {
    apiId: 'm',
    stream: false,
    input: [{ type: 'text', text: 'hello' }],
    builtins: [],
    structured: null,
    image: null,
  } as unknown as Parameters<typeof call.complete>[0];
  for await (const _ of call.complete(request));
  return sent[0] as Sent;
}

async function decide(
  registry: ReturnType<typeof createProviderRegistry>,
  id: string,
): Promise<{ sent: Sent; usage: JsonObject | undefined }> {
  const provider = registry.require(id, 'jev-1');
  const { sent, send } = capture(() =>
    Response.json({
      model: 'jev-1',
      answers: {},
      usage: { input_tokens: 1_000_000, output_tokens: 9 },
    }),
  );
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'systemOne', provider: id, apiId: 'jev-1' },
      'decision',
    ),
    profileType: 'decision',
    vault: { main: 'k-main' },
    fetch: send,
    wait: async () => {},
  });
  const result = await call.decide({
    apiId: 'jev-1',
    state: {},
    questions: {},
  } as unknown as Parameters<typeof call.decide>[0]);
  return { sent: sent[0] as Sent, usage: result.usage as JsonObject | undefined };
}

Deno.test('OpenRouter serves chat, images and decisions at its defaults, signed with a bearer key', async () => {
  const registry = createProviderRegistry();
  registry.register(openRouterProvider, { keySlot: 'main' });
  assertEquals(
    registry
      .protocols()
      .map((protocol) => protocol.id)
      .sort(),
    ['openAi', 'openRouter', 'openRouterImages', 'systemOne'],
  );
  const sent = await chat(registry, 'openrouter', 'openRouter', { main: 'k-main' });
  assertEquals(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assertEquals(sent.headers.get('authorization'), 'Bearer k-main');
  assertEquals(sent.headers.get('http-referer'), null);
  const decision = await decide(registry, 'openrouter');
  assertEquals(decision.sent.url, 'https://openrouter.ai/api/alpha/decisions');
  assertEquals(decision.sent.headers.get('authorization'), 'Bearer k-main');
});

Deno.test('OpenRouter sends the site for its rankings and goes where the connection says', async () => {
  const registry = createProviderRegistry();
  registry.register(openRouterProvider, {
    keySlot: 'main',
    connection: {
      baseUrl: 'https://gateway.test/v1',
      decisionUrl: 'https://gateway.test/decide',
      siteUrl: 'https://theorem.test',
      siteName: 'Theorem',
    },
  });
  const sent = await chat(registry, 'openrouter', 'openRouter', { main: 'k-main' });
  assertEquals(sent.url, 'https://gateway.test/v1/chat/completions');
  assertEquals(sent.headers.get('http-referer'), 'https://theorem.test');
  assertEquals(sent.headers.get('x-title'), 'Theorem');
  assertEquals((await decide(registry, 'openrouter')).sent.url, 'https://gateway.test/decide');
});

Deno.test('a connection URL with credentials in it is refused', () => {
  const registry = createProviderRegistry();
  for (const baseUrl of [
    'https://user:pass@gateway.test/v1',
    'https://gateway.test/v1?api_key=x',
    'ftp://gateway.test',
  ])
    assertThrows(
      () => registry.register(openRouterProvider, { connection: { baseUrl } }),
      TheoremError,
      'invalid connection',
    );
});

Deno.test('TypeSafe answers decisions at its API and prices Jev where the API reports no cost', async () => {
  const registry = createProviderRegistry();
  registry.register(typesafeProvider, { keySlot: 'main' });
  const { sent, usage } = await decide(registry, 'typesafe');
  assertEquals(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assertEquals(usage, { inputTokens: 1_000_000, outputTokens: 9, costUsd: 0.042, estimated: true });
  const provider = registry.require('typesafe', 'jev-1');
  assertThrows(
    () =>
      checkBinding(
        provider,
        { protocol: 'systemOne', provider: 'typesafe', apiId: 'jev-1' },
        'text',
      ),
    TheoremError,
  );
});

Deno.test('a local server needs its address, and takes a key only when one is named', async () => {
  const registry = createProviderRegistry();
  assertThrows(() => registry.register(localProvider), TheoremError, 'invalid connection');
  registry.register(localProvider, {
    id: 'ollama',
    connection: { baseUrl: 'http://localhost:11434/v1' },
  });
  const open = await chat(registry, 'ollama', 'openAi', {});
  assertEquals(open.url, 'http://localhost:11434/v1/chat/completions');
  assertEquals(open.headers.get('authorization'), null);
  registry.register(localProvider, {
    id: 'vllm',
    keySlot: 'vllm',
    connection: { baseUrl: 'http://gpu.lan:8000/v1' },
  });
  const signed = await chat(registry, 'vllm', 'openAi', { vllm: 'k-vllm' });
  assertEquals(signed.headers.get('authorization'), 'Bearer k-vllm');
  await assertRejects(() => chat(registry, 'vllm', 'openAi', {}), TheoremError, 'vllm');
});

Deno.test('OpenRouter, TypeSafe and a local server share one registry and its protocols', () => {
  const registry = createProviderRegistry();
  registry.register(openRouterProvider, { keySlot: 'main' });
  registry.register(typesafeProvider, { keySlot: 'typesafe' });
  registry.register(localProvider, { connection: { baseUrl: 'http://localhost:11434/v1' } });
  assertEquals(
    registry
      .protocols()
      .map((protocol) => protocol.id)
      .sort(),
    ['openAi', 'openRouter', 'openRouterImages', 'systemOne'],
  );
});

Deno.test('Gemini signs Interactions with its key header and Live with the key in the query', async () => {
  const registry = createProviderRegistry();
  registry.register(geminiProvider, { keySlot: 'main' });
  const sent = await chat(registry, 'gemini', 'geminiInteractions', { main: 'k-main' });
  assertEquals(sent.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assertEquals(sent.headers.get('x-goog-api-key'), 'k-main');
  const live = registry.require('gemini', 'm').serves.find((s) => s.protocol.id === 'geminiLive');
  assertEquals(live?.baseUrl, 'wss://generativelanguage.googleapis.com/ws');
  const outgoing = {
    transport: 'ws' as const,
    url: new URL(`${live?.baseUrl}/x`),
    headers: new Headers(),
    protocols: [],
  };
  const authorize = live?.authorize as Authorize<string>;
  await authorize('k-main').sign(outgoing);
  assertEquals(outgoing.url.searchParams.get('key'), 'k-main');
  assertEquals(outgoing.headers.get('x-goog-api-key'), null);
  registry.register(geminiProvider, {
    id: 'proxied',
    connection: { host: 'https://gemini.gateway.test' },
  });
  assertEquals(
    registry.require('proxied', 'm').serves.map((serve) => serve.baseUrl),
    ['https://gemini.gateway.test/v1beta', 'wss://gemini.gateway.test/ws'],
  );
});
