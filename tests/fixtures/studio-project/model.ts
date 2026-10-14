/**
 * The model every provider here reaches: it looks the city up once, then answers with what came
 * back; the decision model asks first. A request without its provider's key is refused, so a run
 * proves the key reached it.
 *
 * @module
 */

const KEYS: Record<string, string> = {
  'gateway.example': 'house-test-key',
  'left.example': 'pair-test-key',
  'api.typesafe.ai': 'spaced-test-key',
};

/** What the decision model answers: ask first. */
const DECIDED = {
  model: 'jev-1.13.0',
  answers: {
    next: { type: 'choice', choice: 'ask', confidence: 0.9, probabilities: { ask: 0.9, act: 0.1 } },
  },
  usage: { input_tokens: 10, output_tokens: 1 },
};

function events(...chunks: unknown[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** The model's turn: look the city up, then answer with what the lookup returned. */
function chat(body: BodyInit | null | undefined): Response {
  const { messages } = JSON.parse(String(body)) as { messages: { role: string; content?: unknown }[] };
  const result = messages.find((message) => message.role === 'tool');
  if (!result) {
    return events({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup_city', arguments: '{"city":"Lisbon"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  }
  return events(
    { choices: [{ delta: { content: `Found: ${JSON.stringify(result.content)}` }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, choices: [] },
  );
}

/** Why a request is refused before the model reads it: another host, or not its provider's key. */
function refused(url: URL, init?: RequestInit): Response | undefined {
  const key = KEYS[url.hostname];
  if (!key) return new Response('{"error":"not this host"}', { status: 404 });
  if (new Headers(init?.headers).get('authorization') === `Bearer ${key}`) return undefined;
  return new Response('{"error":{"message":"bad key"}}', { status: 401 });
}

export function scripted(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const answer = refused(url, init) ??
    (url.hostname === 'api.typesafe.ai' ? new Response(JSON.stringify(DECIDED)) : chat(init?.body));
  return Promise.resolve(answer);
}
