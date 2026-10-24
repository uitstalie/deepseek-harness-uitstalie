/**
 * core/machines — the machine registry behind `jira machines` (decisions 73/91).
 *
 * `machines/<machine_id>.md` is **shared audit data** that lives inside the store on purpose
 * (decision 73's classification): "who wrote this" must be answerable on the other machine, and a
 * bare `m-357504ff` answers nothing. The label is optional, so the display rule is fixed instead:
 * **show the label when there is one, otherwise the first six characters of the id** (decision 91) —
 * short enough for a board column, specific enough to grep.
 *
 * Writing a label is a normal store write: lock the id, write atomically, commit (decisions 58/60).
 */

import { join } from 'node:path'

import { type Timestamp } from './entity.ts'
import { type JiraError, invalidInput } from './errors.ts'
import { parseFrontmatter, renderFrontmatter, type Frontmatter } from './frontmatter.ts'
import { noIssueSubject } from './git.ts'
import { listDir, readText, writeTextAtomic } from './io.ts'
import { issueLockPath, lockOptionsOf, lockOwnerOf, withLock } from './lock.ts'
import { type Result, err, ok } from './result.ts'
import { type Actor, type Store, commitStoreWrite } from './store.ts'
import { isMachineId } from './machine.ts'

export const MACHINE_SCHEMA = 'machine/v1'

export type MachineRecord = Readonly<{
  machineId: string
  label?: string
  os?: string
  firstSeen?: string
  note?: string
  /** Warnings from a tolerant read; a half-written registry entry must not stop the list. */
  warnings: readonly string[]
}>

export const machinePath = (machineId: string): string => `machines/${machineId}.md`

/** The display rule of decision 91, in one place so the board, the KB view and the CLI agree. */
export const machineDisplayName = (machineId: string, records: readonly MachineRecord[] = []): string => {
  const label = records.find(record => record.machineId === machineId)?.label
  return label !== undefined && label !== '' ? label : machineId.slice(0, 6)
}

export const listMachines = async (store: Store): Promise<Result<readonly MachineRecord[], JiraError>> => {
  const directory = join(store.files.root, 'machines')
  const listed = await listDir(directory)
  if (!listed.ok) return ok(Object.freeze([]))
  const names = listed.value.filter(name => name.endsWith('.md')).sort()

  const records: MachineRecord[] = []
  for (const name of names) {
    const machineId = name.slice(0, -3)
    const text = await readText(join(directory, name))
    if (!text.ok) continue
    const parsed = parseFrontmatter(text.value)
    if (!parsed.ok) {
      records.push(Object.freeze({
        machineId,
        warnings: Object.freeze([`frontmatter does not parse: ${parsed.error.message}`]),
      }))
      continue
    }
    const fm = parsed.value.frontmatter
    const warnings: string[] = []
    for (const field of ['label', 'os', 'first_seen', 'note'] as const) {
      if (fm[field] !== undefined && typeof fm[field] !== 'string') warnings.push(`"${field}" must be a string`)
    }
    if (fm.machine_id !== undefined && String(fm.machine_id) !== machineId) {
      warnings.push(`machine_id "${String(fm.machine_id)}" disagrees with the file name`)
    }
    const str = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    records.push(Object.freeze({
      machineId,
      ...(str(fm.label) === undefined ? {} : { label: str(fm.label) as string }),
      ...(str(fm.os) === undefined ? {} : { os: str(fm.os) as string }),
      ...(str(fm.first_seen) === undefined ? {} : { firstSeen: str(fm.first_seen) as string }),
      ...(str(fm.note) === undefined ? {} : { note: str(fm.note) as string }),
      warnings: Object.freeze(warnings),
    }))
  }
  return ok(Object.freeze(records))
}

export type LabelInput = Readonly<{
  label: string
  os?: string
  note?: string
}>

/**
 * Give this machine a label, creating the entry on first use. `first_seen` is preserved once set —
 * it is the one field that is history rather than configuration.
 */
export const labelMachine = async (
  store: Store,
  actor: Actor,
  machineId: string,
  input: LabelInput,
): Promise<Result<MachineRecord, JiraError>> => {
  if (!isMachineId(machineId)) {
    return err(invalidInput(`"${machineId}" is not a machine id`, { machineId }))
  }
  if (input.label.trim() === '') return err(invalidInput('a label must not be empty', { machineId }))

  return withLock(issueLockPath(store.files.root, machineId), lockOwnerOf(store, actor.at), lockOptionsOf(store), async () => {
    const existing = await readText(join(store.files.root, ...machinePath(machineId).split('/')))
    const previous = existing.ok ? parseFrontmatter(existing.value) : undefined
    const firstSeen = previous?.ok && typeof previous.value.frontmatter.first_seen === 'string'
      ? previous.value.frontmatter.first_seen
      : actor.at

    const frontmatter: Frontmatter = Object.freeze({
      schema: MACHINE_SCHEMA,
      machine_id: machineId,
      label: input.label.trim(),
      ...(input.os === undefined || input.os === '' ? {} : { os: input.os }),
      first_seen: firstSeen,
      ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
    })
    const path = machinePath(machineId)
    const written = await writeTextAtomic(
      join(store.files.root, ...path.split('/')),
      renderFrontmatter(frontmatter, `Label for ${machineId}.\n`),
    )
    if (!written.ok) return written
    const commit = await commitStoreWrite(store, actor.at as Timestamp, [path], noIssueSubject('machines label '))
    if (!commit.ok) return commit
    return ok(Object.freeze({
      machineId,
      label: input.label.trim(),
      ...(input.os === undefined || input.os === '' ? {} : { os: input.os }),
      firstSeen,
      ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
      warnings: Object.freeze([]),
    }))
  })
}

export const renderMachines = (records: readonly MachineRecord[], self: string): string => {
  const lines: string[] = []
  if (records.length === 0) lines.push('还没有登记任何机器')
  for (const record of records) {
    const mark = record.machineId === self ? '*' : ' '
    // Decision 91's display rule, in the one place machines are named: the label when there is one,
    // otherwise the first six characters of the id. The full id stays in the first column because
    // that is the argument `jira machines label` needs; `（无 label）` told a reader nothing.
    lines.push(`${mark} ${record.machineId}  ${machineDisplayName(record.machineId, records)}${record.os === undefined ? '' : `  ${record.os}`}`)
    for (const warning of record.warnings) lines.push(`    ! ${warning}`)
  }
  lines.push(`本机：${self}`)
  return `${lines.join('\n')}\n`
}

/**
 * Decision 91's hint, as a **value**: `undefined` once this machine has a label.
 *
 * Whether the hint has already been shown is machine-local state, and `core` keeps no state
 * (§3.1) — so the sentence is decided here and the *once* is the caller's marker (decision 150).
 */
export const machinesHint = (
  records: readonly MachineRecord[],
  self: string,
): string | undefined => {
  const label = records.find(record => record.machineId === self)?.label
  if (label !== undefined && label !== '') return undefined
  return '提示：本机还没有 label —— 命名一次，之后各处都用它显示本机：jira machines label --name <name>（这条提示只出现一次）'
}
