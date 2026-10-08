/**
 * Authoring checks for the `.dsh` namespaces whose content other plugins
 * consume: `rules`, read by the workspace-instruction loader, and `skills`, read
 * by the project skill root. Both refuse at write time, so a file that the
 * consumer would ignore — or that duplicates one already loaded — never reaches
 * the store.
 * @module @deepseek-ai/dsh-tool-dsh-store/namespaces
 */

import { parse as parseYaml } from 'yaml'
import { isSkillName } from '@deepseek-ai/dsh-skill'

/** A rule file: Markdown anywhere under `rules/`, nested directories included. */
export const RULES_NAMESPACE_PATTERN = /^rules\/(?:[^/]+\/)*[^/]+\.md$/u
/** A skill document: `skills/<name>.md` or `skills/<name>/SKILL.md`, the two shapes the skill root discovers. */
export const SKILLS_NAMESPACE_PATTERN = /^skills\/(?:[^/]+\.md|[^/]+\/SKILL\.md)$/u

/** Frontmatter keys the skill loader rejects, with the canonical spelling it requires instead. */
const LEGACY_SKILL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
]

/** Whether a `.dsh`-relative path names a rule file. */
export function isRulesPath(displayPath: string): boolean {
  return displayPath === 'rules' || displayPath.startsWith('rules/')
}

/** Whether a `.dsh`-relative path names something inside the skill namespace. */
export function isSkillsPath(displayPath: string): boolean {
  return displayPath === 'skills' || displayPath.startsWith('skills/')
}

/**
 * Validate file content written into a namespace another plugin consumes.
 * The `rules` check covers the shape of a rule; the `skills` check covers the
 * document the skill root needs in order to load the skill at all. Duplicate
 * detection for rules needs the loaded set and stays with the caller.
 * @param displayPath - the `.dsh`-relative target path.
 * @param content - the text about to be written.
 * @throws Error naming the violated authoring rule; nothing is written.
 */
export function validateNamespaceContent(displayPath: string, content: string): void {
  if (isRulesPath(displayPath)) {
    if (!RULES_NAMESPACE_PATTERN.test(displayPath)) {
      throw new Error('invalid rule: a rule file is Markdown under `rules/`, for example `rules/api.md`')
    }
    if (content.trim().length === 0) throw new Error('invalid rule: rule text must not be empty')
    return
  }
  if (isSkillsPath(displayPath)) validateSkillDocument(displayPath, content)
}

/** Validate one skill document against the fields the skill root requires. */
function validateSkillDocument(displayPath: string, content: string): void {
  if (!SKILLS_NAMESPACE_PATTERN.test(displayPath)) {
    throw new Error('invalid skill: a skill is `skills/<name>.md` or `skills/<name>/SKILL.md`')
  }
  const data = frontmatterData(content)
  if (data === undefined) {
    throw new Error('invalid skill: a skill document starts with a YAML frontmatter block between `---` lines')
  }
  const name = data['name']
  if (typeof name !== 'string' || name.length === 0) throw new Error('invalid skill: frontmatter requires `name`')
  if (!isSkillName(name)) {
    throw new Error(`invalid skill: name ${JSON.stringify(name)} must be lowercase words joined by single hyphens`)
  }
  const description = data['description']
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('invalid skill: frontmatter requires a non-empty `description`')
  }
  for (const [legacy, canonical] of LEGACY_SKILL_KEYS) {
    if (Object.hasOwn(data, legacy)) {
      throw new Error(`invalid skill: frontmatter field ${JSON.stringify(legacy)} is unsupported; use ${JSON.stringify(canonical)}`)
    }
  }
}

/** Read the leading frontmatter block as a mapping, or undefined when it is not one. */
function frontmatterData(content: string): Record<string, unknown> | undefined {
  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(normalized)
  if (match === null) return undefined
  const parsed = parseFrontmatterYaml(match[1] ?? '')
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

/** Parse one frontmatter block; a YAML error means the document cannot be a skill document. */
function parseFrontmatterYaml(source: string): unknown {
  try {
    return parseYaml(source)
  } catch {
    // The block failed to parse, so it cannot describe a skill; the caller
    // reports missing frontmatter and refuses the write.
    return undefined
  }
}
