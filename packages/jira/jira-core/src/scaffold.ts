/**
 * core/scaffold — `jira init`: create a store that a human can immediately read and edit.
 *
 * Decision 5 owns the ordering (`.gitattributes` first), decision 81 the git settings, and
 * this module the starter vocabulary. The starter is a **default, not a contract**: it is
 * written once, never overwritten, and the file itself is the place to change the rules
 * (decisions 102 ② and 105).
 */

import { join } from 'node:path'

import { type JiraError } from './errors.ts'
import { GITATTRIBUTES, GITIGNORE, initializeRepository } from './git.ts'
import { type Result, err, ok } from './result.ts'
import { mkdirp, readText, writeTextAtomic } from './io.ts'
import { storePaths } from './store.ts'

export const STARTER_CONFIG = `---
# The vocabulary of this store. Every value below is data: change it and the rules change
# (statuses, the transitions between them, which statuses are closed, the priorities).
type: config
schema: config/v1
issue_types: [task, bug, chore]
kb_types: [runbook, pitfall, howto, concept]
priorities: [S1, S2, S3, S4, S5]

# \`order\` is the board's column order; low to high, left to right.
statuses:
  - { name: todo, order: 10 }
  - { name: in_progress, order: 20 }
  - { name: in_review, order: 30 }
  - { name: closed, order: 90 }
  - { name: cancelled, order: 95 }

# A status in this list needs a resolution to be entered, and clearing the conclusion on
# the way out is automatic (decisions 25/72).
closed: [closed, cancelled]

resolutions: [fixed, invalid, limitation, abandoned]

# Directed edges. Everything not listed here is refused, with the legal targets named.
transitions:
  - [todo, in_progress]
  - [todo, closed]
  - [todo, cancelled]
  - [in_progress, in_review]
  - [in_progress, closed]
  - [in_progress, cancelled]
  - [in_review, in_progress]   # 打回
  - [in_review, closed]
  - [in_review, cancelled]
  - [closed, in_progress]      # 重开
  - [cancelled, todo]
---

# This file is the store's vocabulary.
#
# * \`statuses\` order the board; each needs a unique \`order\`.
# * \`closed\` decides where a resolution is mandatory (and cleared on the way out).
# * \`transitions\` is the state machine: an edge that is not listed does not exist.
#
# Editing this file is the intended way to change the rules. Run \`jira doctor\` afterwards:
# a vocabulary that names a status it never declares is refused loudly rather than ignored.
`

export const STARTER_README = `# dsh-jira store

One Markdown file per issue under \`projects/<PROJECT>/issues/<PROJECT>-<n>.md\`, one file per
issue's comments under \`projects/<PROJECT>/comments/\`, and the rules in \`config.md\`.

* The files are the truth; git is the audit log (every write is committed).
* \`counters/<machine>.json\` holds this machine's number blocks — commit it so two machines
  never mint the same key (decision 74).
* Derived data (\`.jira/\`, \`var/\`) is ignored.
`

export type ScaffoldResult = Readonly<{
  root: string
  created: readonly string[]
  existed: readonly string[]
  gitInitialized: boolean
}>

/**
 * Create what is missing and never touch what exists. Safe to run repeatedly, which is what
 * makes it usable as "the store is not set up yet, set it up" from a tool, a command or CI.
 */
export const scaffoldStore = async (root: string): Promise<Result<ScaffoldResult, JiraError>> => {
  const created: string[] = []
  const existed: string[] = []

  for (const directory of [
    root,
    join(root, 'projects'),
    join(root, 'tags'),
    join(root, 'machines'),
    join(root, '.jira', 'locks'),
  ]) {
    const made = await mkdirp(directory)
    if (!made.ok) return made
  }

  const files: readonly (readonly [string, string])[] = [
    [storePaths.config(root), STARTER_CONFIG],
    [join(root, 'README.md'), STARTER_README],
    [join(root, '.gitignore'), GITIGNORE],
    [join(root, '.gitattributes'), GITATTRIBUTES],
  ]
  for (const [path, content] of files) {
    const existing = await readText(path)
    if (existing.ok) {
      existed.push(path)
      continue
    }
    const written = await writeTextAtomic(path, content)
    if (!written.ok) return err(written.error)
    created.push(path)
  }

  const git = await initializeRepository(root)
  if (!git.ok) return git
  return ok(Object.freeze({
    root,
    created: Object.freeze(created),
    existed: Object.freeze(existed),
    gitInitialized: git.value,
  }))
}
