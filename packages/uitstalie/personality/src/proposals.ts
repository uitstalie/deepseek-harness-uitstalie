/**
 * Identity proposal queue.
 *
 * Identity entries describe who the user is, so the provider never writes one on
 * its own. A model proposes an `identity.*` entry into an append-only queue beside
 * the global profile; the user accepts or rejects it through `/personality` (and
 * later through the settings section). Accepting is the only path that writes an
 * identity entry, and it writes through the same version-guarded repository the
 * profile itself uses; rejecting only appends a status record.
 *
 * The queue is JSONL: one record per line, append-only, and the latest record for
 * an id wins. That keeps a status change as cheap and as conflict-safe as the
 * original proposal, and it makes a torn tail harmless: the line simply fails to
 * parse and is skipped with a warning.
 * @module @deepseek-ai/dsh-personality/proposals
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { PersonalitySettings } from './config.ts'
import { writePersonalityEntry } from './personality-file.ts'

/** File name of the identity proposal queue beside the global profile. */
export const PERSONALITY_PROPOSALS_FILE_NAME = 'PERSONALITY.proposals.jsonl'

/** Store-relative path of the proposal queue under the user's `$DSH_HOME`. */
export const PERSONALITY_PROPOSALS_GLOBAL_STORE_PATH = `personality/${PERSONALITY_PROPOSALS_FILE_NAME}`

/** Kinds the queue accepts; identity is the only one that needs confirmation. */
export const PERSONALITY_PROPOSAL_KINDS = ['identity'] as const

/** How many pending proposals the queue holds before refusing a new one. */
export const PERSONALITY_PENDING_PROPOSAL_LIMIT = 20

/** Lifecycle of one proposal. */
export type PersonalityProposalStatus = 'pending' | 'accepted' | 'rejected'

/** One queued proposal, including its latest status record. */
export interface PersonalityProposal {
  /** Stable proposal id, `p-<time>-<digest>`. */
  readonly id: string
  /** Always `identity`; the queue has no other kind. */
  readonly kind: 'identity'
  /** Lower-kebab entry name the accepted entry would use. */
  readonly name: string
  /** One-paragraph entry text. */
  readonly text: string
  /** Evidence for the proposal: a session event seq or a short quote. */
  readonly evidence: string
  /** When the proposal was first queued, UTC ISO-8601. */
  readonly proposedAt: string
  /** Latest status. */
  readonly status: PersonalityProposalStatus
}

/** Caller-owned proposal draft; the queue assigns id, time and status. */
export interface PersonalityProposalInput {
  /** Proposed kind; only `identity` is accepted. */
  readonly kind: string
  /** Lower-kebab entry name. */
  readonly name: string
  /** One-paragraph entry text. */
  readonly text: string
  /** Why the user would want this recorded. */
  readonly evidence: string
}

/** One read of the proposal queue. */
export interface PersonalityProposalRead {
  /** Absolute queue path. */
  readonly path: string
  /** Every proposal, pending first, then by first-queued order. */
  readonly proposals: readonly PersonalityProposal[]
  /** Opaque file version, passed back as the next write's expected version. */
  readonly version?: string
}

/** Typed proposal failure; `code` is stable for callers. */
export type PersonalityProposalErrorCode =
  | 'invalid-proposal'
  | 'proposal-limit'
  | 'unknown-proposal'
  | 'already-decided'

/** A refused or failed proposal operation. */
export class PersonalityProposalError extends Error {
  /**
   * @param message - actionable description naming the offending proposal or field.
   * @param code - stable failure kind.
   */
  constructor(message: string, readonly code: PersonalityProposalErrorCode) {
    super(message)
    this.name = 'PersonalityProposalError'
  }
}

/** Accepted lower-kebab entry name. */
const ENTRY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Maximum entry text accepted for one proposal. */
const PROPOSAL_TEXT_MAX_BYTES = 2048

/** Maximum evidence length accepted for one proposal. */
const PROPOSAL_EVIDENCE_MAX_CHARS = 1000

/** Build the signal option object without an undefined field. */
function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

/**
 * Read the proposal queue and fold the latest status record per id.
 * @param ctx - context carrying `fs`.
 * @param settings - resolved provider settings (the queue sits beside the global profile).
 * @param signal - cancellation for the read.
 * @returns the queue's current proposals, or an empty queue when the file is absent.
 * @throws PersonalityProposalError when the path is not a regular file.
 * @throws FsError when the read fails.
 */
