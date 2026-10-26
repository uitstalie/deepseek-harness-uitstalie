/**
 * `.dsh/` 路径拒绝矩阵的单测：逐行覆盖矩阵，并钉住归一化与包含判定。
 */
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import {
  DEFAULT_STORE_PATH_LIMITS,
  isPathInside,
  normalizeStorePath,
  resolveStoreTarget,
  StorePathError,
  type StorePathRejection,
} from '../src/paths.ts'

/** 断言某个输入以指定原因被拒绝。 */
function rejects(input: string, reason: StorePathRejection, limits = DEFAULT_STORE_PATH_LIMITS): void {
  try {
    normalizeStorePath(input, limits)
  } catch (error: unknown) {
    expect(error, `expected ${JSON.stringify(input)} to be rejected`).toBeInstanceOf(StorePathError)
    expect((error as StorePathError).reason).toBe(reason)
    return
  }
  throw new Error(`expected ${JSON.stringify(input)} to be rejected`)
}

test('normalizes separators, dot segments, and repeated separators', () => {
  expect(normalizeStorePath('rules/api.md').segments).toEqual(['rules', 'api.md'])
  expect(normalizeStorePath('rules//api.md').displayPath).toBe('rules/api.md')
  expect(normalizeStorePath('./rules/./api.md').displayPath).toBe('rules/api.md')
  expect(normalizeStorePath('rules\\api.md').displayPath).toBe('rules/api.md')
  expect(normalizeStorePath('  rules/api.md  ').displayPath).toBe('rules/api.md')
  expect(normalizeStorePath('rules/nested/../api.md').displayPath).toBe('rules/api.md')
})

test('treats the empty path and its spellings as the root', () => {
  for (const input of ['', '   ', '.', './', './/']) {
    expect(normalizeStorePath(input).segments).toEqual([])
    expect(normalizeStorePath(input).displayPath).toBe('')
  }
})

test('rejects every absolute spelling on every platform', () => {
  rejects('/etc/passwd', 'absolute')
  rejects('\\windows\\system32', 'absolute')
  rejects('\\\\server\\share\\file', 'absolute')
  rejects('C:\\Users\\me', 'absolute')
  rejects('c:/users/me', 'absolute')
})

test('rejects directory escapes but folds benign dot segments', () => {
  rejects('..', 'escape')
  rejects('../secrets', 'escape')
  rejects('rules/../../secrets', 'escape')
})

test('rejects expansion spellings instead of expanding them', () => {
  rejects('~/rules.md', 'expansion')
  rejects('$HOME/rules.md', 'expansion')
  rejects('rules/$HOME.md', 'expansion')
  rejects('%USERPROFILE%/rules.md', 'expansion')
})

test('rejects Windows reserved device names in any segment', () => {
  rejects('con', 'reserved-name')
  rejects('rules/PRN.md', 'reserved-name')
  rejects('rules/com1/api.md', 'reserved-name')
  rejects('rules/lpt9', 'reserved-name')
  expect(normalizeStorePath('rules/console.md').displayPath).toBe('rules/console.md')
})

test('rejects illegal characters and Windows trailing dot or space', () => {
  rejects('rules/a:b.md', 'illegal-character')
  rejects('rules/a?b.md', 'illegal-character')
  rejects('rules/a*b.md', 'illegal-character')
  rejects('rules/a|b.md', 'illegal-character')
  rejects('rules/a\u0001b.md', 'illegal-character')
  rejects('rules/trailing.', 'illegal-character')
  // 段内部以空格结尾必须拒绝：Windows 会静默去掉它。
  rejects('rules/inner /api.md', 'illegal-character')
  // 整串首尾空白属于模型噪声，去掉后指向同一目标，因此归一而不是拒绝。
  expect(normalizeStorePath('rules/trailing ').displayPath).toBe('rules/trailing')
  expect(normalizeStorePath('  rules/api.md  ').displayPath).toBe('rules/api.md')
})

test('enforces the length and depth limits', () => {
  rejects('a'.repeat(241), 'too-long')
  rejects(Array.from({ length: 33 }, () => 'd').join('/'), 'too-deep')
  expect(normalizeStorePath('a'.repeat(240)).displayPath).toHaveLength(240)
  expect(normalizeStorePath(Array.from({ length: 32 }, () => 'd').join('/')).segments).toHaveLength(32)
})

test('resolves targets under the root and refuses anything outside', () => {
  const root = resolve('/workspace/.dsh')
  const path = normalizeStorePath('rules/api.md')
  expect(resolveStoreTarget(root, path)).toBe(join(root, 'rules', 'api.md'))
  expect(resolveStoreTarget(root, normalizeStorePath(''))).toBe(root)
})

test('compares containment by path segment', () => {
  const root = resolve('/workspace/.dsh')
  expect(isPathInside(root, join(root, 'rules'))).toBe(true)
  expect(isPathInside(root, root)).toBe(true)
  expect(isPathInside(root, resolve('/workspace/.dsh-other'))).toBe(false)
  expect(isPathInside(root, resolve('/workspace'))).toBe(false)
  expect(isPathInside(root, resolve('/workspace/.dsh/../escape'))).toBe(false)
})
