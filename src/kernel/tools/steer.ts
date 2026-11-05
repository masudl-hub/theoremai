import type { InjectUnit } from '../stages.ts';

/**
 * The steers a detached call was given and its agent's turn has not read yet. The call's handle
 * writes to it; its agent's turn lands what waits at a stage that takes an inject.
 *
 * invariant: A steer leaves the queue only when its message has joined the turn's history, or when
 * the call settles and the queue closes.
 */
export class SteerQueue {
  private units: InjectUnit[] = [];
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  /** Queues `text` as a user message with `id`; false once the queue is closed. */
  push(id: string, text: string): boolean {
    if (this.closed) return false;
    this.units.push({ id, messages: [{ role: 'user', content: text }] });
    return true;
  }

  /** What waits now, in the order it was given. */
  waiting(): readonly InjectUnit[] {
    return [...this.units];
  }

  /** `landed`, as `waiting` gave them, have joined the turn's history. */
  joined(landed: readonly InjectUnit[]): void {
    this.units = this.units.filter((unit) => !landed.includes(unit));
  }

  /** Closes the queue and gives the ids of the steers that never landed. */
  close(): string[] {
    this.closed = true;
    const unread = this.units.flatMap((unit) => (unit.id === undefined ? [] : [unit.id]));
    this.units = [];
    return unread;
  }
}
