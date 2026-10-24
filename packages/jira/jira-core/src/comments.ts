/**
 * core/comments — the comment file's format, and the id scheme that survives `merge=union`.
 *
 * Decision 68: every comment is introduced by an HTML comment anchor, so the rendered
 * Markdown stays clean while the machine can address one entry by id:
 *
 *   <!-- c-a1b2-3 | author=human:daiqc | created_at=2026-10-15T12:00:00Z | revision=1 -->
 *   the body
 *
 * The `a1b2` is the first four characters of the writing machine's id, and `3` is that
 * machine's own counter. Two machines appending offline therefore never mint the same id,
 * which is exactly what makes `merge=union` on this file safe (decision 42/68).
 *
 * Parsing is tolerant about *prose* (anything outside an anchor is returned as a preamble
 * rather than dropped) but strict about *anchors*: a line that looks like one and does not
 * parse is an error, never a guess.
 */

import { type Comment, type Identity, type Timestamp } from './entity.ts'
import { type JiraError, invalidInput } from './errors.ts'
import { type Result, err, ok } from './result.ts'

export type PendingComment = Readonly<{ body: string; author: Identity; createdAt: Timestamp }>

export type ParsedComments = Readonly<{
  comments: readonly Comment[]
  /** Text that is not part of any comment; preserved so a hand edit is never destroyed. */
  preamble: string
}>

const ANCHOR_OPEN = /^<!--\s*/
const ANCHOR_CLOSE = /\s*-->$/
const ANCHOR_LOOKALIKE = /^<!--\s*c-/

