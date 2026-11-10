import type { ToolFailure } from '../turn-events.ts';

/** A failure a tool states itself: the person's wording (`error`) is added where the event reaches the host. */
export type StatedToolFailure = Omit<ToolFailure, 'error'>;

/**
 * Thrown by a handler whose call ran and did not do what it was asked. The call settles as
 * `failure`, under its own `code` and `kind`, and the model reads it; any other throw is a
 * `handler_error`.
 */
export class ToolFailed extends Error {
  readonly failure: StatedToolFailure;

  constructor(failure: StatedToolFailure) {
    super(failure.message);
    this.name = 'ToolFailed';
    this.failure = failure;
  }
}
