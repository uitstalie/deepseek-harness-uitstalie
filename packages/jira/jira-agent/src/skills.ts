/**
 * plugin/skills — the three skills that teach an agent to use the ledger (decision 88).
 *
 * They are plain Markdown files shipped with the package (`skills/*.md`) and registered as
 * runtime skills, so the words a model reads and the words a human can review are the same
 * artifact. Nothing here imports a host package (decision 108): the shape we need is
 * declared below and the host supplies it.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { type JiraError, ioFailed } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { type Result, err, ok } from '@deepseek-ai/dsh-jira-core/result.ts'

/** One skill as the host's registry takes it: name, catalogue description, Markdown body and source. */
export type SkillDefinition = Readonly<{
  name: string
  description: string
  content: string
  source: string
}>

/** The slice of the host context this plugin needs (decision 108): an optional skill registry. */
export type SkillsHost = Readonly<{
  skills?: Readonly<{ register(definition: SkillDefinition): () => void }>
}>

/** The catalogue entries: name and the one line a model sees before loading the body. */
export const SKILL_CATALOGUE: readonly Readonly<{ name: string; description: string }>[] = Object.freeze([
  Object.freeze({
    name: 'jira-work',
    description: 'Work one dsh-jira issue end to end: read, claim, comment, move along the declared transitions, close with a resolution.',
  }),
  Object.freeze({
    name: 'jira-board',
    description: 'See the state of play across all dsh-jira issues: the board, the default list, and how to read a column.',
  }),
  Object.freeze({
    name: 'jira-triage',
    description: 'Triage the dsh-jira ledger: find stale and duplicate work, link blockers, and close issues only when answered.',
  }),
])

/**
 * `skills/` sits beside `src/` and `dist/`, so this resolves in both layouts.
 * @param name - the skill name, without the `.md` suffix.
 * @param base - the package root the `skills/` directory hangs under.
 * @returns the path of the skill's Markdown file.
 */
export const skillPath = (name: string, base: string): string => `${base}/skills/${name}.md`

/**
 * Read one shipped skill's Markdown body.
 * @param name - the skill name, without the `.md` suffix.
 * @param base - the package root the `skills/` directory hangs under.
 * @returns the file's text, or an I/O error naming the path that could not be read.
 */
export const readSkillBody = async (name: string, base: string): Promise<Result<string, JiraError>> => {
  try {
    return ok(await readFile(skillPath(name, base), 'utf8'))
  } catch (cause) {
    return err(ioFailed(`cannot read the ${name} skill`, { path: skillPath(name, base), cause: String(cause) }))
  }
}

/**
 * Register what the package ships. A skill whose file is missing is skipped rather than
 * crashing the plugin: a broken skill must never stop the tools from working.
 * @param ctx - the host slice whose `skills` registry receives the definitions.
 * @param base - the package root the `skills/` directory hangs under.
 * @returns the registered and skipped skill names, plus the undo that removes them again.
 */
export const registerSkills = async (
  ctx: SkillsHost,
  base: string,
): Promise<Readonly<{ registered: readonly string[]; skipped: readonly string[]; unregister: () => void }>> => {
  const registry = ctx.skills
  if (registry === undefined) {
    return Object.freeze({ registered: Object.freeze([]), skipped: Object.freeze([]), unregister: () => undefined })
  }

  const registered: string[] = []
  const skipped: string[] = []
  // Decision 166: a live config reload re-runs `apply`, so the skills it registered have to be
  // removable — otherwise the catalogue grows a duplicate set on every reload.
  const undoS: (() => void)[] = []
  for (const entry of SKILL_CATALOGUE) {
    const body = await readSkillBody(entry.name, base)
    if (!body.ok || body.value.trim() === '') {
      skipped.push(entry.name)
      continue
    }
    const undo = registry.register(Object.freeze({
      name: entry.name,
      description: entry.description,
      content: body.value,
      source: 'runtime',
    }))
    if (typeof undo === 'function') undoS.push(undo as () => void)
    registered.push(entry.name)
  }
  return Object.freeze({
    registered: Object.freeze(registered),
    skipped: Object.freeze(skipped),
    unregister: () => {
      for (const undo of undoS.reverse()) {
        try {
          undo()
        } catch {
          // One failing undo must not leave the rest registered.
        }
      }
    },
  })
}

/**
 * The directory the skills are read from, given a module URL (`…/src/plugin/` → package root).
 *
 * `fileURLToPath`, not `URL.pathname`: `pathname` stays percent-encoded, so a package living
 * under a non-ASCII directory (a `桌面` clone, say) resolved to a path that does not exist and
 * every shipped skill was skipped in silence. `fileURLToPath` also owns the Windows `/D:/…`
 * form that this used to fix up by hand.
 * @param moduleUrl - the `import.meta.url` of a module inside the package.
 * @returns the package root path, with no trailing separator.
 */
export const packageRootFrom = (moduleUrl: string): string =>
  fileURLToPath(new URL('../', moduleUrl)).replace(/[\\/]$/u, '')
