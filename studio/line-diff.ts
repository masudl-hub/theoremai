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
  // The longest run of lines both hold, from each place to the end, row after row.
  const width = b.length + 1;
  const held = new Array<number>((a.length + 1) * width).fill(0);
  const run = (i: number, j: number) => held[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      held[i * width + j] = a[i] === b[j] ? run(i + 1, j + 1) + 1 : Math.max(run(i + 1, j), run(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    const [out, put] = [a[i], b[j]];
    if (out !== undefined && out === put) {
      lines.push({ sign: ' ', text: out });
      i += 1;
      j += 1;
    } else if (out !== undefined && (put === undefined || run(i + 1, j) >= run(i, j + 1))) {
      lines.push({ sign: '-', text: out });
      i += 1;
    } else {
      lines.push({ sign: '+', text: put ?? '' });
      j += 1;
    }
  }
  return lines;
}
