/**
 * The session-level director note: one short instruction per session, injected as a depth-0
 * `director-note` user message so it applies to the current scene without rewriting the stable
 * system prompt.
 *
 * A note is set and cleared by a human through `/director`; nothing here is model-facing input the
 * model can write. The note lives in this process only, is bounded by
 * {@link DIRECTOR_NOTE_MAX_BYTES}, and is re-published at the end of every completed turn so a
 * compaction cannot silently drop it. A clear replaces the note with a one-line placeholder; the
 * next set replaces that placeholder.
 * @module @deepseek-ai/dsh-persona-card/director
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'director-note': DirectorNoteSource
  }
}

/** Message source carried by the depth-0 director note. */
export interface DirectorNoteSource {
  /** Producer identity; consumers that do not know it fall through. */
  readonly kind: 'director-note'
  /** `snapshot` for a live note, `cleared` for the placeholder that replaced one. */
  readonly form: 'snapshot' | 'cleared'
  /** The rendered note, one section named {@link DIRECTOR_NOTE_SECTION_NAME}. */
  readonly sections: readonly { readonly name: string; readonly text: string }[]
}

/** Section name the note declares inside its source. */
export const DIRECTOR_NOTE_SECTION_NAME = 'director-note'

/** Opening line that labels the note as the current scene rather than a rule change. */
export const DIRECTOR_NOTE_TITLE = 'Director note for this scene (system and developer instructions still win).'

/** Placeholder text a clear leaves at depth 0. */
export const DIRECTOR_NOTE_CLEARED = 'Director note: none for this session.'

/** Maximum note text, in UTF-8 bytes. */
export const DIRECTOR_NOTE_MAX_BYTES = 800

/**
 * Collapse a note onto a readable shape and enforce the byte budget.
 * @param text - the raw user text.
 * @returns the trimmed note.
 * @throws Error when the note is empty or over the byte budget.
 */
export function normalizeDirectorNote(text: string): string {
  const note = text.trim()
  if (note === '') throw new Error('a director note needs non-empty text')
  const bytes = Buffer.byteLength(note, 'utf8')
  if (bytes > DIRECTOR_NOTE_MAX_BYTES) {
    throw new Error(`a director note is at most ${String(DIRECTOR_NOTE_MAX_BYTES)} bytes; this one is ${String(bytes)}`)
  }
  return note
}

/**
 * Render the model-facing text of one note.
 * @param note - the note, or undefined for the cleared placeholder.
 * @returns the labeled text.
 */
export function renderDirectorNote(note: string | undefined): string {
  return note === undefined ? `${DIRECTOR_NOTE_TITLE}\n${DIRECTOR_NOTE_CLEARED}` : `${DIRECTOR_NOTE_TITLE}\n${note}`
}

/**
 * Build the depth-0 director-note message.
 * @param note - the note, or undefined for the cleared placeholder.
 * @returns the user message carrying the note.
 */
export function directorNoteMessage(note: string | undefined): UserMessage {
  const text = renderDirectorNote(note)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'director-note',
      form: note === undefined ? 'cleared' : 'snapshot',
      sections: [{ name: DIRECTOR_NOTE_SECTION_NAME, text }],
    },
  })
}

/**
 * Replace this session's previous note, or append the first one.
 *
 * The target is process-local; a target that left the surface (a compaction) falls back to an
 * append so the note stays visible.
 * @param ctx - plugin context, for the debug log on a stale target.
 * @param session - session receiving the note.
 * @param note - the note, or undefined to write the cleared placeholder.
 * @param targets - provider-owned map of session id to the last note seq.
 */
export function syncDirectorNote(
  ctx: Context,
  session: Session,
  note: string | undefined,
  targets: Map<string, SessionSeq>,
): void {
  const sessionId = String(session.id)
  const message = directorNoteMessage(note)
  const target = targets.get(sessionId)
  if (target === undefined) {
    targets.set(sessionId, session.append('user/message', message, { surfaceOp: 'append' }).seq)
    return
  }
  try {
    targets.set(sessionId, session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: target, endSeq: target },
      sourceEventSeqs: [target],
    }).seq)
  } catch (error: unknown) {
    ctx.logger.debug('persona: appending director note instead of replacing: %s', error instanceof Error ? error.message : String(error))
    targets.set(sessionId, session.append('user/message', message, { surfaceOp: 'append' }).seq)
  }
}

/**
 * Message source type guard for readers and tests.
 * @param source - a persisted message source.
 * @returns whether the source is the director-note source.
 */
export function isDirectorNoteSource(source: MessageSource): source is DirectorNoteSource {
  return source.kind === 'director-note'
}
