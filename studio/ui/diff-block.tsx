import type { DiffLine } from '../mod.ts';

const SIGN_LABEL = { ' ': undefined, '-': 'Removed', '+': 'Added' } as const;

/**
 * Two values as a unified diff, read as prose: removed lines red, added lines green, the lines
 * both share between. `sides` names what the `-` and the `+` lines each are, and `kept` is the
 * side that stands, so the other reads as set aside.
 */
export function DiffBlock({
  lines,
  sides,
  kept,
  maxHeight,
}: {
  lines: readonly DiffLine[];
  /** What the `-` lines and the `+` lines each are. */
  sides: { removed: string; added: string };
  kept: '-' | '+';
  maxHeight?: string;
}) {
  const count = (sign: DiffLine['sign']) => lines.filter((line) => line.sign === sign).length;
  return (
    <figure className="studio-diff" data-kept={kept}>
      <figcaption className="studio-diff-head">
        <span className="studio-diff-sides">
          <span data-sign="-">{`− ${sides.removed}`}</span>
          <span data-sign="+">{`+ ${sides.added}`}</span>
        </span>
        <span className="studio-diff-count">
          <span data-sign="+">{`+${String(count('+'))}`}</span>
          <span data-sign="-">{`−${String(count('-'))}`}</span>
        </span>
      </figcaption>
      <div className="studio-diff-lines" style={{ maxHeight }}>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no other identity
          <div key={index} className="studio-diff-line" data-sign={line.sign}>
            <span className="studio-diff-sign" role="img" aria-label={SIGN_LABEL[line.sign]}>
              {line.sign === '-' ? '−' : line.sign}
            </span>
            <code>{line.text || ' '}</code>
          </div>
        ))}
      </div>
    </figure>
  );
}
