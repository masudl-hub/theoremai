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

/**
 * A line that runs level from `from` to `rail`, straight up or down it, and level to `to`, its
 * corners turned like the tree's own; `square` from 0 to 1 takes it there from `mapCurve`'s line,
 * one shape the whole way.
 */
export function mapBend(
  from: MapPlace,
  to: MapPlace,
  rail: number,
  radius: number,
  square: number,
): string {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  // why: Halved where it turns, `mapCurve`'s line is these eight points; so is the rail's, each
  // corner a quarter turn of the tree's own quadratic, so each point moves straight to its own.
  const curve: MapPlace[] = [
    from,
    { x: (from.x + mid.x) / 2, y: from.y },
    { x: (from.x + 3 * mid.x) / 4, y: (3 * from.y + to.y) / 4 },
    mid,
    mid,
    { x: (3 * mid.x + to.x) / 4, y: (from.y + 3 * to.y) / 4 },
    { x: (mid.x + to.x) / 2, y: to.y },
    to,
  ];
  const along = Math.sign(to.x - from.x) || 1;
  const up = Math.sign(to.y - from.y);
  const round = Math.max(
    0,
    Math.min(radius, Math.abs(to.y - from.y) / 2, Math.abs(rail - from.x), Math.abs(to.x - rail)),
  );
  const railed: MapPlace[] = [
    { x: rail - along * round, y: from.y },
    { x: rail - (along * round) / 3, y: from.y },
    { x: rail, y: from.y + (up * round) / 3 },
    { x: rail, y: from.y + up * round },
    { x: rail, y: to.y - up * round },
    { x: rail, y: to.y - (up * round) / 3 },
    { x: rail + (along * round) / 3, y: to.y },
    { x: rail + along * round, y: to.y },
  ];
  const [a, b, c, d, e, f, g, h] = curve.map((point, index) => {
    const end = railed[index] ?? point;
    return `${point.x + (end.x - point.x) * square} ${point.y + (end.y - point.y) * square}`;
  });
  return `M ${from.x} ${from.y} L ${a} C ${b}, ${c}, ${d} L ${e} C ${f}, ${g}, ${h} L ${to.x} ${to.y}`;
}

/**
 * `mapBend`'s line with steps aside on the way: level from `from` to each step's x, up or down to
 * its y, and on. `square` grows the steps out of `from`, so at 0 it is `mapCurve`'s line.
 */
export function mapRoute(
  from: MapPlace,
  to: MapPlace,
  steps: readonly MapPlace[],
  rail: number,
  radius: number,
  square: number,
): string {
  if (steps.length === 0) return mapBend(from, to, rail, radius, square);
  const grown = (point: MapPlace) => ({
    x: from.x + (point.x - from.x) * square,
    y: from.y + (point.y - from.y) * square,
  });
  const corners = steps.map(grown).flatMap((step, index) => {
    const before = index === 0 ? from : grown(steps[index - 1] ?? from);
    return [{ x: step.x, y: before.y }, step];
  });
  const last = corners[corners.length - 1] ?? from;
  // The steps hand over level, halfway to the rail, where the last bend starts.
  const handover = { x: last.x + (grown({ x: rail, y: 0 }).x - last.x) / 2, y: last.y };
  const points = [from, ...corners, handover];
  let d = `M ${from.x} ${from.y}`;
  points.slice(1, -1).forEach((corner, index) => {
    const before = points[index] ?? corner;
    const after = points[index + 2] ?? corner;
    const into = Math.hypot(corner.x - before.x, corner.y - before.y);
    const out = Math.hypot(after.x - corner.x, after.y - corner.y);
    const round = Math.min(radius, into / 2, out / 2);
    if (round <= 0) {
      d += ` L ${corner.x} ${corner.y}`;
      return;
    }
    const enter = {
      x: corner.x - ((corner.x - before.x) / into) * round,
      y: corner.y - ((corner.y - before.y) / into) * round,
    };
    const leave = {
      x: corner.x + ((after.x - corner.x) / out) * round,
      y: corner.y + ((after.y - corner.y) / out) * round,
    };
    d += ` L ${enter.x} ${enter.y} Q ${corner.x} ${corner.y}, ${leave.x} ${leave.y}`;
  });
  return d + mapBend(handover, to, rail, radius, square).replace(/^M \S+ \S+/, '');
}
