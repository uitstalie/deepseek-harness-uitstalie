/** Profile-section rendering tests: kind order, headings, empty input, and id order. */
import { expect, test } from 'vitest'
import type { PersonalityEntry } from '../src/global-store.ts'
import { PROFILE_PREAMBLE, renderPersonalitySection } from '../src/profile-prompt.ts'

/** One entry fixture. */
function entry(kind: PersonalityEntry['kind'], name: string, text: string): PersonalityEntry {
  return { id: `${kind}.${name}`, kind, text }
}

test('renders an empty profile as an empty section', () => {
  expect(renderPersonalitySection([])).toBe('')
})

test('groups communication and response kinds in canonical order', () => {
  const text = renderPersonalitySection([
    entry('style', 'z-last', '最后。'),
    entry('style', 'language', '用中文回答。'),
    entry('preference', 'scope', '只做点名对象。'),
    entry('understanding', 'terse', '常用短句。'),
    entry('identity', 'role', '独立开发者。'),
    entry('style', 'format', '先给结论。'),
  ])
  expect(text.startsWith(PROFILE_PREAMBLE)).toBe(true)
  expect(text.indexOf('How this user communicates')).toBeLessThan(text.indexOf('How to respond'))
  expect(text.indexOf('- 独立开发者。')).toBeLessThan(text.indexOf('- 常用短句。'))
  expect(text.indexOf('- 只做点名对象。')).toBeLessThan(text.indexOf('- 先给结论。'))
  expect(text.indexOf('- 先给结论。')).toBeLessThan(text.indexOf('- 用中文回答。'))
})

test('collapses whitespace in one entry', () => {
  expect(renderPersonalitySection([entry('style', 'language', '  one   line  ')])).toContain('- one line')
})
