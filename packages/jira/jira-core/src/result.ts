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
/** A failure carrying the typed error; the counterpart of {@link Ok}. */
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

/**
 * Narrow a result to its success side.
 * @param result - the result to test.
 * @returns true when it succeeded, narrowing the type to `Ok`.
 */
export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok
/**
 * Narrow a result to its failure side.
 * @param result - the result to test.
 * @returns true when it failed, narrowing the type to `Err`.
 */
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok

/**
 * Transform the success value; an error passes through untouched.
 * @param result - the result to map.
 * @param f - the function to apply to the success value.
 * @returns a result carrying the mapped value, or the original error.
 */
export const map = <T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  result.ok ? ok(f(result.value)) : result

/**
 * Transform the error; a success passes through untouched.
 * @param result - the result to map.
 * @param f - the function to apply to the error value.
 * @returns the original success, or a result carrying the mapped error.
 */
export const mapErr = <T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> =>
  result.ok ? result : err(f(result.error))

/**
 * Chain a second fallible step (the "then" of a `Result` pipeline).
 * @param result - the first step's result.
 * @param f - the next step, applied only to a success.
 * @returns the next step's result, or the first error.
 */
export const andThen = <T, U, E>(result: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> =>
  result.ok ? f(result.value) : result

/**
 * Recover from an error, possibly producing a success.
 * @param result - the result to recover.
 * @param f - the recovery step, applied only to a failure.
 * @returns the original success, or the recovery step's result.
 */
export const orElse = <T, E, F>(result: Result<T, E>, f: (error: E) => Result<T, F>): Result<T, F> =>
  result.ok ? result : f(result.error)

/**
 * Read a success, or fall back. Never throws.
 * @param result - the result to read.
 * @param fallback - the value to use when it failed.
 * @returns the success value, or the fallback.
 */
export const unwrapOr = <T, E>(result: Result<T, E>, fallback: T): T =>
  result.ok ? result.value : fallback

/**
 * All-or-nothing: the first error wins (strict path).
 * @param results - the results to collect.
 * @returns every success value in order, or the first error.
 */
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
 * @param results - the results to partition.
 * @returns the successes and the errors, each in the order they were seen.
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

/**
 * Left-to-right composition. Overloads cover the arities we actually write.
 * @param a - the value passed to the first step.
 * @param f1 - the first step.
 * @returns the first step's result.
 */
export function pipe<A, B>(a: A, f1: (a: A) => B): B
/**
 * Left-to-right composition over two steps.
 * @param a - the value passed to the first step.
 * @param f1 - the first step.
 * @param f2 - the second step.
 * @returns the second step's result.
 */
export function pipe<A, B, C>(a: A, f1: (a: A) => B, f2: (b: B) => C): C
/**
 * Left-to-right composition over three steps.
 * @param a - the value passed to the first step.
 * @param f1 - the first step.
 * @param f2 - the second step.
 * @param f3 - the third step.
 * @returns the third step's result.
 */
export function pipe<A, B, C, D>(a: A, f1: (a: A) => B, f2: (b: B) => C, f3: (c: C) => D): D
/**
 * Left-to-right composition over four steps.
 * @param a - the value passed to the first step.
 * @param f1 - the first step.
 * @param f2 - the second step.
 * @param f3 - the third step.
 * @param f4 - the fourth step.
 * @returns the fourth step's result.
 */
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
