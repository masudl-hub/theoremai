export interface MapPlace {
  x: number;
  y: number;
}

export interface MapCurve {
  d: string;
  /** The point `t` of the way along, from 0 to 1. */
  at(t: number): MapPlace;
}

/**
 * The line every map draws between two nodes: level as it leaves and as it arrives, turning at
 * `via`, which is halfway between them unless said.
 */
export function mapCurve(from: MapPlace, to: MapPlace, via = (from.x + to.x) / 2): MapCurve {
  return {
    d: `M ${from.x} ${from.y} C ${via} ${from.y}, ${via} ${to.y}, ${to.x} ${to.y}`,
    at(t) {
      const u = 1 - t;
      return {
        x: u * u * u * from.x + 3 * u * t * via + t * t * t * to.x,
        y: (u * u * u + 3 * u * u * t) * from.y + (3 * u * t * t + t * t * t) * to.y,
      };
    },
  };
}

/**
 * A line that runs level from `from` to `turn.from`, turns between there and `turn.to`, and runs
 * level to `to`. Lines that share an end and a turn run as one until they part.
 */
export function mapTrunk(from: MapPlace, to: MapPlace, turn: { from: number; to: number }): MapCurve {
  const bend = mapCurve({ x: turn.from, y: from.y }, { x: turn.to, y: to.y });
  const lead = Math.abs(turn.from - from.x);
  const tail = Math.abs(to.x - turn.to);
  const length = lead + Math.abs(turn.to - turn.from) + tail;
  return {
    d: `M ${from.x} ${from.y}${lead > 0 ? ` L ${turn.from} ${from.y}` : ''}${bend.d.slice(bend.d.indexOf(' C'))}${tail > 0 ? ` L ${to.x} ${to.y}` : ''}`,
    at(t) {
      const run = t * length;
      if (run < lead) return { x: from.x + Math.sign(turn.from - from.x) * run, y: from.y };
      if (run > length - tail) return { x: to.x - Math.sign(to.x - turn.to) * (length - run), y: to.y };
      return bend.at((run - lead) / (length - lead - tail));
    },
  };
}

/**
 * A line that runs level from `from` to `rail`, straight up or down it, and level to `to`, its two
 * corners rounded by `radius`. Lines that share an end and a rail are one line along both.
 */
export function mapRail(from: MapPlace, to: MapPlace, rail: number, radius: number): MapCurve {
  const lead = Math.abs(rail - from.x);
  const rise = Math.abs(to.y - from.y);
  const tail = Math.abs(to.x - rail);
  const length = lead + rise + tail;
  const along = Math.sign(to.x - from.x);
  const up = Math.sign(to.y - from.y);
  const round = Math.min(radius, rise / 2, lead, tail);
  const corners =
    ` L ${rail - along * round} ${from.y} Q ${rail} ${from.y}, ${rail} ${from.y + up * round}` +
    ` L ${rail} ${to.y - up * round} Q ${rail} ${to.y}, ${rail + along * round} ${to.y}`;
  return {
    d: `M ${from.x} ${from.y}${round > 0 ? corners : ''} L ${to.x} ${to.y}`,
    at(t) {
      const run = t * length;
      if (run < lead) return { x: from.x + along * run, y: from.y };
      if (run > lead + rise) return { x: to.x - along * (length - run), y: to.y };
      return { x: rail, y: from.y + up * (run - lead) };
    },
  };
}
