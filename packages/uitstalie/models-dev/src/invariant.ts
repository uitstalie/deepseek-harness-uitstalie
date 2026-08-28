/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-models-dev`.
 * @module @deepseek-ai/dsh-models-dev/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-models-dev'

/** Cordis companion plugin name. */
export const name = 'models-dev-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the catalog is a read-through cache with no event
 * history; the only mutable relation (served data vs provenance) is set
 * atomically inside `adopt()`.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
