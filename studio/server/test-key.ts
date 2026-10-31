/**
 * Asks a key's provider whether it accepts the key, with the check the provider's definition
 * declares, so the builder can tell a bad key from a bad setting. The key is used for this one
 * request: never logged, kept, or echoed back.
 *
 * @module
 */
import { checkKey, fetchGuarded, type ResolveHost, z } from '@theoremjs/agents';
import { clientError } from '@theoremjs/agents/host';
import { createProviderRegistry, type RegisteredProvider } from '@theoremjs/agents/kernel';
import { readBody } from '@theoremjs/web/server';
import { kernelDefinition, registerStudioProvider } from '../providers.ts';

const MAX_KEY_LENGTH = 512;

const slotName = z.string().min(1).max(128);

/** What the page sends: the key, and the provider a model reading its slot is served by. */
const testKeySchema = z
  .object({
    key: z.string().max(MAX_KEY_LENGTH),
    provider: z
      .object({
        id: z.string().min(1).max(128),
        definition: z.string().min(1).max(128),
        connection: z.record(z.string(), z.string().max(2048)).optional(),
        keySlot: slotName.optional(),
        fallbackKeySlot: slotName.optional(),
      })
      .strict(),
  })
  .strict();

export interface TestKeyOptions {
  /** The providers the project registers, some from definitions of its own. */
  projectProviders?: () => readonly RegisteredProvider[];
  /** Resolves the provider's host, so a check from a shared server reaches public addresses only. */
  resolveHost?: ResolveHost;
  /** The server is the builder's alone: the check reaches whatever the provider names. */
  draftNetwork?: boolean;
}

/** `POST <base>/test-key` `{ key, provider }`: a `KeyCheck`. */
export async function testKey(request: Request, options: TestKeyOptions = {}): Promise<Response> {
  let asked: z.infer<typeof testKeySchema>;
  try {
    asked = await readBody(request, testKeySchema);
  } catch (error) {
    return Response.json(clientError(error), { status: 400 });
  }
  let provider: RegisteredProvider | undefined;
  try {
    const definition = kernelDefinition(asked.provider.definition);
    provider = definition
      ? registerStudioProvider(createProviderRegistry(), asked.provider, definition)
      : options.projectProviders?.().find((each) => each.id === asked.provider.id);
  } catch (error) {
    return Response.json(clientError(error), { status: 400 });
  }
  if (!provider) return Response.json({ provider: asked.provider.id, state: 'unchecked' });
  const { resolveHost } = options;
  const guarded: typeof fetch = (url, init) =>
    fetchGuarded(
      String(url),
      { headers: init?.headers, signal: init?.signal },
      {
        followRedirects: false,
        ...(resolveHost ? { resolveHost } : {}),
      },
    );
  return Response.json(
    await checkKey(provider, {
      key: asked.key,
      ...(options.draftNetwork ? {} : { fetch: guarded }),
    }),
  );
}
