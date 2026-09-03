/* jscpd:ignore-start */
/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-models-dev`.
 * @module @deepseek-ai/dsh-client-ui-models-dev/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-models-dev'

/** Cordis companion plugin name. */
export const name = 'client-ui-models-dev-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a settings-section-only plugin whose page state is
 * derived from the catalog Remote and the settings document — it owns no
 * independent mutable relation beyond its store, which is recreated per mount.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
