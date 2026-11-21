/**
 * Repair one Session log so its next request can reach the provider again.
 *
 * A Session fails every request with `DeepSeek Messages transport failed` when the request cannot be built: the
 * adapter resolves recorded image attachments before sending, so an attachment whose bytes are gone fails the whole
 * turn, and retries cannot recover. The second cause is a conversation surface past the transport's payload ceiling.
 * This recovery tool replaces missing attachments with a truthful text marker and prunes the text of all but the
 * newest tool results. Every other event stays unchanged, the log is written atomically after a backup, and the
 * result is re-read to prove its event count.
 *
 * Usage: `tsx scripts/repair-session-payload.ts <session-directory-or-log|sessions-root>`
 *        `[--attachments <root>] [--keep-recent <count>] [--threshold <chars>] [--apply]`
 */

import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_FILE = 'session.v4.jsonl.zstd'
/** Tool results kept verbatim: the tail the conversation is still actively reasoning about. */
export const DEFAULT_KEEP_RECENT = 40
/** Conversation text a request may carry before it is repaired; the observed transport ceiling sits near 1 MiB. */
export const DEFAULT_THRESHOLD_CHARS = 700_000
/** Tool results shorter than this stay intact: pruning them cannot pay for the marker. */
export const MIN_PRUNABLE_CHARS = 600
/** A log written this recently may belong to a running turn, so a batch run leaves it alone. */
const ACTIVE_WINDOW_MS = 120_000

/** One decoded Session event; only its recorded message content is rewritten. */
export type Event = Record<string, unknown>

/** Attachment store layout: content-addressed objects under `v1/objects/<first two hex>/<hex>`. */
export interface AttachmentLayout {
  /** Absolute attachment store root, normally `$DSH_HOME/attachments`. */
  root: string
}

/**
 * Decode a Session log that stores one zstd frame per append.
 * @param buffer - raw log file contents.
 * @returns the concatenated JSONL text.
 */
export function decodeLog(buffer: Buffer): string {
  const frames: Buffer[] = []
  let start = 0
  for (let index = 0; index < buffer.length - 3; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
      if (index > start) frames.push(zstdDecompressSync(buffer.subarray(start, index)))
      start = index
    }
  }
  if (start < buffer.length) frames.push(zstdDecompressSync(buffer.subarray(start)))
  return Buffer.concat(frames).toString('utf8')
}

/**
 * Encode JSONL text as the log the Session reader expects, one frame per line.
 * @param lines - event lines without a trailing newline.
 * @returns the encoded log bytes.
 */
export function encodeLog(lines: readonly string[]): Buffer {
  return Buffer.concat(lines.map(line => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))))
}

/**
 * Resolve one attachment object's recorded path.
 * @param root - attachment store root.
 * @param attachmentId - recorded id such as `sha256:<hex>`.
 * @returns the absolute object path.
 */
export function attachmentObjectPath(root: string, attachmentId: string): string {
  const hex = attachmentId.startsWith('sha256:') ? attachmentId.slice('sha256:'.length) : attachmentId
  return join(root, 'v1', 'objects', hex.slice(0, 2), hex)
}

/**
 * Read the mutable message content array of one event.
 * @param event - decoded Session event.
 * @returns the content array itself, so a caller may replace one part in place.
 */
function contentArray(event: Event): unknown[] | undefined {
  const data = event.data as Record<string, unknown> | undefined
  const message = data?.message as Record<string, unknown> | undefined
  const content = message?.content ?? data?.content
  return Array.isArray(content) ? content as unknown[] : undefined
}

/**
 * Read the message content parts of one event.
 * @param event - decoded Session event.
 * @returns the object parts, or an empty array when the event carries none.
 */
function contentParts(event: Event): Array<Record<string, unknown>> {
  return (contentArray(event) ?? []).filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null)
}

/**
 * Read the text parts of one event's message content.
 * @param event - decoded Session event.
 * @returns text part positions and their recorded text.
 */
function textParts(event: Event): Array<{ part: Record<string, unknown>; text: string }> {
  const parts: Array<{ part: Record<string, unknown>; text: string }> = []
  for (const part of contentParts(event)) {
    if (part.type === 'text' && typeof part.text === 'string') parts.push({ part, text: part.text })
  }
  return parts
}

/**
 * Sum the characters a model request carries as conversation text.
 * @param events - decoded Session events.
 * @returns character counts per surface category.
 */
