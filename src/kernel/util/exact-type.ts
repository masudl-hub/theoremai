/**
 * Compile-time proof that two types are the same, optional fields included.
 *
 * A published type is written by hand (JSR's `no-slow-types` forbids publishing
 * inferred types), and its zod schema is checked against it:
 *
 * ```ts
 * true satisfies Equals<z.infer<typeof turnStop>, TurnStop>;
 * ```
 *
 * A field in one and not the other fails the build.
 *
 * @module
 */

export type Probe<X> = <T>() => T extends X ? 1 : 2;

/** The keys of `T` a value may leave out. */
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

/** `T` with its own optional fields marked, one level down (see {@link Marked}). */
type MarkedOnce<T> = T extends object
  ? { [K in keyof T]-?: K extends OptionalKeys<T> ? { optional: T[K] } : T[K] }
  : T;

/**
 * `true` when `T` is identical to a type boxed in `Seen` (boxed, so a union
 * stays one entry). Its own optional fields are marked first, or a type would
 * pass for one it merely nests in.
 */
type IsSeen<T, Seen> = true extends (
  Seen extends [infer S]
    ? Probe<MarkedOnce<S>> extends Probe<MarkedOnce<T>>
      ? true
      : false
    : never
)
  ? true
  : false;

/**
 * `T` with every optional field marked, all the way down. The identity check
 * behind `Probe` ignores whether a field is optional, so a field only one side
 * leaves out would pass it unmarked. A type met again inside itself (a
 * recursive type) is compared as it is, where it recurs.
 */
type Marked<T, Seen = never> = IsSeen<T, Seen> extends true ? T : MarkedEach<T, Seen | [T]>;

type MarkedEach<T, Seen> = T extends (...args: never[]) => unknown
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

/** `true` when `A` and `B` are identical, optional fields included; `false` otherwise. */
export type Equals<A, B> = Probe<Marked<A>> extends Probe<Marked<B>> ? true : false;
