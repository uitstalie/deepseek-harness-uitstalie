/**
 * core/validate — the checks the write path performs before anything is written.
 *
 * Decision 49/80: writes are strict. These are the *shared* checks — the ones `create`,
 * `update` and `switch_state` all need — so the rules live once and the two callers
 * compose them instead of repeating them (decision 102 ②).
 */

import { type Identity, type IssueKey, asIdentity, asIssueKey, SUMMARY_MAX_CHARS } from './entity.ts'
import { type JiraError, invalidInput, resolutionRequired, unknownTag } from './errors.ts'
import { type Result, err, ok } from './result.ts'
import { type Vocab, isClosedStatus, isKnownStatus } from './vocab.ts'
import { type TagDef, isTagName, suggestTags } from './tags.ts'

export const validateSummary = (summary: string): Result<string, JiraError> => {
  const value = summary.trim()
  if (value === '') return err(invalidInput('summary must not be empty'))
  if (value.length > SUMMARY_MAX_CHARS) {
    return err(invalidInput(`summary must be at most ${SUMMARY_MAX_CHARS} characters`, {
      length: value.length,
      limit: SUMMARY_MAX_CHARS,
    }))
  }
  if (value.includes('\n')) return err(invalidInput('summary must be a single line'))
  return ok(value)
}

/**
 * Decision 48: an identity is `agent:<model>|<tool>|<machine_id>|<session_id>` — **four** components,
 * none empty — or `human:<name>` with no separator at all. Components may not contain the separator,
 * which is why the design needs no escaping anywhere; enforcing that here is what keeps it true.
 *
 * `asIdentity` stays tolerant (it only checks the prefix) because reading old files must not fail;
 * this is the **write**-side gate.
 */
export const validateIdentity = (value: string, field: string): Result<Identity, JiraError> => {
  const identity = asIdentity(value)
  if (identity === undefined) {
    return err(invalidInput(`${field} must look like "agent:<model>|<tool>|<machine_id>|<session_id>" or "human:<name>"`, { field, value }))
  }
  if (value.startsWith('agent:')) {
    const parts = value.split('|')
    if (parts.length !== 4 || parts.some(part => part.trim() === '')) {
      return err(invalidInput(`${field} must have four non-empty "|"-separated components: agent:<model>|<tool>|<machine_id>|<session_id>`, {
        field,
        value,
        components: parts.length,
      }))
    }
    return ok(identity)
  }
  if (value.includes('|')) {
    return err(invalidInput(`${field} must not contain "|": a human identity is just human:<name>`, { field, value }))
  }
  return ok(identity)
}

export const validateKey = (value: string): Result<IssueKey, JiraError> => {
  const key = asIssueKey(value)
  return key === undefined
    ? err(invalidInput(`"${value}" is not an issue key (expected e.g. DH-12)`, { value }))
    : ok(key)
}

const membership = (
  field: string,
  value: string,
  allowed: readonly string[],
): Result<string, JiraError> =>
  allowed.includes(value)
    ? ok(value)
    : err(invalidInput(`${field} "${value}" is not one of: ${allowed.join(', ')}`, { field, value, allowed }))

export const validateIssueType = (vocab: Vocab, value: string): Result<string, JiraError> =>
  membership('issue_type', value, vocab.issueTypes)

export const validatePriority = (vocab: Vocab, value: string): Result<string, JiraError> =>
  membership('priority', value, vocab.priorities)

export const validateStatus = (vocab: Vocab, value: string): Result<string, JiraError> => {
  if (!isKnownStatus(vocab, value)) {
    return err(invalidInput(`unknown status "${value}"`, {
      status: value,
      known: Object.freeze(vocab.statuses.map(status => status.name)),
    }))
  }
  return ok(value)
}

export const validateTags = (
  known: readonly TagDef[],
  tags: readonly string[],
): Result<readonly string[], JiraError> => {
  const out: string[] = []
  for (const tag of tags) {
    const value = tag.trim().toLowerCase()
    if (!isTagName(value)) {
      return err(invalidInput(`tag "${tag}" must be lower-kebab (letters, digits, dashes; ≤32)`, { tag }))
    }
    const registered = known.some(entry => entry.name === value)
    // Decision 192: hand the whole registry along, so the error can say what exists (or that nothing does).
    if (!registered) return err(unknownTag(value, suggestTags(known, value), known.map(entry => entry.name)))
    if (!out.includes(value)) out.push(value)
  }
  return ok(Object.freeze(out))
}

/**
 * A resolution is required to enter any status in the store's `closed` set, and forbidden
 * to carry one outside it (decision 25 + the reopen rule of decision 72).
 */
export const validateResolution = (
  vocab: Vocab,
  status: string,
  resolution: string | undefined,
): Result<string | undefined, JiraError> => {
  const closed = isClosedStatus(vocab, status)
  if (closed && (resolution === undefined || resolution === '')) {
    return err(resolutionRequired(status, vocab.resolutions))
  }
  if (!closed && resolution !== undefined && resolution !== '') {
    return err(invalidInput(`"${status}" is not a closed status, so it must not carry a resolution`, { status }))
  }
  return resolution === undefined || resolution === ''
    ? ok(undefined)
    : membership('resolution', resolution, vocab.resolutions)
}

/** The `resolution`-pairing rule §4.16 records: `limitation` always explains itself. */
export const validateResolutionNote = (
  resolution: string | undefined,
  note: string | undefined,
): Result<string | undefined, JiraError> => {
  if (resolution === 'limitation' && (note === undefined || note.trim() === '')) {
    return err(invalidInput('a resolution_note is required when the resolution is "limitation"', { resolution }))
  }
  if (note !== undefined && note.length > 1000) {
    return err(invalidInput('resolution_note must be at most 1000 characters', { length: note.length }))
  }
  return ok(note === undefined || note === '' ? undefined : note)
}
