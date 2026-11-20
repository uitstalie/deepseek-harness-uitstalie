import { describe, expect, it } from 'vitest'
import { hasPackagedUpdateSource, updateEntryVisible, updateSourceArgument, updateSourceFromArguments } from '../src/update-entry.ts'

describe('desktop update entry', () => {
  it('hides the Linux entry without a packaged feed and keeps other platforms unchanged', () => {
    expect(updateEntryVisible('linux', false)).toBe(false)
    expect(updateEntryVisible('linux', true)).toBe(true)
    expect(updateEntryVisible('win32', false)).toBe(true)
    expect(updateEntryVisible('darwin', false)).toBe(true)
  })

  it('detects the packaged feed file', () => {
    expect(hasPackagedUpdateSource('/missing', path => path.endsWith('/app-update.yml'))).toBe(true)
    expect(hasPackagedUpdateSource('/missing', () => false)).toBe(false)
  })

  it('round-trips the preload availability argument', () => {
    expect(updateSourceFromArguments([updateSourceArgument(true)])).toBe(true)
    expect(updateSourceFromArguments([updateSourceArgument(false)])).toBe(false)
    expect(updateSourceFromArguments([])).toBe(false)
  })
})
