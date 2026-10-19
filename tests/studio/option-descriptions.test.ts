import { assert } from '@std/assert';
import {
  geminiEmbedding,
  geminiInteractions,
  ollamaEmbedding,
  openRouter,
  openRouterEmbedding,
} from '../../src/providers/mod.ts';
import { protocolOptionFields } from '../../studio/providers.ts';

Deno.test('every protocol option says what it does', () => {
  for (const protocol of [
    geminiEmbedding,
    geminiInteractions,
    ollamaEmbedding,
    openRouter,
    openRouterEmbedding,
  ]) {
    for (const option of protocolOptionFields(protocol)) {
      assert(option.description, `${protocol.id}.${option.path} has no description`);
    }
  }
});
