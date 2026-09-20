#!/usr/bin/env -S deno run --allow-net

import type { ProviderCompleteRequest } from '../src/kernel/types.ts';
import { createOpenRouterProvider } from '../src/providers/openrouter/chat.ts';

function valueAfterFlag(flag: string): string | undefined {
  const idx = Deno.args.indexOf(flag);
  if (idx < 0) {
    return undefined;
  }
  return Deno.args[idx + 1];
}

const apiKey = valueAfterFlag('--api-key');
const model = valueAfterFlag('--model') ?? 'sonar';
const apiId = valueAfterFlag('--api-id') ?? 'perplexity/sonar';

if (!apiKey) {
  Deno.stdout.writeSync(
    new TextEncoder().encode(
      'Error: missing --api-key.\n' +
        'Theorem does not read environment variables; pass credentials from the host app or local wrapper.\n',
    ),
  );
  Deno.exit(1);
}

Deno.stdout.writeSync(
  new TextEncoder().encode('Testing Theorem OpenRouter provider connection...\n'),
);

const provider = createOpenRouterProvider({
  apiKey,
  siteUrl: 'https://theorem.agent',
  siteName: 'Theorem Provider Smoke',
});

const req: ProviderCompleteRequest = {
  model,
  apiId,
  thinking: 'low',
  summaries: undefined,
  maxOutputTokens: 200,
  temperature: 0.2,
  system: 'You are a precise agent kernel verification assistant.',
  input: [
    {
      type: 'text',
      text: 'Verify live streaming: Return "Theorem + OpenRouter live stream verified successfully."',
    },
  ],
  builtins: [],
  structured: null,
  image: null,
};

try {
  let tokenCount = 0;

  for await (const event of provider.complete(req)) {
    if (event.type === 'thought' && event.text) {
      Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[33m${event.text}\x1b[0m`));
    } else if (event.type === 'text' && event.text) {
      Deno.stdout.writeSync(new TextEncoder().encode(event.text));
    } else if (event.type === 'tokens' && event.tokens) {
      tokenCount = event.tokens.total;
    } else if (event.type === 'error') {
      Deno.stderr.writeSync(
        new TextEncoder().encode(`\nReceived error event from provider: ${event.error}\n`),
      );
    }
  }

  Deno.stdout.writeSync(
    new TextEncoder().encode(`\n---\nLive test finished. Total tokens recorded: ${tokenCount}\n`),
  );
} catch (err) {
  Deno.stderr.writeSync(
    new TextEncoder().encode(`Live test failed with exception: ${String(err)}\n`),
  );
  Deno.exit(1);
}