export function surfaceChars(events: readonly Event[]): { toolResult: number; assistant: number; user: number; toolCall: number } {
  const totals = { toolResult: 0, assistant: 0, user: 0, toolCall: 0 }
  for (const event of events) {
    for (const { text } of textParts(event)) {
      if (event.type === 'tool/result') totals.toolResult += text.length
      else if (event.type === 'assistant/message') totals.assistant += text.length
      else if (event.type === 'user/message') totals.user += text.length
    }
    if (event.type !== 'assistant/message') continue
    for (const part of contentParts(event)) {
      if (part.type === 'tool-call' && typeof part.arguments === 'string') totals.toolCall += part.arguments.length
    }
  }
  return totals
}

/**
 * Replace content parts whose attachment bytes are gone with a text marker, so the request can be built.
 * @param events - decoded Session events.
 * @param attachmentsRoot - attachment store root, or undefined to leave attachments alone.
 * @returns rewritten events and how many parts were replaced.
 */
export function replaceMissingAttachments(
  events: readonly Event[], attachmentsRoot: string | undefined,
): { events: Event[]; replaced: number } {
  if (attachmentsRoot === undefined) return { events: events.map(event => structuredClone(event)), replaced: 0 }
  let replaced = 0
  const rewritten = events.map((event) => {
    const clone = structuredClone(event)
    const content = contentArray(clone)
    if (content === undefined) return clone
    for (let index = 0; index < content.length; index += 1) {
      const part = content[index]
      if (typeof part !== 'object' || part === null) continue
      const record = part as Record<string, unknown>
      const attachment = record.attachment as Record<string, unknown> | undefined
      const id = attachment?.attachmentId
      if (typeof id !== 'string') continue
      if (existsSync(attachmentObjectPath(attachmentsRoot, id))) continue
      const kind = typeof record.type === 'string' ? record.type : 'attachment'
      content[index] = { type: 'text', text: `[${kind} unavailable: attachment ${id} is missing]` }
      replaced += 1
    }
    return clone
  })
  return { events: rewritten, replaced }
}

/**
 * Replace old tool-result text with a marker while keeping the newest results intact.
 * @param events - decoded Session events, in log order.
 * @param keepRecent - number of trailing tool results to leave untouched.
 * @returns rewritten events, the number of pruned text parts, and the characters removed.
 */
export function pruneToolResults(
  events: readonly Event[], keepRecent: number,
): { events: Event[]; pruned: number; removedChars: number } {
  const positions = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'tool/result')
  const keepFrom = Math.max(0, positions.length - keepRecent)
  const rewritten = events.map(event => structuredClone(event))
  let pruned = 0
  let removedChars = 0
  for (const { index } of positions.slice(0, keepFrom)) {
    const target = rewritten[index]
    if (target === undefined) continue
    for (const { part, text } of textParts(target)) {
      if (text.length < MIN_PRUNABLE_CHARS) continue
      const marker = `[tool result pruned by session repair: ${String(text.length)} characters removed]`
      part.text = marker
      pruned += 1
      removedChars += text.length - marker.length
    }
  }
  return { events: rewritten, pruned, removedChars }
}

/**
 * Resolve the log file a recovery target names.
 * @param target - Session directory or log file path.
 * @returns absolute log file path.
 */
function resolveLog(target: string): string {
  return statSync(target, { throwIfNoEntry: false })?.isFile() === true ? resolve(target) : join(resolve(target), LOG_FILE)
}

/**
 * Rewrite one log in place after a backup.
 * @param logPath - absolute log file path.
 * @param lines - replacement event lines.
 * @param originalLines - the lines read before rewriting, used to verify the result.
 * @returns the backup path.
 */
function rewrite(logPath: string, lines: readonly string[], originalLines: readonly string[]): string {
  try {
    closeSync(openSync(logPath, 'r+'))
  } catch (error) {
    throw new Error(`session repair: ${logPath} is not writable: ${(error as Error).message}`)
  }
  const backup = `${logPath}.bak-${String(Date.now())}`
  copyFileSync(logPath, backup)
  const temporary = `${logPath}.tmp-${String(process.pid)}`
  writeFileSync(temporary, encodeLog(lines))
  const verification = decodeLog(readFileSync(temporary)).split('\n').filter(line => line.trim() !== '')
  if (verification.length !== originalLines.length) {
    rmSync(temporary, { force: true })
    throw new Error(`session repair: verification read ${String(verification.length)} events, `
      + `expected ${String(originalLines.length)}`)
  }
  renameSync(temporary, logPath)
  return backup
}