export async function readProposals(
  ctx: Context,
  settings: PersonalitySettings,
  signal?: AbortSignal,
): Promise<PersonalityProposalRead> {
  const current = await readQueueText(ctx, PERSONALITY_PROPOSALS_GLOBAL_STORE_PATH, signal)
  return {
    path: settings.proposalsPath,
    proposals: foldProposals(current.text),
    ...current.version === undefined ? {} : { version: current.version },
  }
}

/**
 * Queue one identity proposal.
 *
 * The draft is validated here, the pending count is bounded, and the record is
 * appended in one version-guarded write with the same one-retry policy as the
 * profile. Nothing is written to PERSONALITY.md.
 * @param ctx - context carrying `fs`.
 * @param settings - resolved provider settings.
 * @param input - the model's proposal draft.
 * @param signal - cancellation for the read and the write.
 * @returns the queued proposal.
 * @throws PersonalityProposalError `invalid-proposal` or `proposal-limit`.
 * @throws FsError when the guarded write fails twice.
 */
export async function proposeIdentity(
  ctx: Context,
  settings: PersonalitySettings,
  input: PersonalityProposalInput,
  signal?: AbortSignal,
): Promise<PersonalityProposal> {
  const draft = normalizeProposal(input)
  const now = new Date().toISOString()
  const proposal: PersonalityProposal = {
    id: `p-${Date.now().toString(36)}-${proposalDigest(draft, now)}`,
    kind: 'identity',
    name: draft.name,
    text: draft.text,
    evidence: draft.evidence,
    proposedAt: now,
    status: 'pending',
  }
  const append = async (): Promise<PersonalityProposal> => {
    const current = await readQueueText(ctx, PERSONALITY_PROPOSALS_GLOBAL_STORE_PATH, signal)
    const pending = foldProposals(current.text).filter(candidate => candidate.status === 'pending')
    if (pending.length >= PERSONALITY_PENDING_PROPOSAL_LIMIT) {
      throw new PersonalityProposalError(
        `identity proposal queue ${settings.proposalsPath} already holds ${String(pending.length)} pending proposals; accept or reject some before proposing more`,
        'proposal-limit',
      )
    }
    await writeQueueText(ctx, PERSONALITY_PROPOSALS_GLOBAL_STORE_PATH, appendLine(current.text, proposal), current.version, signal)
    return proposal
  }
  try {
    return await append()
  } catch (error: unknown) {
    if (!(error instanceof FsError) || error.code !== 'FS_STALE_VERSION') throw error
    return await append()
  }
}

/**
 * Accept or reject one pending proposal.
 *
 * Accepting writes the identity entry through the version-guarded profile write
 * (with `confirmIdentity`), then records the accepted status; a failed profile
 * write leaves the proposal pending so nothing is silently lost. Rejecting only
 * appends the status record.
 * @param ctx - context carrying `fs` and `dshStore`.
 * @param session - session requesting the decision, recorded in the profile history.
 * @param settings - resolved provider settings.
 * @param id - the proposal id.
 * @param decision - accept or reject.
 * @param signal - cancellation for the reads and writes.
 * @returns the proposal with its new status.
 * @throws PersonalityProposalError `unknown-proposal` or `already-decided`.
 */
export async function decideProposal(
  ctx: Context,
  session: Session,
  settings: PersonalitySettings,
  id: string,
  decision: 'accept' | 'reject',
  signal?: AbortSignal,
): Promise<PersonalityProposal> {
  const current = await readQueueText(ctx, PERSONALITY_PROPOSALS_GLOBAL_STORE_PATH, signal)
  const proposal = foldProposals(current.text).find(candidate => candidate.id === id)
  if (proposal === undefined) {
    throw new PersonalityProposalError(`no proposal with id ${JSON.stringify(id)} exists in ${settings.proposalsPath}`, 'unknown-proposal')
  }
  if (proposal.status !== 'pending') {
    throw new PersonalityProposalError(`proposal ${proposal.id} is already ${proposal.status}`, 'already-decided')
  }
  if (decision === 'accept') {
    await writePersonalityEntry(ctx, session, {
      kind: 'identity',
      name: proposal.name,
      text: proposal.text,
    }, { settings, source: 'user', confirmIdentity: true }, signal)
  }
  const decided: PersonalityProposal = { ...proposal, status: decision === 'accept' ? 'accepted' : 'rejected' }
  await writeQueueText(ctx, PERSONALITY_PROPOSALS_GLOBAL_STORE_PATH, appendLine(current.text, decided), current.version, signal)
  return decided
}

