/**
 * The persona-card capability provider: mount one role-play card per session.
 *
 * The provider loads `$DSH_HOME/persona/*.md` once, keeps the set fresh while the directory
 * changes, and registers one `persona` system-prompt section with the capability organizer. The
 * section text is evaluated per assembly from the session's selection: `/persona use <id>` picks
 * a card for that session, `/persona off` suppresses the section, and a session that never chose
 * falls back to the row's `active` card. A selection lives in this process only.
 *
 * @module @deepseek-ai/dsh-persona-card/provider
 */

import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CapabilityContribution } from '@deepseek-ai/dsh-dafeiyu'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { parse } from 'yaml'
import { parsePersonaCard, renderPersonaText } from './card.ts'
import { registerDirectorCommand, registerPersonaCommands, type DirectorCommandTarget, type PersonaCommandTarget } from './commands.ts'
import { PersonaStateStore, personaStateTool, syncPersonaStateMessage } from './state.ts'
import type { PersonaStateTarget } from './state.ts'
import { syncDirectorNote } from './director.ts'
import { DEFAULT_PERSONA_MAX_BYTES, type PersonaCard, type PersonaResult } from './types.ts'

/** Cordis plugin name. */
export const name = 'persona-card'
/** The organizer wires the contribution; commands are an optional human surface. */
export const inject = ['dafeiyu']

/** The directory under `$DSH_HOME` that holds `*.md` cards. */
export const PERSONA_CARDS_DIRECTORY = 'persona'

/** The system-prompt section name: after the deployment prefix, before `personality`. */
export const PERSONA_CARD_SECTION_NAME = 'persona'
/** The section order: after the deployment prefix, before `personality`. */
export const PERSONA_CARD_SECTION_ORDER = 50

/** How long a burst of directory events coalesces before the cards are re-read. */
const WATCH_DEBOUNCE_MS = 50

/** Row configuration, accepting live references or plain test values. */
export interface Config {
  /** Card id (file name without `.md`) used by sessions that never chose one; empty disables the section. */
  readonly active?: Volatile<string> | string | undefined
  /** Injection budget for one card, in UTF-8 bytes. */
  readonly maxBytes?: Volatile<number> | number | undefined
}

/** Row configuration schema. */
export const Config = z.object({
  /** Card id (file name without `.md`) used by sessions that never chose one; empty disables the section. */
  active: z.string().default('').volatile(),
  /** Injection budget for one card, in UTF-8 bytes. */
  maxBytes: z.number().step(1).min(1).default(DEFAULT_PERSONA_MAX_BYTES).volatile(),
})

/** One mounted card and the files skipped while loading. */
export interface PersonaCards {
  readonly cards: ReadonlyMap<string, PersonaCard>
  readonly warnings: readonly string[]
}

/** Read one live row value. */
const current = <T>(value: Volatile<T> | T | undefined): T | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

/**
 * Parse one Markdown card file: YAML frontmatter plus optional body.
 * @param text - the file contents.
 * @param options - the injection budget.
 * @returns the parsed card, or the validation failure.
 */
export const parsePersonaFile = (text: string, options: { maxBytes?: number } = {}): PersonaResult<PersonaCard> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text)
  if (match === null) {
    return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid-card', message: 'a card file needs a YAML frontmatter block' }) })
  }
  let front: unknown
  try {
    front = parse(match[1] ?? '')
  } catch (error: unknown) {
    return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid-card', message: `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}` }) })
  }
  if (typeof front !== 'object' || front === null || Array.isArray(front)) {
    return Object.freeze({ ok: false, error: Object.freeze({ code: 'invalid-card', message: 'frontmatter must be a YAML object' }) })
  }
  const body = (match[2] ?? '').trim()
  return parsePersonaCard({ ...(front as Record<string, unknown>), ...(body === '' ? {} : { body }) }, options)
}

/**
 * Read every `$DSH_HOME/persona/*.md` card.
 * @param options - the injection budget and an optional logger for skipped files.
 * @returns the cards by id and one warning per skipped file.
 */
