/**
 * The reserved managed-memory prefix: the store tool may query it but never
 * write or remove it, while the store service still can.
 */
import { expect, test } from 'vitest'
import { isMemoryPath } from '../src/namespaces.ts'

test('recognizes the memory root and its descendants', () => {
  expect(isMemoryPath('memory')).toBe(true)
  expect(isMemoryPath('memory/sessions/MEMORY.md')).toBe(true)
  expect(isMemoryPath('memory/')).toBe(true)
})

test('is case-insensitive because case-insensitive filesystems alias the prefix', () => {
  expect(isMemoryPath('Memory/sessions/MEMORY.md')).toBe(true)
  expect(isMemoryPath('MEMORY')).toBe(true)
})

test('does not match a sibling whose name merely starts with memory', () => {
  expect(isMemoryPath('memoryx')).toBe(false)
  expect(isMemoryPath('memory-backup/x.md')).toBe(false)
  expect(isMemoryPath('rules/memory.md')).toBe(false)
})
