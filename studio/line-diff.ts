/**
 * Two texts as the lines one takes out and the other puts in, with the lines they share between.
 *
 * @module
 */

/** One line of a diff: shared, taken out or put in. */
export interface DiffLine {
  sign: ' ' | '-' | '+';
  text: string;
}

/**
 * `was` and `now` line by line. A line both hold in the same order is shared; the rest are taken
 * out of `was` or put in by `now`, the taken-out lines first where they meet.
 */
export function lineDiff(was: string, now: string): DiffLine[] {
  const [a, b] = [was.split('\n'), now.split('\n')];
  // The longest run of lines both hold, from each place to the end.
  const held = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      held[i]![j] = a[i] === b[j] ? held[i + 1]![j + 1]! + 1 : Math.max(held[i + 1]![j]!, held[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ sign: ' ', text: a[i]! });
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || held[i + 1]![j]! >= held[i]![j + 1]!)) {
      lines.push({ sign: '-', text: a[i]! });
      i += 1;
    } else {
      lines.push({ sign: '+', text: b[j]! });
      j += 1;
    }
  }
  return lines;
}