/** Outcome of one repair run, printed by the CLI and asserted by tests. */
export interface RepairReport {
  /** Session directory or log the run targeted. */
  log: string
  /** Recorded Session title, when the log carries one. */
  title?: string
  /** Event count before and after; the tool refuses a change. */
  events: number
  /** Tool results left verbatim. */
  keptToolResults: number
  /** Text parts replaced with the tool-result marker. */
  prunedTextParts: number
  /** Content parts whose attachment bytes are gone, replaced with a marker. */
  missingAttachments: number
  /** Characters removed from the recorded surface. */
  removedChars: number
  /** Conversation surface before the run. */
  surfaceBefore: ReturnType<typeof surfaceChars>
  /** Conversation surface after the run. */
  surfaceAfter: ReturnType<typeof surfaceChars>
  /** Whether the log was rewritten. */
  applied: boolean
  /** Backup of the untouched log, present when `applied`. */
  backup?: string
  /** Why a batch run left this log alone; absent when the log was examined and repaired. */
  skipped?: string
}

/**
 * Repair one Session log.
 * @param target - Session directory or log file path.
 * @param options - `apply` rewrites the log after a backup; `keepRecent` bounds the verbatim tail;
 *   `attachmentsRoot` enables missing-attachment replacement.
 * @returns the report for this run.
 */
export function repairSessionPayload(
  target: string,
  options: { apply?: boolean; keepRecent?: number; attachmentsRoot?: string } = {},
): RepairReport {
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT
  const logPath = resolveLog(target)
  const originalLines = decodeLog(readFileSync(logPath)).split('\n').filter(line => line.trim() !== '')
  const events = originalLines.map(line => JSON.parse(line) as Event)
  const surfaceBefore = surfaceChars(events)
  const { events: withAttachments, replaced } = replaceMissingAttachments(events, options.attachmentsRoot)
  const { events: repaired, pruned, removedChars } = pruneToolResults(withAttachments, keepRecent)
  const items = repaired.map(event => JSON.stringify(event))
  if (items.length !== originalLines.length) throw new Error('session repair: event count changed')
  const title = repaired.find(event => event.type === 'session/title') as { data?: { title?: unknown } } | undefined
  const report: RepairReport = {
    log: logPath,
    ...(typeof title?.data?.title === 'string' ? { title: title.data.title } : {}),
    events: originalLines.length,
    keptToolResults: keepRecent,
    prunedTextParts: pruned,
    missingAttachments: replaced,
    removedChars,
    surfaceBefore,
    surfaceAfter: surfaceChars(repaired),
    applied: false,
  }
  const changed = pruned > 0 || replaced > 0
  if (options.apply !== true || !changed) return report
  return { ...report, applied: true, backup: rewrite(logPath, items, originalLines) }
}

/**
 * Repair every Session log under a Harness sessions root that needs it.
 * @param root - sessions root, or a workspace directory holding session directories.
 * @param options - `apply` rewrites each repaired log after a backup; `thresholdChars` bounds the unchanged surface;
 *   `attachmentsRoot` enables missing-attachment replacement; `skipModifiedWithinMs` protects an active turn's log.
 * @returns one report per examined log, oldest first.
 */
export function repairSessionsRoot(
  root: string,
  options: {
    apply?: boolean
    keepRecent?: number
    thresholdChars?: number
    attachmentsRoot?: string
    skipModifiedWithinMs?: number
  } = {},
): RepairReport[] {
  const threshold = options.thresholdChars ?? DEFAULT_THRESHOLD_CHARS
  const activeWindow = options.skipModifiedWithinMs ?? ACTIVE_WINDOW_MS
  const empty = { toolResult: 0, assistant: 0, user: 0, toolCall: 0 }
  const skip = (logPath: string, skipped: string): RepairReport => ({
    log: logPath, events: 0, keptToolResults: 0, prunedTextParts: 0, missingAttachments: 0, removedChars: 0,
    surfaceBefore: { ...empty }, surfaceAfter: { ...empty }, applied: false, skipped,
  })
  const logs = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name === LOG_FILE)
    .map(entry => join(entry.parentPath, entry.name))
    .filter(path => !path.includes('.bak-'))
    .sort()
  const shared = {
    ...options.keepRecent === undefined ? {} : { keepRecent: options.keepRecent },
    ...options.attachmentsRoot === undefined ? {} : { attachmentsRoot: options.attachmentsRoot },
  }
  const reports: RepairReport[] = []
  for (const logPath of logs) {
    if (Date.now() - statSync(logPath).mtimeMs < activeWindow) {
      reports.push(skip(logPath, 'written within the active window'))
      continue
    }
    let report: RepairReport
    try {
      report = repairSessionPayload(logPath, shared)
    } catch (error) {
      reports.push(skip(logPath, `unreadable: ${(error as Error).message}`))
      continue
    }
    const before = report.surfaceBefore
    const surface = before.user + before.assistant + before.toolResult + before.toolCall
    if (report.missingAttachments === 0 && surface <= threshold) {
      reports.push({ ...report, skipped: 'nothing to repair' })
      continue
    }
    reports.push(options.apply === true
      ? repairSessionPayload(logPath, { apply: true, ...shared })
      : report)
  }
  return reports
}