/** Split an anchor's fields on `|`, ignoring any `|` inside quotes. */
const splitAnchorFields = (inner: string): readonly string[] => {
  const parts: string[] = []
  let buffer = ''
  let quoted = false
  for (const char of inner) {
    if (char === '"') quoted = !quoted
    if (char === '|' && !quoted) {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += char
  }
  parts.push(buffer)
  return Object.freeze(parts.map(part => part.trim()))
}

const unquote = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value

type ParsedAnchor = Readonly<{ id: string; author: string; createdAt: string; revision: number }>

/** `c-<short>-<n>` plus the three named fields; anything else is not an anchor. */
const parseAnchorLine = (line: string): ParsedAnchor | undefined => {
  const text = line.trim()
  if (!ANCHOR_OPEN.test(text) || !ANCHOR_CLOSE.test(text)) return undefined
  const inner = text.replace(ANCHOR_OPEN, '').replace(ANCHOR_CLOSE, '')
  const fields = splitAnchorFields(inner)
  const head = /^c-([0-9a-z]{2,8})-(\d+)$/.exec(fields[0] ?? '')
  if (head === null) return undefined
  const named = new Map<string, string>()
  for (const field of fields.slice(1)) {
    const at = field.indexOf('=')
    if (at === -1) return undefined
    named.set(field.slice(0, at).trim(), unquote(field.slice(at + 1).trim()))
  }
  const author = named.get('author')
  const createdAt = named.get('created_at')
  const revision = named.get('revision')
  if (author === undefined || createdAt === undefined || revision === undefined) return undefined
  const parsedRevision = Number.parseInt(revision, 10)
  if (!Number.isSafeInteger(parsedRevision) || parsedRevision < 1) return undefined
  return Object.freeze({
    id: `c-${head[1]}-${head[2]}`,
    author,
    createdAt,
    revision: parsedRevision,
  })
}

/**
 * The anchor's field separator is `|`, and an agent identity *contains* `|` (decision 48),
 * so an identity that uses one is quoted. Without this the two decisions collide and the
 * author would be read as its first segment (found by a test, not by reading).
 */
export const commentAnchor = (
  id: string,
  author: string,
  createdAt: string,
  revision: number,
): string => {
  const safe = author.includes('|') ? `"${author}"` : author
  return `<!-- ${id} | author=${safe} | created_at=${createdAt} | revision=${revision} -->`
}

/** The four-character machine short code an id is built from (decision 68). */
export const machineShortCode = (machineId: string): string => {
  const cleaned = machineId.toLowerCase().replaceAll(/[^0-9a-z]/g, '')
  return (cleaned.slice(0, 4) || 'anon').padEnd(4, '0')
}

export const commentId = (machineId: string, sequence: number): string =>
  `c-${machineShortCode(machineId)}-${sequence}`

export const parseComments = (text: string): Result<ParsedComments, JiraError> => {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const comments: Comment[] = []
  const preambleLines: string[] = []
  let current: { id: string; author: string; createdAt: string; revision: number; body: string[] } | undefined

  const flush = (): void => {
    if (current === undefined) return
    comments.push(Object.freeze({
      id: current.id,
      author: current.author as Identity,
      revision: current.revision,
      createdAt: current.createdAt as Timestamp,
      body: current.body.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
    }))
    current = undefined
  }

  for (const [index, line] of lines.entries()) {
    const anchor = parseAnchorLine(line)
    if (anchor !== undefined) {
      flush()
      current = { ...anchor, body: [] }
      continue
    }
    if (ANCHOR_LOOKALIKE.test(line.trim())) {
      return err(invalidInput(`comment anchor on line ${index + 1} does not parse (quote the author if it contains "|")`, {
        line: index + 1,
        text: line.trim(),
      }))
    }
    if (current === undefined) preambleLines.push(line)
    else current.body.push(line)
  }
  flush()

  return ok(Object.freeze({
    comments: Object.freeze(comments),
    preamble: preambleLines.join('\n').trim(),
  }))
}

/** The next id this machine may use in a file that already holds `existing` comments. */
export const nextSequence = (existing: readonly Comment[], machineId: string): number => {
  const short = machineShortCode(machineId)
  let highest = 0
  for (const comment of existing) {
    const parts = /^c-([0-9a-z]{2,8})-(\d+)$/.exec(comment.id)
    if (parts?.[1] !== short) continue
    highest = Math.max(highest, Number.parseInt(parts[2] ?? '0', 10))
  }
  return highest + 1
}

export type AppendedComment = Readonly<{ comment: Comment; rendered: string }>

/**
 * Render the block a batch of pending comments appends to a file, allocating ids in order.
 * The caller only ever appends: an existing comment is never rewritten here (editing one
 * is `rev+1` on that entry, which belongs to a later increment).
 */
export const appendComments = (
  existingText: string,
  pending: readonly PendingComment[],
  machineId: string,
): Result<readonly AppendedComment[], JiraError> => {
  const parsed = parseComments(existingText)
  if (!parsed.ok) return parsed
  if (pending.length === 0) return ok(Object.freeze([]))

  let sequence = nextSequence(parsed.value.comments, machineId)
  const appended: AppendedComment[] = []
  for (const entry of pending) {
    const id = commentId(machineId, sequence)
    sequence += 1
    const comment: Comment = Object.freeze({
      id,
      author: entry.author,
      revision: 1,
      createdAt: entry.createdAt,
      body: entry.body,
    })
    const anchor = commentAnchor(id, comment.author, comment.createdAt, comment.revision)
    appended.push(Object.freeze({ comment, rendered: `${anchor}\n${entry.body.replace(/\n+$/, '')}\n` }))
  }
  return ok(Object.freeze(appended))
}

/**
 * The whole file's text after appending: the existing text (preamble included) plus the
 * rendered blocks, with exactly one trailing newline.
 */
export const withAppendedComments = (
  existingText: string,
  appended: readonly AppendedComment[],
): string => {
  const base = existingText.replaceAll('\r\n', '\n').replace(/\n*$/, '')
  if (appended.length === 0) return base === '' ? '' : `${base}\n`
  const blocks = appended.map(entry => entry.rendered).join('\n').replace(/\n*$/, '')
  return `${base === '' ? '' : `${base}\n\n`}${blocks}\n`
}
