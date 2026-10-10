export type Probe<X> = <T>() => T extends X ? 1 : 2;

export type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

export type MarkedOnce<T> = T extends object
  ? { [K in keyof T]-?: K extends OptionalKeys<T> ? { optional: T[K] } : T[K] }
  : T;

/**
 * Boxed in `Seen` so a union stays one entry. `T`'s own optional fields are marked first,
 * or a type would pass for one it merely nests in.
 */
export type IsSeen<T, Seen> = true extends (
  Seen extends [infer S]
    ? Probe<MarkedOnce<S>> extends Probe<MarkedOnce<T>>
      ? true
      : false
    : never
)
  ? true
  : false;

/**
 * The identity check behind `Probe` ignores optionality, so a field only one side leaves out
 * would pass unmarked. A recursive type is compared as it is where it recurs.
 */
export type Marked<T, Seen = never> = IsSeen<T, Seen> extends true ? T : MarkedEach<T, Seen | [T]>;

export type MarkedEach<T, Seen> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { [I in keyof T]: Marked<T[I], Seen> }
    : T extends object
      ? {
          [K in keyof T]-?: K extends OptionalKeys<T>
            ? { optional: Marked<T[K], Seen> }
            : Marked<T[K], Seen>;
        }
      : T;

/**
 * JSR's `no-slow-types` forbids publishing inferred types, so a hand-written type is checked
 * against its schema: `true satisfies Equals<z.infer<typeof turnStop>, TurnStop>;`.
 */
export type Equals<A, B> = Probe<Marked<A>> extends Probe<Marked<B>> ? true : false;
