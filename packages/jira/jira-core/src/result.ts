/**
 * core/result — the composition primitives.
 *
 * DESIGN.md §3.1 / decision 104: written by hand (≈30 lines of logic) so that `core`
 * stays free of third-party runtime dependencies, and so that the error model lines up
 * with decision 52's typed `{ code, message, context? }` values.
 *
 * Style rules this file obeys (§3.1, decision 102):
 *  - every exported symbol is a pure function of its arguments (no globals, no clock, no I/O);
 *  - every produced value is frozen, so "modify" always means "produce a new one";
 *  - nothing here knows about DSH, the filesystem, or the Jira domain.
 */

export type Ok<T> = Readonly<{ ok: true; value: T }>
export type Err<E> = Readonly<{ ok: false; error: E }>
/** A value or a typed error, never both: the composition primitive every core function returns. */
export type Result<T, E> = Ok<T> | Err<E>

/**
 * Wrap a success; the returned record is frozen.
 * @param value - the success value.
 * @returns the frozen `Ok` record.
 */
export const ok = <T>(value: T): Ok<T> => Object.freeze({ ok: true, value })
/**
 * Wrap a failure; the returned record is frozen.
 * @param error - the failure value.
 * @returns the frozen `Err` record.
 */
export const err = <E>(error: E): Err<E> => Object.freeze({ ok: false, error })

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok

/** Transform the success value; an error passes through untouched. */
export const map = <T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  result.ok ? ok(f(result.value)) : result

/** Transform the error; a success passes through untouched. */
export const mapErr = <T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> =>
  result.ok ? result : err(f(result.error))

/** Chain a second fallible step (the "then" of a `Result` pipeline). */
export const andThen = <T, U, E>(result: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> =>
  result.ok ? f(result.value) : result

/** Recover from an error, possibly producing a success. */
export const orElse = <T, E, F>(result: Result<T, E>, f: (error: E) => Result<T, F>): Result<T, F> =>
  result.ok ? result : f(result.error)

/** Read a success, or fall back. Never throws. */
export const unwrapOr = <T, E>(result: Result<T, E>, fallback: T): T =>
  result.ok ? result.value : fallback

/** All-or-nothing: the first error wins (strict path). */
export const collect = <T, E>(results: readonly Result<T, E>[]): Result<readonly T[], E> => {
  const values: T[] = []
  for (const result of results) {
    if (!result.ok) return result
    values.push(result.value)
  }
  return ok(Object.freeze(values))
}

/**
 * Tolerant counterpart of {@link collect} (decision 49/80: writes are strict, reads are
 * tolerant). Keeps the successes and reports every failure in order.
 */
export const partition = <T, E>(
  results: readonly Result<T, E>[],
): Readonly<{ values: readonly T[]; errors: readonly E[] }> => {
  const values: T[] = []
  const errors: E[] = []
  for (const result of results) {
    if (result.ok) values.push(result.value)
    else errors.push(result.error)
  }
  return Object.freeze({ values: Object.freeze(values), errors: Object.freeze(errors) })
}

/** Left-to-right composition. Overloads cover the arities we actually write. */
export function pipe<A, B>(a: A, f1: (a: A) => B): B
export function pipe<A, B, C>(a: A, f1: (a: A) => B, f2: (b: B) => C): C
export function pipe<A, B, C, D>(a: A, f1: (a: A) => B, f2: (b: B) => C, f3: (c: C) => D): D
export function pipe<A, B, C, D, E>(
  a: A,
  f1: (a: A) => B,
  f2: (b: B) => C,
  f3: (c: C) => D,
  f4: (d: D) => E,
): E
export function pipe(value: unknown, ...steps: readonly ((input: unknown) => unknown)[]): unknown {
  let current = value
  for (const step of steps) current = step(current)
  return current
}
