/**
 * Drift-review command tests: the merged `show` view, the global history
 * `diff`, the version-guarded `revert`, its no-op and failure messages, and the
 * `/personality` registration. The handlers run directly with the real
 * filesystem and store services, so the command runtime is not booted except in
 * the one registration test.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { CommandId, CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createDshStore } from '@deepseek-ai/dsh-tool-dsh-store'
import { resolveConfig } from '../src/config.ts'
import type { PersonalitySettings } from '../src/config.ts'
import {
  PERSONALITY_FILE_NAME,
  PERSONALITY_HISTORY_FILE_NAME,
  PERSONALITY_STORE_PATH,
  parsePersonalityDocument,
  renderPersonalityBlock,
  renderPersonalityDocument,
} from '../src/personality-file.ts'
import type {
  PersonalityDocument,
  PersonalityEntry,
  PersonalityEntryKind,
  PersonalityHistoryRecord,
  PersonalityHistorySource,
} from '../src/personality-file.ts'
import {
  diffPersonalityHistory,
  PERSONALITY_COMMAND_NAME,
  PERSONALITY_COMMAND_USAGE,
  registerPersonalityCommands,
  revertPersonality,
  showPersonality,
} from '../src/commands.ts'

let project: string
let ctx: Context
let session: Session
let settings: PersonalitySettings

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'dsh-personality-commands-'))
  // A `.git` marker makes the fixture look like a checkout, so project-root
  // discovery resolves to the fixture rather than to the temp directory above it.
  await mkdir(join(project, '.git'), { recursive: true })
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: project })
  ctx.provide('dshStore', createDshStore(ctx, false))
  const id = SessionId('session-a')
  session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    cwd: project,
  })
  settings = resolveConfig({ globalPath: globalFile() })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.fiber.dispose()
  await rm(project, { recursive: true, force: true })
})

/** Absolute path of the fixture global profile. */
function globalFile(): string {
  return join(project, 'home', 'personality', PERSONALITY_FILE_NAME)
}

/** Absolute path of the fixture global history. */
function historyFile(): string {
  return join(project, 'home', 'personality', PERSONALITY_HISTORY_FILE_NAME)
}

/** One entry fixture. */
function entry(kind: PersonalityEntryKind, name: string, text: string): PersonalityEntry {
  return { id: `${kind}.${name}`, kind, name, text }
}

/** Build a document with a fixed update time. */
function documentWith(entries: readonly PersonalityEntry[], version = 1): PersonalityDocument {
  return {
    version,
    updatedAt: '2026-10-21T00:00:00.000Z',
    entries,
    frame: { before: '\n', after: '\n' },
  }
}

/** Write the global profile before a read. */
async function seedGlobal(entries: readonly PersonalityEntry[], version = 1): Promise<string> {
  const text = renderPersonalityDocument(documentWith(entries, version))
  await mkdir(dirname(globalFile()), { recursive: true })
  await writeFile(globalFile(), text, 'utf8')
  return text
}

/** Write the workspace overlay before a read. */
async function seedOverlay(entries: readonly PersonalityEntry[], version = 1): Promise<void> {
  await ctx.dshStore.writeFile(session, PERSONALITY_STORE_PATH, renderPersonalityDocument(documentWith(entries, version)))
}

/** Write the global history lines before a read. */
async function seedHistory(records: readonly PersonalityHistoryRecord[]): Promise<void> {
  await mkdir(dirname(historyFile()), { recursive: true })
  await writeFile(historyFile(), records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
}

/** Build one history record around its managed block. */
function historyRecord(
  version: number,
  entries: readonly PersonalityEntry[],
  source: PersonalityHistorySource = 'user',
): PersonalityHistoryRecord {
  return {
    version,
    at: '2026-10-21T00:00:00.000Z',
    source,
    session: 'session-a',
    diff: [],
    block: renderPersonalityBlock(entries),
  }
}

/** Result text of either command outcome. */
function text(result: CommandResult): string {
  return result.text ?? ''
}

/** Read and parse the current global profile. */
async function readGlobalDocument(): Promise<PersonalityDocument> {
  return parsePersonalityDocument(await readFile(globalFile(), 'utf8'))
}

/** Read the history lines as parsed records. */
async function readHistoryRecords(): Promise<PersonalityHistoryRecord[]> {
  const source = await readFile(historyFile(), 'utf8')
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as PersonalityHistoryRecord)
}

