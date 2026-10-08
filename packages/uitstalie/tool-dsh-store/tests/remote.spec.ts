/**
 * Remote surface tests: the workspace-ownership check that guards every read,
 * and the display-path mapping the sidebar consumes.
 */
import { expect, test } from 'vitest'
import { join, resolve } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { storeRelativePath, storeRootOfWorkspace, workspaceRootOf } from '../src/index.ts'

test('refuses a workspace identity the host does not know', () => {
  try {
    storeRootOfWorkspace(undefined, 'unknown-id')
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(RemoteError)
    expect((error as RemoteError).code).toBe('store/unknown-workspace')
    return
  }
  throw new Error('expected an unknown workspace identity to be refused')
})

test('resolves the store directory of a known workspace', () => {
  const alpha = resolve('/work/alpha')
  expect(workspaceRootOf({ path: alpha }, 'alpha-id')).toBe(alpha)
  expect(storeRootOfWorkspace({ path: alpha }, 'alpha-id')).toBe(join(alpha, '.dsh'))
})

test('strips the store prefix from a loader display path', () => {
  expect(storeRelativePath('.dsh/rules/api.md')).toBe('rules/api.md')
  expect(storeRelativePath('rules/api.md')).toBe('rules/api.md')
})
