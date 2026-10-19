/**
 * What the studio command has said of its read of the project so far, kept for the loader to draw.
 * The loader draws on its own clock, so it looks here each frame instead of being told.
 */
import type { ReadStep } from '../../read-steps.ts';

export interface Reading {
  /** Every step said so far, in order. The same list each time, longer. */
  steps(): readonly ReadStep[];
  /** Whether the project has arrived, so no step follows. */
  done(): boolean;
  say(step: ReadStep): void;
  finish(): void;
}

export function createReading(): Reading {
  const steps: ReadStep[] = [];
  let done = false;
  return {
    steps: () => steps,
    done: () => done,
    say: (step) => void steps.push(step),
    finish: () => {
      done = true;
    },
  };
}
