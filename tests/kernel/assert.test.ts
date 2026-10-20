import { assertThrows } from '@std/assert';
import {
  assertEquals as kernelAssertEquals,
  assertStringIncludes as kernelAssertStringIncludes,
  assertThrows as kernelAssertThrows,
} from '../../src/kernel/engine/assert.ts';

Deno.test('kernel engine assert utilities test all success and failure branches', () => {
  kernelAssertEquals({ a: 1 }, { a: 1 });
  assertThrows(() => kernelAssertEquals({ a: 1 }, { a: 2 }), Error, 'assertEquals failed');

  kernelAssertStringIncludes('hello world', 'world');
  assertThrows(
    () => kernelAssertStringIncludes('hello world', 'planet'),
    Error,
    'assertStringIncludes failed',
  );

  kernelAssertThrows(() => {
    throw new TypeError('invalid type');
  }, TypeError);

  assertThrows(
    () => {
      kernelAssertThrows(() => {
        // no-op
      }, Error);
    },
    Error,
    'assertThrows failed: expected Error',
  );

  assertThrows(
    () => {
      kernelAssertThrows(() => {
        throw new RangeError('out of range');
      }, TypeError);
    },
    RangeError,
    'out of range',
  );
});
