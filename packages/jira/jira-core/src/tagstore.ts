/**
 * core/tagstore — the tag registry's **write** path (decision 26).
 *
 * The read half has existed for a while: `loadTags` walks `tags/*.md` and takes each file's
 * `description` and `aliases`, `lintTags` complains about a tag with no description, and
 * `tags/index.md` renders the pair. What was missing was any way to **create** one, so the registry
 * could only ever be filled by hand — and a tag with no description is exactly what decision 26
 * exists to prevent.
 *
 * So this module is deliberately small and strict:
 *
 *   - the name is **lowercased** (a tag is `lower-kebab`, decision 76) and then must be legal:
 *   - the **description is required** (that is the registry's whole purpose: explaining the tag to
 *     the next person, and the reason `lintTags` has a "missing description" section at all);
 *   - a name that is already registered is refused, and the refusal quotes the existing description,
 *     so the answer to "why not?" is in the error itself.
 *
 * A created tag is committed like any other store write, with the `[no-issue]` subject shape
 * (decision 67) because registering a tag is not work on an issue.
 */

import { join } from 'node:path'

import { type Timestamp } from './entity.ts'
import { type JiraError, invalidInput } from './errors.ts'
import { parseFrontmatter, renderFrontmatter, type Frontmatter } from './frontmatter.ts'
import { isTagName } from './tags.ts'
import { exists, readText, writeTextAtomic } from './io.ts'
import { type Result, err, ok } from './result.ts'
import { type Actor, type Store, commitStoreWrite } from './store.ts'

export const TAG_SCHEMA = 'tag/v1'
export const TAG_DOCUMENT_TYPE = 'tag'

export const tagPath = (name: string): string => `tags/${name}.md`

export type TagRecord = Readonly<{
  name: string
  description: string
  aliases?: readonly string[]
  createdBy: string
  createdAt: Timestamp
}>

const TAG_FIELDS: readonly string[] = Object.freeze([
  'schema', 'type', 'name', 'description', 'aliases', 'created_by', 'created_at',
])

export const encodeTag = (record: TagRecord): string => {
  const frontmatter: Frontmatter = Object.freeze({
    schema: TAG_SCHEMA,
    type: TAG_DOCUMENT_TYPE,
    name: record.name,
    description: record.description,
    aliases: Object.freeze([...(record.aliases ?? [])]),
    created_by: record.createdBy,
    created_at: record.createdAt,
  })
  return renderFrontmatter(frontmatter, `Why \`${record.name}\` exists.\n`)
}

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

export const decodeTag = (
  text: string,
  fallbackName: string,
): Result<Readonly<{ record: TagRecord; unknownKeys: readonly string[] }>, JiraError> => {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return parsed
  const frontmatter = parsed.value.frontmatter
  const unknownKeys = Object.keys(frontmatter).filter(key => !TAG_FIELDS.includes(key))
  const aliases = frontmatter.aliases
  return ok(Object.freeze({
    record: Object.freeze({
      name: asText(frontmatter.name) ?? fallbackName,
      description: asText(frontmatter.description) ?? '',
      ...(Array.isArray(aliases) && aliases.length > 0
        ? { aliases: Object.freeze(aliases.map(alias => String(alias))) }
        : {}),
      createdBy: asText(frontmatter.created_by) ?? '',
      createdAt: (asText(frontmatter.created_at) ?? '') as Timestamp,
    }),
    unknownKeys: Object.freeze(unknownKeys),
  }))
}

/** Read one registered tag; `undefined` when the name is not registered. */
export const readTag = async (store: Store, name: string): Promise<Result<TagRecord | undefined, JiraError>> => {
  const text = await readText(join(store.files.root, ...tagPath(name).split('/')))
  if (!text.ok) return ok(undefined)
  const decoded = decodeTag(text.value, name)
  return decoded.ok ? ok(decoded.value.record) : ok(undefined)
}

export type CreateTagInput = Readonly<{ name: string; description: string; aliases?: readonly string[] }>

/**
 * Register a tag (decision 26's `tag-create`). Every refusal names what to do about it: a bad name
 * shows the naming rule, a missing description says it is required and why, and a duplicate quotes
 * the description that is already there.
 * @param store - the ledger store the registry lives in.
 * @param actor - the identity and timestamp recorded on the registry commit.
 * @param input - the tag name, description, and optional aliases.
 * @returns the registered tag and whether it was committed, or the refusal.
 */
export const createTag = async (
  store: Store,
  actor: Actor,
  input: CreateTagInput,
): Promise<Result<Readonly<{ tag: TagRecord; committed: boolean }>, JiraError>> => {
  const name = input.name.trim().toLowerCase()
  if (!isTagName(name)) {
    return err(invalidInput(
      `"${input.name}" is not a legal tag name: lowercase letters, digits and "-", 1-32 characters, starting with a letter or digit`,
      { name: input.name },
    ))
  }
  const description = input.description.trim()
  if (description === '') {
    return err(invalidInput(
      `tag "${name}" needs a description: the registry exists so the next person knows what the tag means`,
      { name },
    ))
  }

  const existing = await readTag(store, name)
  if (!existing.ok) return existing
  if (existing.value !== undefined) {
    return err(invalidInput(
      `tag "${name}" is already registered (${existing.value.description})`,
      { name, description: existing.value.description, createdBy: existing.value.createdBy },
    ))
  }
  // A file that exists but does not decode is still a registration; do not overwrite it.
  const present = await exists(join(store.files.root, ...tagPath(name).split('/')))
  if (present) {
    return err(invalidInput(`tag "${name}" already has a file at ${tagPath(name)}`, { name, path: tagPath(name) }))
  }

  const aliases = Object.freeze([...(input.aliases ?? [])].map(alias => alias.trim().toLowerCase()).filter(alias => alias !== ''))
  const record: TagRecord = Object.freeze({
    name,
    description,
    ...(aliases.length === 0 ? {} : { aliases }),
    createdBy: actor.by,
    createdAt: actor.at,
  })

  const written = await writeTextAtomic(join(store.files.root, ...tagPath(name).split('/')), encodeTag(record))
  if (!written.ok) return written
  const commit = await commitStoreWrite(store, actor.at, [tagPath(name)], `tag ${name} [no-issue]`)
  if (!commit.ok) return commit
  return ok(Object.freeze({ tag: record, committed: commit.value.committed }))
}
