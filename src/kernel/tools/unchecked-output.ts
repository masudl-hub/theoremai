/**
 * A handler result with no type until the call runs, such as what a client
 * sent back. The tool's `output` schema checks the value when the call
 * settles, and a mismatch fails the call as `invalid_output`.
 */
export class UncheckedOutput {
  constructor(readonly value: unknown) {}
}

/**
 * Return a value the handler cannot type as the tool's `output`. A handler
 * that returns anything else must return `output`'s type, or it does not compile.
 */
export function uncheckedOutput(value: unknown): UncheckedOutput {
  return new UncheckedOutput(value);
}
