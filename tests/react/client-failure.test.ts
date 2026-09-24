import { assertEquals } from '@std/assert';
import { lexiconDefault, TheoremError } from '../../mod.ts';
import { clientFailure, turnFailure } from '../../react/src/client/failure.ts';
import { TheoremStreamError } from '../../react/src/client/transport.ts';

Deno.test('clientFailure keeps the host wording of a stream failure', () => {
  assertEquals(clientFailure(new TheoremStreamError('rate_limit', 'Slow down.', 'HTTP 429')), {
    error: 'Slow down.',
    errorKind: 'rate_limit',
    errorInternal: 'HTTP 429',
  });
});

Deno.test('clientFailure words a stream failure without host wording from the lexicon', () => {
  assertEquals(clientFailure(new TheoremStreamError('timeout'), { 'error.timeout': 'Too slow.' }), {
    error: 'Too slow.',
    errorKind: 'timeout',
  });
  assertEquals(
    clientFailure(new TheoremStreamError('timeout')).error,
    lexiconDefault('error.timeout'),
  );
});

Deno.test('clientFailure words a local error for the user and keeps its detail for the builder', () => {
  const failure = clientFailure(new TheoremError('network', 'socket reset'), {
    'error.network': 'Offline.',
  });
  assertEquals(failure, { error: 'Offline.', errorKind: 'network', errorInternal: 'socket reset' });
});

Deno.test('clientFailure uses the error copy key when one is set', () => {
  const failure = clientFailure(
    new TheoremError('declined', 'user denied search', {
      copy: { key: 'session.tool_denied', params: { tool: 'search' } },
    }),
  );
  assertEquals(failure.errorKind, 'declined');
  assertEquals(failure.error, lexiconDefault('session.tool_denied', { tool: 'search' }));
});

Deno.test('turnFailure marks a stop as aborted', () => {
  const controller = new AbortController();
  controller.abort();
  assertEquals(
    turnFailure(new TheoremError('network', 'x'), undefined, controller.signal).aborted,
    true,
  );
  assertEquals(turnFailure(new TheoremError('cancelled', 'x')).aborted, true);
  assertEquals(turnFailure(new TheoremError('network', 'x')).aborted, undefined);
});
