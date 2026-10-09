// @vitest-environment jsdom
/**
 * The overlay assembled from the real web roster. Each case hands the row an
 * explicit config through `provide` (the composition declares none), so the
 * spec covers activation, the insertion point, withdrawal, the shadowing
 * priority of a takeover, and the idle default.
 */
import { describe, expect } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { apply as applyOverlay } from '../src/client/index.ts'
import type { CommonViewConfig } from '../src/config.ts'

/** The roster row this package occupies. */
const SELF = '@deepseek-ai/dsh-client-common-view'

/** The adopted view's list cell. */
const SLOT = 'sidebar.workspaces.session.row.action'

/** Item ids the cell holds, in the ledger's render order. */
const idsIn = (c: { ctx: { slots: { entries(name: string): readonly { options: { id?: string } }[] } } }): (string | undefined)[] =>
  c.ctx.slots.entries(SLOT).map(entry => entry.options.id)

/** Item ids paired with their shadowing priority, in the ledger's render order. */
const cellIn = (
  c: { ctx: { slots: { entries(name: string): readonly { options: { id?: string; priority?: number } }[] } } },
): (string | number | undefined)[][] =>
  c.ctx.slots.entries(SLOT).map(entry => [entry.options.id, entry.options.priority ?? 0])

/** The whole roster's first boot pays the cold module transform of every plugin package. */
const BOOT_TIMEOUT_MS = 60_000

/**
 * A harness whose row carries `config`.
 * @param config - the overlay config the row receives.
 * @returns the harness `it`.
 */
function overlayTest(config: Partial<CommonViewConfig>) {
  return createClientTest({
    roster: webApp,
    provide: {
      [SELF]: {
        // The replacement keeps the plugin's own `inject` declaration: without
        // it the fiber has no `ctx.locale` and the row fails to activate.
        inject: ['slots', 'locale'],
        apply: (ctx) => { applyOverlay(ctx, config) },
      },
    },
  })
}

describe('common-view overlay on the assembled web roster', () => {
  const itMarker = overlayTest({ sessionRowAction: true })

  itMarker('activates and inserts its marker between the native archive and pin items', async ({ start }) => {
    const c = await start()
    expect(idsIn(c)).toEqual(['archive', 'common-view-marker', 'pin'])
  }, BOOT_TIMEOUT_MS)

  itMarker('withdraws the marker and leaves the native items untouched', async ({ start }) => {
    const c = await start()
    await c.unload(SELF)
    await c.flush()
    expect(idsIn(c)).toEqual(['archive', 'pin'])
  }, BOOT_TIMEOUT_MS)

  describe('with the takeover enabled', () => {
    const itTakeover = overlayTest({ takeoverArchive: true })

    itTakeover('shadows the archive item at a lower priority than the native one', async ({ start }) => {
      const c = await start()
      expect(cellIn(c)).toEqual([
        ['archive', -1],
        ['archive', 0],
        ['pin', 0],
      ])
    }, BOOT_TIMEOUT_MS)
  })

  describe('with nothing enabled', () => {
    const itIdle = overlayTest({})

    itIdle('contributes nothing, so the cell keeps exactly its native items', async ({ start }) => {
      const c = await start()
      expect(idsIn(c)).toEqual(['archive', 'pin'])
    }, BOOT_TIMEOUT_MS)
  })
})
