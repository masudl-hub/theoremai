import { assert } from '@std/assert';
import {
  geminiEmbeddings,
  geminiInteractions,
  ollamaEmbeddings,
  openRouterEmbeddings,
  openRouterOpenAi,
} from '../../src/providers/mod.ts';
import { protocolOptionFields } from '../../studio/providers.ts';

Deno.test('every protocol option says what it does', () => {
  for (const protocol of [
    geminiEmbeddings,
    geminiInteractions,
    ollamaEmbeddings,
    openRouterOpenAi,
    openRouterEmbeddings,
  ]) {
    for (const option of protocolOptionFields(protocol)) {
      assert(option.description, `${protocol.id}.${option.path} has no description`);
    }
  }
});
