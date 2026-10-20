import { assertEquals } from '@std/assert';
import { TheoremError } from '../../mod.ts';

/**
 * A value that must be a `malformed` event: left out as `bad_response`, the
 * user reading `session.part_skipped`, its message naming what broke and never
 * the value (`secret-value` in these tests). Returns the message.
 */
export function assertMalformed(value: { type: string }): string {
  assertEquals(value.type, 'malformed');
  const error = 'error' in value ? value.error : undefined;
  if (!(error instanceof TheoremError)) throw new Error('a malformed event carries its error');
  assertEquals(error.kind, 'bad_response');
  assertEquals(error.copy, { key: 'session.part_skipped' });
  assertEquals(error.message.includes('secret-value'), false);
  return error.message;
}
