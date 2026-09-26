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

/** `true` when `A` and `B` are identical; `false` otherwise. */
export type Equals<A, B> = Probe<A> extends Probe<B> ? true : false;