export const loadPersonaCards = async (
  options: { maxBytes?: number; warn?: (message: string) => void } = {},
): Promise<PersonaCards> => {
  const cards = new Map<string, PersonaCard>()
  const warnings: string[] = []
  const directory = join(resolveDshHome(), PERSONA_CARDS_DIRECTORY)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ cards, warnings })
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const id = entry.name.slice(0, -3)
    try {
      const parsed = parsePersonaFile(await readFile(join(directory, entry.name), 'utf8'), options)
      if (parsed.ok) cards.set(id, parsed.value)
      else {
        const message = `ignoring persona card ${entry.name}: ${parsed.error.message}`
        warnings.push(message)
        options.warn?.(message)
      }
    } catch (error: unknown) {
      const message = `could not read persona card ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
      warnings.push(message)
      options.warn?.(message)
    }
  }
  return Object.freeze({ cards, warnings: Object.freeze(warnings) })
}

/**
 * Register the capability and the `/persona` command.
 * @param ctx - the plugin context.
 * @param config - the row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const active = (): string => current(config.active) ?? ''
  const maxBytes = (): number => current(config.maxBytes) ?? DEFAULT_PERSONA_MAX_BYTES
  const directory = join(resolveDshHome(), PERSONA_CARDS_DIRECTORY)

  let cards: PersonaCards = Object.freeze({ cards: new Map<string, PersonaCard>(), warnings: Object.freeze([]) })
  const rendered = new WeakMap<PersonaCard, string>()
  /** Explicit per-session choices; `null` means "off", an absent key means "use the row default". */
  const selections = new Map<string, string | null>()
  const warnedMissing = new Set<string>()
  /** Process-local state and the surface target of each session's state message. */
  const state = new PersonaStateStore()
  const stateTargets = new Map<string, SessionSeq>()
  /** Process-local director notes and the surface target of each session's note message. */
  const directorNotes = new Map<string, string>()
  const directorTargets = new Map<string, SessionSeq>()
  /** Live agents by session, weakly held so a session map never outlives its agent. */
  const agents = new Map<string, WeakRef<Agent>>()
  let refreshing: Promise<void> | undefined
  let watcher: FSWatcher | undefined
  let debounce: NodeJS.Timeout | undefined
  let disposed = false

  const selectionOf = (sessionId: string): string | null | undefined => selections.get(sessionId)
  const effectiveOf = (sessionId: string): string => {
    const selection = selections.get(sessionId)
    if (selection !== undefined) return selection ?? ''
    return active()
  }
  const textFor = (sessionId: string): string => {
    const id = effectiveOf(sessionId)
    if (id === '') return ''
    const card = cards.cards.get(id)
    if (card === undefined) return ''
    let text = rendered.get(card)
    if (text === undefined) {
      text = renderPersonaText(card)
      rendered.set(card, text)
    }
    return text
  }

  const stateTarget: PersonaStateTarget = {
    cardIdFor: effectiveOf,
    cardFor: (sessionId) => {
      const id = effectiveOf(sessionId)
      return id === '' ? undefined : cards.cards.get(id)
    },
    store: state,
    targets: stateTargets,
  }

  /** Rewrite the session's depth-0 state message for the card it now shows. */
  const syncState = (agent: Agent): void => {
    const sessionId = String(agent.session.id)
    const record = state.read(sessionId, effectiveOf(sessionId))
    syncPersonaStateMessage(ctx, agent.session, record, stateTargets)
  }

  /** Publish this session's director note again so it stays the last instruction in history. */
  const syncDirector = (session: Session): void => {
    const note = directorNotes.get(String(session.id))
    if (note === undefined) return
    syncDirectorNote(ctx, session, note, directorTargets)
  }

  /**
   * Re-read the card directory once. Concurrent calls share one read, and a failed read keeps the
   * previous cards: a half-written file must not empty a live session's persona.
   */
  const refresh = (): Promise<void> => {
    refreshing ??= (async () => {
      let loaded: PersonaCards
      try {
        loaded = await loadPersonaCards({ maxBytes: maxBytes(), warn: (message) => { ctx.logger.warn('persona: %s', message) } })
      } catch (error: unknown) {
        ctx.logger.warn('persona: could not load cards: %s', error instanceof Error ? error.message : String(error))
        return
      }
      if (disposed) return
      cards = loaded
      const id = active()
      if (id !== '' && loaded.cards.has(id)) warnedMissing.delete(id)
      if (id !== '' && !loaded.cards.has(id) && !warnedMissing.has(id)) {
        warnedMissing.add(id)
        ctx.logger.warn('persona: active card %s was not found', id)
      }
    })().finally(() => { refreshing = undefined })
    return refreshing
  }

  const scheduleRefresh = (): void => {
    if (disposed) return
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void refresh()
    }, WATCH_DEBOUNCE_MS)
    debounce.unref?.()
  }

  /**
   * Watch the card directory. A directory that does not exist yet (or a backend without watching)
   * degrades to re-reading when an agent is created, which is the next assembly that can see the
   * change anyway.
   */
  const startWatch = (): void => {
    if (disposed) return
    try {
      watcher = watch(directory, { persistent: false }, () => { scheduleRefresh() })
      watcher.on('error', (error) => {
        ctx.logger.debug('persona: card watch is unavailable for %s: %s', directory, error.message)
      })
    } catch (error: unknown) {
      ctx.logger.debug(
        'persona: card watch is unavailable for %s; cards are re-read when an agent is created: %s',
        directory,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  ctx.effect(() => () => {
    disposed = true
    if (debounce !== undefined) clearTimeout(debounce)
    watcher?.close()
    watcher = undefined
  }, 'persona-card.watch()')

  void refresh().then(startWatch, startWatch)

  const registration = ctx.dafeiyu.register({
    id: 'persona',
    contractVersion: 2,
    label: 'Persona',
    description: 'Role-play character card injected as one stable prompt section',
    config: { active: active(), maxBytes: maxBytes() },
    enabledByDefault: false,
    create: async (): Promise<CapabilityContribution> => {
      // The first assembly after activation must see the cards on disk, not the empty cache.
      await refresh()
      const sectionFor = (agent: Agent): PromptSection => ({
        name: PERSONA_CARD_SECTION_NAME,
        order: PERSONA_CARD_SECTION_ORDER,
        text: () => textFor(String(agent.session.id)),
      })
      return {
        scope: 'all',
        promptSections: agent => [sectionFor(agent)],
        tools: () => [personaStateTool(ctx, stateTarget)],
        onAgentCreated: (agent: Agent) => {
          const sessionId = String(agent.session.id)
          agents.set(sessionId, new WeakRef(agent))
          void refresh()
          const record = state.read(sessionId, effectiveOf(sessionId))
          if (record !== undefined) syncState(agent)
        },
      }
    },
  })
  ctx.effect(() => registration, 'persona-card.register()')

  // The director note is a session-level instruction, not a persona card face: its own capability
  // republishes it after every completed turn and when a new agent starts.
  const directorRegistration = ctx.dafeiyu.register({
    id: 'director',
    contractVersion: 2,
    label: 'Director note',
    description: 'Session-level short instruction injected as one depth-0 message',
    config: {},
    enabledByDefault: true,
    create: (): CapabilityContribution => ({
      scope: 'all',
      onTurnEnd: (input) => { syncDirector(input.session) },
      onAgentCreated: (agent) => { syncDirector(agent.session) },
    }),
  })
  ctx.effect(() => directorRegistration, 'persona-card.director()')

  // `/persona` is a human surface: like `/personality`, it is not gated by the capability switch.
  const target: PersonaCommandTarget = {
    directory,
    cards: () => [...cards.cards.keys()].sort((left, right) => left.localeCompare(right)),
    selectionOf,
    effectiveOf,
    select: (sessionId, selection) => {
      const previous = effectiveOf(sessionId)
      if (selection === null) selections.set(sessionId, null)
      else selections.set(sessionId, selection)
      // A session that switched cards must stop showing the old card's state.
      if (previous === effectiveOf(sessionId)) return
      const agent = agents.get(sessionId)?.deref()
      if (agent !== undefined) syncState(agent)
    },
  }
  const directorTarget: DirectorCommandTarget = {
    textOf: sessionId => directorNotes.get(sessionId),
    set: (agent, note) => {
      directorNotes.set(String(agent.session.id), note)
      syncDirector(agent.session)
    },
    clear: (agent) => {
      const sessionId = String(agent.session.id)
      directorNotes.delete(sessionId)
      if (!directorTargets.has(sessionId)) return
      syncDirectorNote(ctx, agent.session, undefined, directorTargets)
    },
  }
  ctx.inject(['commands'], (commandCtx) => {
    ctx.effect(() => registerPersonaCommands(commandCtx, target), 'persona-card.commands()')
    ctx.effect(() => registerDirectorCommand(commandCtx, directorTarget), 'persona-card.director-command()')
  })
}
