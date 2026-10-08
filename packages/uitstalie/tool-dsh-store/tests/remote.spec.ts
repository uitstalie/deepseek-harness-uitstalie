/**
 * Remote surface tests: the workspace-ownership check that guards every read,
 * and the display-path mapping the sidebar consumes.
 */
import { expect, test } from 'vitest'
import { join, resolve } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { storeRelativePath, storeRootOf } from '../src/index.ts'

test('refuses a workspace root the host does not own', () => {
  const known = [resolve('/work/alpha'), resolve('/work/beta')]
  try {
    storeRootOf(known, resolve('/work/gamma'))
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(RemoteError)
    expect((error as RemoteError).code).toBe('store/unknown-workspace')
    return
  }
  throw new Error('expected an unowned workspace root to be refused')
})

test('returns the store directory of an owned workspace', () => {
  const alpha = resolve('/work/alpha')
  expect(storeRootOf([alpha, resolve('/work/beta')], alpha)).toBe(join(alpha, '.dsh'))
})

test('accepts an owned root spelled differently', () => {
  const alpha = resolve('/work/alpha')
  expect(storeRootOf([alpha], join(alpha, '.'))).toBe(join(alpha, '.dsh'))
})

test('strips the store prefix from a loader display path', () => {
  expect(storeRelativePath('.dsh/rules/api.md')).toBe('rules/api.md')
  expect(storeRelativePath('rules/api.md')).toBe('rules/api.md')
})
