import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../mod.ts';
import { readDecisionReply } from '../../react/src/client/decision-transport.ts';
import { readEmbeddingReply } from '../../react/src/client/embedding-transport.ts';

Deno.test('decision wire replies reject out-of-range probabilities and invalid usage', () => {
  const result = { model: 'span', answers: { q: { type: 'noul' as const, noul: 0.5 } } };
  for (const changed of [
    { ...result, answers: { q: { type: 'noul', noul: 2 } } },
    { ...result, model: '' },
    { ...result, usage: { inputTokens: -1, outputTokens: 2 } },
    { ...result, usage: { inputTokens: 1.5, outputTokens: 2 } },
    {
      ...result,
      answers: { q: { type: 'choice', choice: 'yes', confidence: 1.2, probabilities: { yes: 1 } } },
    },
    {
      ...result,
      answers: {
        q: { type: 'choice', choice: 'yes', confidence: 0.5, probabilities: { yes: 0.2 } },
      },
    },
  ])
    assertEquals(
      assertThrows(() => readDecisionReply({ result: changed }), TheoremError).kind,
      'bad_response',
    );
  assertEquals(readDecisionReply({ result }), { result });
});

Deno.test('embedding wire replies preserve vectors and reject malformed dimensions', () => {
  const result = {
    model: 'gemini-embedding-2-preview',
    embeddings: [{ index: 0, values: [0.25, -0.5], dimensions: 2 }],
  };
  assertEquals(readEmbeddingReply({ result }), { result });
  assertEquals(
    assertThrows(
      () =>
        readEmbeddingReply({
          result: { ...result, embeddings: [{ ...result.embeddings[0], dimensions: 0 }] },
        }),
      TheoremError,
    ).kind,
    'bad_response',
  );
  assertEquals(
    assertThrows(
      () =>
        readEmbeddingReply({
          result: { ...result, embeddings: [{ ...result.embeddings[0], dimensions: 3 }] },
        }),
      TheoremError,
    ).kind,
    'bad_response',
  );
});