/** Build one live agent stub accepted by the command registry. */
function stubAgent(): Agent {
  const inbox = createInboxStub()
  let status: AgentStatus = 'idle'
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

test('show renders an empty profile without throwing', async () => {
  const result = await showPersonality(ctx, session, settings)

  expect(result.kind).toBe('success')
  expect(text(result)).toContain('Global version: none')
  expect(text(result)).toContain('Workspace overlay: none')
  expect(text(result)).toContain('No personality entries.')
})

test('show renders global entries with their id, kind, one text line, and version', async () => {
  await seedGlobal([
    entry('style', 'language', '用中文回答；\n代码、命令保持英文。'),
    entry('understanding', 'terse', '用户常用短句表达。'),
  ], 2)

  const result = await showPersonality(ctx, session, settings)

  expect(result.kind).toBe('success')
  expect(text(result)).toBe([
    'Personality profile',
    'Global version: 2',
    'Workspace overlay: none',
    'Entries (2):',
    '- style.language [style] 用中文回答； 代码、命令保持英文。',
    '- understanding.terse [understanding] 用户常用短句表达。',
  ].join('\n'))
})

test('show merges the workspace overlay and reports both versions', async () => {
  await seedGlobal([
    entry('style', 'language', '全局文本。'),
    entry('preference', 'workflow', '全局工作习惯。'),
  ], 2)
  await seedOverlay([
    entry('style', 'language', '工作区文本。'),
    entry('preference', 'extra', '工作区偏好。'),
  ], 5)

  const result = await showPersonality(ctx, session, settings)

  expect(result.kind).toBe('success')
  expect(text(result)).toContain('Global version: 2')
  expect(text(result)).toContain('Workspace overlay: version 5')
  expect(text(result)).toContain('- style.language [style] 工作区文本。')
  expect(text(result)).toContain('- preference.workflow [preference] 全局工作习惯。')
  expect(text(result)).toContain('- preference.extra [preference] 工作区偏好。')
  expect(text(result)).not.toContain('全局文本。')
})

test('show reports a disabled overlay without reading it', async () => {
  await seedGlobal([entry('style', 'language', '全局文本。')])
  const globalOnly = resolveConfig({ globalPath: globalFile(), workspaceOverlay: false })

  const result = await showPersonality(ctx, session, globalOnly)

  expect(text(result)).toContain('Workspace overlay: disabled')
  expect(text(result)).toContain('- style.language [style] 全局文本。')
})

test('diff reports an absent or single-record history instead of failing', async () => {
  const empty = await diffPersonalityHistory(ctx, settings)
  expect(empty.kind).toBe('success')
  expect(text(empty)).toContain('No personality history yet')

  await seedHistory([historyRecord(1, [entry('style', 'language', '旧文本。')])])
  const single = await diffPersonalityHistory(ctx, settings)
  expect(single.kind).toBe('success')
  expect(text(single)).toContain('Only one personality history record')
})

test('diff renders a line diff of the latest two blocks with versions and sources', async () => {
  await seedHistory([
    historyRecord(1, [entry('style', 'language', '旧文本。')], 'user'),
    historyRecord(2, [
      entry('style', 'language', '新文本。'),
      entry('preference', 'workflow', '先读现有实现。'),
    ], 'auto'),
  ])

  const result = await diffPersonalityHistory(ctx, settings)

  expect(result.kind).toBe('success')
  expect(text(result)).toContain('version 1 (source: user) -> version 2 (source: auto)')
  expect(text(result)).toContain('-旧文本。')
  expect(text(result)).toContain('+新文本。')
  expect(text(result)).toContain('+## preference.workflow')
  expect(text(result)).toContain('+先读现有实现。')
  expect(text(result)).toContain(' <!-- personality:begin -->')
  expect(text(result)).toContain(' <!-- personality:end -->')
})

test('diff turns a malformed history line into an actionable error result', async () => {
  await mkdir(dirname(historyFile()), { recursive: true })
  await writeFile(historyFile(), 'not json\n', 'utf8')

  const result = await diffPersonalityHistory(ctx, settings)

  expect(result.kind).toBe('error')
  expect(text(result)).toContain(`${PERSONALITY_HISTORY_FILE_NAME} line 1 is not valid JSON`)
})

test('revert restores the previous managed block, keeps hand-written text, and records itself', async () => {
  const restored = [entry('style', 'language', '恢复的文本。')]
  const current = [entry('style', 'language', '当前文本。')]
  const seeded = await seedGlobal(current, 3)
  const withLead = seeded.replace('<!-- personality:begin -->', 'Hand-written lead.\n\n<!-- personality:begin -->')
  await writeFile(globalFile(), withLead, 'utf8')
  await seedHistory([historyRecord(2, restored), historyRecord(3, current)])

  const result = await revertPersonality(ctx, session, settings, '2')

  expect(result.kind).toBe('success')
  expect(text(result)).toContain('Restored version 2')
  expect(text(result)).toContain('as version 4')
  expect(text(result)).toContain('0 added, 1 updated, 0 removed')

  const document = await readGlobalDocument()
  expect(document.version).toBe(4)
  expect(document.entries).toEqual(restored)
  expect(document.frame.before).toContain('Hand-written lead.')

  const records = await readHistoryRecords()
  expect(records).toHaveLength(3)
  expect(records[2]).toMatchObject({
    version: 4,
    source: 'user',
    session: 'session-a',
    diff: [{ id: 'style.language', change: 'updated' }],
  })
  expect(records[2]?.block).toBe(renderPersonalityBlock(restored))
})

test('revert retries one stale-version write after a re-read', async () => {
  const restored = [entry('style', 'language', '恢复的文本。')]
  const current = [entry('style', 'language', '当前文本。')]
  await seedGlobal(current, 3)
  await seedHistory([historyRecord(2, restored), historyRecord(3, current)])
  vi.spyOn(ctx.fs, 'writeText').mockRejectedValueOnce(new FsError('stale version', 'FS_STALE_VERSION'))

  const result = await revertPersonality(ctx, session, settings, '2')

  expect(result.kind).toBe('success')
  const document = await readGlobalDocument()
  expect(document.version).toBe(4)
  expect(document.entries).toEqual(restored)
  expect(await readHistoryRecords()).toHaveLength(3)
})

test('revert to an unknown version reports the known versions and writes nothing', async () => {
  const seeded = await seedGlobal([entry('style', 'language', '当前文本。')], 3)
  await seedHistory([
    historyRecord(2, [entry('style', 'language', '旧文本。')]),
    historyRecord(3, [entry('style', 'language', '当前文本。')]),
  ])

  const result = await revertPersonality(ctx, session, settings, '9')

  expect(result.kind).toBe('error')
  expect(text(result)).toContain('No history record for version 9')
  expect(text(result)).toContain('Known versions: 2, 3')
  expect(await readFile(globalFile(), 'utf8')).toBe(seeded)
  expect(await readHistoryRecords()).toHaveLength(2)
})

test('revert to the current version is a no-op message without a write', async () => {
  const seeded = await seedGlobal([entry('style', 'language', '当前文本。')], 3)
  await seedHistory([historyRecord(3, [entry('style', 'language', '当前文本。')])])

  const result = await revertPersonality(ctx, session, settings, '3')

  expect(result.kind).toBe('success')
  expect(text(result)).toContain('already at version 3')
  expect(await readFile(globalFile(), 'utf8')).toBe(seeded)
  expect(await readHistoryRecords()).toHaveLength(1)
})

test.each(['', 'abc', '0', '-1', '1.5'])('revert rejects the invalid argument %j', async (argument) => {
  const seeded = await seedGlobal([entry('style', 'language', '当前文本。')], 3)
  await seedHistory([historyRecord(3, [entry('style', 'language', '当前文本。')])])

  const result = await revertPersonality(ctx, session, settings, argument)

  expect(result.kind).toBe('error')
  expect(text(result)).toContain('positive history version')
  expect(text(result)).toContain(PERSONALITY_COMMAND_USAGE)
  expect(await readFile(globalFile(), 'utf8')).toBe(seeded)
})

test('registers one /personality command that dispatches its subcommands', async () => {
  await ctx.plugin(CommandRuntime)
  await seedGlobal([entry('style', 'language', '全局文本。')])
  const agent = stubAgent()
  const dispose = registerPersonalityCommands(ctx, settings)

  expect(ctx.commands.list(agent)).toContainEqual({
    definitionId: '@deepseek-ai/dsh-personality',
    name: PERSONALITY_COMMAND_NAME,
    description: 'Show, diff, or revert the personality profile',
    input: { hint: '[show|diff|revert <version>]' },
  })
  const definition = ctx.commands.find(agent, PERSONALITY_COMMAND_NAME)
  expect(definition).toBeDefined()
  const invoke = async (rawInput: string): Promise<CommandResult> => await definition!.handler({
    commandId: CommandId('cmd-test'),
    agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  })
  const invocation: CommandInvocation = {
    commandId: CommandId('cmd-test'),
    agent,
    rawInput: ' show',
    attachments: [],
    signal: new AbortController().signal,
  }
  expect(await definition!.handler(invocation)).toMatchObject({ kind: 'success' })
  expect(text(await invoke(' show'))).toContain('Global version: 1')
  expect(text(await invoke(' diff'))).toContain('No personality history yet')
  expect(text(await invoke(' bogus'))).toContain('Unknown /personality subcommand "bogus"')

  dispose()
  expect(ctx.commands.find(agent, PERSONALITY_COMMAND_NAME)).toBeUndefined()
  await agent.ctx.fiber.dispose()
})
