/**
 * What the page under the loading mark is still bringing in. A piece of the screen the page opens on
 * holds the mark until it is on screen, and the mark gives way once every hold has settled. Once
 * they have, a new hold does nothing: the page is already shown.
 */

/** The longest a piece of a screen holds the mark. A hung piece must not keep the page from showing. */
export const HOLD_CAP_MS = 6000;

export interface BootHolds {
  /** Holds the mark until `work` settles. A failed piece still lets the page show. */
  hold(work: Promise<unknown>): void;
  /** Holds the mark until the returned function is called. */
  holdUntil(): () => void;
  /**
   * Settles once the page's holds have. It waits for `gathered` first, so the page has had its
   * turn to hold; a hold made while it waits is waited on too.
   */
  settled(gathered: Promise<unknown>): Promise<void>;
}

export function createBootHolds(): BootHolds {
  const holds: Promise<void>[] = [];
  let open = true;

  const hold = (work: Promise<unknown>) => {
    if (!open) return;
    holds.push(
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
  };

  return {
    hold,
    holdUntil() {
      let release = () => {};
      hold(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => release();
    },
    async settled(gathered) {
      await gathered;
      let seen = -1;
      while (holds.length > seen) {
        seen = holds.length;
        await Promise.all(holds);
      }
      open = false;
      holds.length = 0;
    },
  };
}

/** The page's holds: the website's screens and the studio's page both hold the one mark. */
export const bootHolds: BootHolds = createBootHolds();
