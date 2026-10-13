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

/** The most dots a line carries. */
export const MAP_DOTS = 8;

/** `count` dots, no more than a line carries, spread evenly along `at` and clear of both its ends. */
export function mapDots(at: (t: number) => MapPlace, count: number): MapPlace[] {
  const dots = Math.min(count, MAP_DOTS);
  return Array.from({ length: dots }, (_, index) => at((index + 1) / (dots + 1)));
}
