import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  attachmentObjectPath, decodeLog, encodeLog, main, MIN_PRUNABLE_CHARS, pruneToolResults, repairSessionPayload,
  repairSessionsRoot, replaceMissingAttachments, surfaceChars, type Event,
} from './repair-session-payload.ts'

const roots: string[] = []
function fixtureLog(): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'repair-session-payload-spec-'))
  roots.push(directory)
  return { directory, file: join(directory, 'session.v4.jsonl.zstd') }
}

function event(type: string, content: unknown): Event {
  return { type, data: { message: { content } } }
}

function toolResult(chars: number): Event {
  return event('tool/result', [{ type: 'text', text: 'x'.repeat(chars) }])
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('round-trips a log through one zstd frame per line', () => {
  const lines = ['{"a":1}', '{"b":2}']
  expect(decodeLog(encodeLog(lines)).split('\n')).toEqual(['{"a":1}', '{"b":2}', ''])
})

it('keeps the newest tool results and prunes older text with a recorded marker', () => {
  const events = [
    toolResult(5000),
    event('user/message', [{ type: 'text', text: 'u'.repeat(5000) }]),
    toolResult(3000),
    toolResult(100),
  ]
  const { events: pruned, pruned: parts, removedChars } = pruneToolResults(events, 1)
  const marker = (chars: number): string => `[tool result pruned by session repair: ${String(chars)} characters removed]`
  expect(parts).toBe(2)
  expect(removedChars).toBe((5000 - marker(5000).length) + (3000 - marker(3000).length))
  const first = pruned[0]?.data as { message: { content: Array<{ text: string }> } }
  expect(first.message.content[0]?.text).toBe(marker(5000))
  const last = pruned[3]?.data as { message: { content: Array<{ text: string }> } }
  expect(last.message.content[0]?.text).toHaveLength(100)
  const user = pruned[1]?.data as { message: { content: Array<{ text: string }> } }
  expect(user.message.content[0]?.text).toHaveLength(5000)
})

it('leaves tool results below the prunable size intact', () => {
  const { pruned } = pruneToolResults([toolResult(MIN_PRUNABLE_CHARS - 1)], 0)
  expect(pruned).toBe(0)
})

it('counts the conversation surface by category', () => {
  expect(surfaceChars([
    toolResult(10),
    event('user/message', [{ type: 'text', text: '12345' }]),
    event('assistant/message', [{ type: 'text', text: '123' }, { type: 'tool-call', arguments: '12' }]),
  ])).toEqual({ toolResult: 10, assistant: 3, user: 5, toolCall: 2 })
})

it('backs up the log and keeps the event count when applying', () => {
  const { file } = fixtureLog()
  const events = [event('session', []), toolResult(4000), toolResult(2000), toolResult(50)]
  writeFileSync(file, encodeLog(events.map(entry => JSON.stringify(entry))))
  const report = repairSessionPayload(file, { apply: true, keepRecent: 1 })
  expect(report.applied).toBe(true)
  expect(report.prunedTextParts).toBe(2)
  expect(report.events).toBe(events.length)
  expect(report.backup).toBeDefined()
  expect(existsSync(report.backup ?? '')).toBe(true)
  const rewritten = decodeLog(readFileSync(file)).split('\n').filter(line => line.trim() !== '')
  expect(rewritten).toHaveLength(events.length)
  expect(JSON.parse(rewritten[0] ?? '{}')).toMatchObject({ type: 'session' })
  const tail = JSON.parse(rewritten[3] ?? '{}') as { data: { message: { content: Array<{ text: string }> } } }
  expect(tail.data.message.content[0]?.text).toHaveLength(50)
})

it('reports a dry run without touching the log', () => {
  const { file } = fixtureLog()
  const original = encodeLog([JSON.stringify(toolResult(4000)), JSON.stringify(toolResult(10))])
  writeFileSync(file, original)
  const report = repairSessionPayload(file, { keepRecent: 1 })
  expect(report.applied).toBe(false)
  expect(report.prunedTextParts).toBe(1)
  expect(readFileSync(file).equals(original)).toBe(true)
  expect(report.backup).toBeUndefined()
})

it('refuses a log it cannot rewrite', () => {
  const { directory } = fixtureLog()
  expect(() => repairSessionPayload(join(directory, 'missing'), { apply: true })).toThrow(/ENOENT/u)
})

const PRESENT = `sha256:${'ab'.repeat(32)}`
const MISSING = `sha256:${'cd'.repeat(32)}`

function image(attachmentId: string): Event {
  return event('user/message', [{ type: 'image', attachment: { attachmentId, mediaType: 'image/png' } }])
}

it('replaces an image whose attachment bytes are gone and keeps the one still on disk', () => {
  const attachments = mkdtempSync(join(tmpdir(), 'repair-session-payload-attachments-'))
  roots.push(attachments)
  const present = attachmentObjectPath(attachments, PRESENT)
  mkdirSync(join(present, '..'), { recursive: true })
  writeFileSync(present, 'png')
  const { events: repaired, replaced } = replaceMissingAttachments([image(PRESENT), image(MISSING)], attachments)
  expect(replaced).toBe(1)
  const first = repaired[0]?.data as { message: { content: Array<Record<string, unknown>> } }
  expect(first.message.content[0]).toMatchObject({ type: 'image' })
  const second = repaired[1]?.data as { message: { content: Array<Record<string, unknown>> } }
  expect(second.message.content[0]).toMatchObject({ type: 'text' })
  expect(String(second.message.content[0]?.text)).toContain('is missing')
})

it('rewrites a log whose only problem is a missing attachment', () => {
  const { file } = fixtureLog()
  writeFileSync(file, encodeLog([JSON.stringify(image(MISSING))]))
  const report = repairSessionPayload(file, { apply: true, attachmentsRoot: join(file, '..', 'attachments') })
  expect(report.missingAttachments).toBe(1)
  expect(report.applied).toBe(true)
  expect(report.backup).toBeDefined()
  const lines = decodeLog(readFileSync(file)).split('\n').filter(line => line.trim() !== '')
  expect(lines).toHaveLength(1)
  expect(String(lines[0])).toContain('attachment')
  expect(String(lines[0])).not.toContain('"type":"image"')
})

it('reports one entry per session log and rewrites only what needs repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-session-payload-root-'))
  roots.push(root)
  const broken = join(root, 'session-broken')
  const fine = join(root, 'session-fine')
  mkdirSync(broken, { recursive: true })
  mkdirSync(fine, { recursive: true })
  writeFileSync(join(broken, 'session.v4.jsonl.zstd'), encodeLog([JSON.stringify(image(MISSING))]))
  writeFileSync(join(fine, 'session.v4.jsonl.zstd'), encodeLog([JSON.stringify(toolResult(10))]))
  const reports = repairSessionsRoot(root, { apply: true, attachmentsRoot: join(root, 'attachments'), skipModifiedWithinMs: 0 })
  expect(reports).toHaveLength(2)
  expect(reports.filter(report => report.applied)).toHaveLength(1)
  expect(reports.find(report => report.log === join(broken, 'session.v4.jsonl.zstd'))?.missingAttachments).toBe(1)
  expect(reports.find(report => report.log === join(fine, 'session.v4.jsonl.zstd'))?.skipped).toBeDefined()
})

it('repairs through the command entry point and reports success', () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-session-payload-cli-'))
  roots.push(root)
  const session = join(root, 'session-cli')
  mkdirSync(session, { recursive: true })
  const file = join(session, 'session.v4.jsonl.zstd')
  writeFileSync(file, encodeLog([JSON.stringify(image(MISSING))]))
  const old = new Date('2026-01-01T00:00:00Z')
  utimesSync(file, old, old)
  expect(main([root, '--apply', '--attachments', join(root, 'attachments'), '--threshold', '1000000'])).toBe(0)
  expect(decodeLog(readFileSync(file))).toContain('is missing')
})

it('returns a usage error without a target', () => {
  expect(main([])).toBe(2)
})