/** Validate and normalize one proposal draft. */
function normalizeProposal(input: PersonalityProposalInput): { name: string; text: string; evidence: string } {
  if (input.kind !== 'identity') {
    throw new PersonalityProposalError(
      `proposal kind must be "identity"; got ${JSON.stringify(input.kind)}`,
      'invalid-proposal',
    )
  }
  const name = input.name.trim()
  if (!ENTRY_NAME.test(name)) {
    throw new PersonalityProposalError(`proposal name ${JSON.stringify(input.name)} must be lower-kebab-case`, 'invalid-proposal')
  }
  const text = input.text.trim()
  if (text.length === 0) throw new PersonalityProposalError('proposal text must not be empty', 'invalid-proposal')
  if (Buffer.byteLength(text, 'utf8') > PROPOSAL_TEXT_MAX_BYTES) {
    throw new PersonalityProposalError(`proposal text exceeds ${String(PROPOSAL_TEXT_MAX_BYTES)} bytes`, 'invalid-proposal')
  }
  const evidence = input.evidence.trim()
  if (evidence.length === 0) throw new PersonalityProposalError('proposal evidence must not be empty', 'invalid-proposal')
  if (evidence.length > PROPOSAL_EVIDENCE_MAX_CHARS) {
    throw new PersonalityProposalError(`proposal evidence exceeds ${String(PROPOSAL_EVIDENCE_MAX_CHARS)} characters`, 'invalid-proposal')
  }
  return { name, text, evidence }
}

/** Stable digest for one proposal draft. */
function proposalDigest(draft: { name: string; text: string; evidence: string }, now: string): string {
  return createHash('sha256').update(`${now}\u0000${draft.name}\u0000${draft.text}`).digest('hex').slice(0, 8)
}

/** Append one JSONL record, keeping the existing text's final newline. */
function appendLine(text: string, record: PersonalityProposal): string {
  const prefix = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
  return `${prefix}${JSON.stringify(record)}\n`
}

/** Fold JSONL records into one proposal per id, latest status winning. */
function foldProposals(text: string): readonly PersonalityProposal[] {
  const byId = new Map<string, PersonalityProposal>()
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = parseProposal(line)
    if (parsed !== undefined) byId.set(parsed.id, parsed)
  }
  const proposals = [...byId.values()]
  const pending = proposals.filter(proposal => proposal.status === 'pending')
  const decided = proposals.filter(proposal => proposal.status !== 'pending')
  return [...pending, ...decided]
}

/** Parse one record, returning undefined for a torn or malformed line. */
function parseProposal(line: string): PersonalityProposal | undefined {
  try {
    const value = JSON.parse(line) as Partial<PersonalityProposal>
    if (typeof value.id !== 'string' || value.kind !== 'identity' || typeof value.name !== 'string'
      || typeof value.text !== 'string' || typeof value.evidence !== 'string'
      || typeof value.proposedAt !== 'string' || (value.status !== 'pending' && value.status !== 'accepted' && value.status !== 'rejected')) {
      return undefined
    }
    return value as PersonalityProposal
  } catch {
    return undefined
  }
}

/** Read the queue text and its version through the store atom's global scope. */
async function readQueueText(
  ctx: Context,
  storePath: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; version?: string }> {
  const read = await ctx.dshStore.readFile(undefined, storePath, {
    scope: 'global',
    ...signalOptions(signal),
  })
  if (read.text === undefined) return { text: '' }
  return {
    text: read.text,
    ...read.version === undefined ? {} : { version: read.version },
  }
}

/** Write the queue text through the store atom's global scope and version guard. */
async function writeQueueText(
  ctx: Context,
  storePath: string,
  text: string,
  version: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  await ctx.dshStore.writeFile(undefined, storePath, text, {
    scope: 'global',
    ...version === undefined ? {} : { expected: version },
    ...signalOptions(signal),
  })
}