/** Totals a batch run prints. */
interface BatchSummary {
  /** Reports for sessions that were rewritten. */
  repaired: RepairReport[]
  /** Reports for sessions that needed no change. */
  untouched: number
}

/**
 * Summarize batch reports for the CLI.
 * @param reports - reports returned by {@link repairSessionsRoot}.
 * @returns the repaired subset and the untouched count.
 */
function summarize(reports: readonly RepairReport[]): BatchSummary {
  return { repaired: reports.filter(report => report.applied), untouched: reports.filter(report => report.skipped !== undefined).length }
}

/**
 * Entry point: parse the CLI arguments and print the report.
 * @param argv - process arguments after the script path.
 * @returns the process exit code: 2 on a usage error.
 */
export function main(argv: readonly string[]): number {
  const apply = argv.includes('--apply')
  const flagValue = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const keepRecent = flagValue('--keep-recent') === undefined
    ? DEFAULT_KEEP_RECENT : Number.parseInt(flagValue('--keep-recent') ?? '', 10)
  const threshold = flagValue('--threshold') === undefined
    ? DEFAULT_THRESHOLD_CHARS : Number.parseInt(flagValue('--threshold') ?? '', 10)
  const attachmentsFlag = flagValue('--attachments')
  const valueIndexes = new Set<number>()
  for (const name of ['--keep-recent', '--threshold', '--attachments']) {
    const index = argv.indexOf(name)
    if (index !== -1) valueIndexes.add(index + 1)
  }
  const target = argv.find((argument, index) => !argument.startsWith('--') && !valueIndexes.has(index))
  if (target === undefined || !Number.isSafeInteger(keepRecent) || keepRecent < 0
    || !Number.isSafeInteger(threshold) || threshold < 1) {
    console.error('usage: tsx scripts/repair-session-payload.ts <session-directory-or-log|sessions-root> '
      + '[--attachments <root>] [--keep-recent <count>] [--threshold <chars>] [--apply]')
    return 2
  }
  const resolved = resolve(target)
  const isSessionsRoot = statSync(resolved, { throwIfNoEntry: false })?.isDirectory() === true
    && statSync(join(resolved, LOG_FILE), { throwIfNoEntry: false })?.isFile() !== true
  if (isSessionsRoot) {
    const attachmentsRoot = attachmentsFlag ?? resolve(resolved, '..', 'attachments')
    const reports = repairSessionsRoot(resolved, {
      apply, keepRecent, thresholdChars: threshold, attachmentsRoot,
    })
    const surface = (value: RepairReport['surfaceBefore']): number =>
      value.user + value.assistant + value.toolResult + value.toolCall
    for (const report of reports) {
      if (report.skipped !== undefined && report.skipped !== 'written within the active window') continue
      console.log([
        report.applied ? 'REPAIRED' : 'skipped',
        report.skipped ?? '',
        `${String(Math.round(surface(report.surfaceBefore) / 1024))}KB->${String(Math.round(surface(report.surfaceAfter) / 1024))}KB`,
        `images=${String(report.missingAttachments)}`,
        `pruned=${String(report.prunedTextParts)}`,
        report.title === undefined ? '' : JSON.stringify(report.title),
        report.log,
        report.backup === undefined ? '' : `backup=${report.backup}`,
      ].filter(part => part !== '').join(' '))
    }
    const { repaired, untouched } = summarize(reports)
    console.log(`${apply ? 'repaired' : 'would repair'} ${String(repaired.length)} of `
      + `${String(reports.length - untouched)} sessions needing repair; ${String(untouched)} untouched`)
    return 0
  }
  const report = repairSessionPayload(resolved, {
    apply, keepRecent, ...attachmentsFlag === undefined ? {} : { attachmentsRoot: attachmentsFlag },
  })
  console.log(JSON.stringify(report, undefined, 2))
  if (!apply) console.log('dry run: pass --apply to rewrite the log after a backup')
  else if (!report.applied) console.log('nothing to repair')
  else console.log(`rewrote ${report.log} (${String(statSync(report.log).size)} bytes); backup ${String(report.backup)}`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
