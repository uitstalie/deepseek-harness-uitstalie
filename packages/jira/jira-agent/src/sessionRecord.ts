/**
 * plugin/sessionRecord — session bookkeeping at the plugin boundary (decisions 10/31/100/119).
 *
 * Split out of `index.ts` under decision 186. Two jobs:
 *   - {@link createSessionRecorder}: write `sessions/<id>.md` **once per session**, at its first
 *     write, retrying a transient failure a few times (decision 177);
 *   - {@link closeOutSession}: at the session's end, walk the commits it made and record them on
 *     the issues they mention — bounded, idempotent (the comment carries the sha), never fatal.
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type Identity, type Timestamp } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { runGit } from '@deepseek-ai/dsh-jira-core/git.ts'
import { writeTextAtomic } from '@deepseek-ai/dsh-jira-core/io.ts'
import { machineStateDir } from '@deepseek-ai/dsh-jira-core/machine.ts'
import { ensureSessionRecord, readWatermark, scanWatermarkPath, sessionScan, writeWatermark } from '@deepseek-ai/dsh-jira-core/session.ts'
import { type Actor, type Store } from '@deepseek-ai/dsh-jira-core/store.ts'
import { type HostEnv } from './env.ts'

/** How many times a failing session record is retried before it is given up (decision 177). */
const SESSION_RECORD_ATTEMPTS = 3

export type SessionFacts = Readonly<{ tool: string; model?: string; toolEvidence?: string; stateDir: string }>

/** The per-apply memory of which sessions have been recorded, and how often a write failed. */
export interface SessionRecorder {
  /**
   * Record a session at its first write, at most once per store.
   * @param store - the store the session's writes went to.
   * @param actor - who wrote, for the record's audit fields.
   * @param sessionId - the host session id.
   * @param facts - what identified the writing tool.
   * @returns a promise that settles when the record was attempted.
   */
  recordOnce(store: Store, actor: Actor, sessionId: string, facts: SessionFacts): Promise<void>
}

/**
 * Decisions 10/119/177 + 183: the bookkeeping lives in a **per-apply closure**, not at module level —
 * module state survives a reload (decision 166) and leaks across stores, so a second `apply` (or a
 * second root) would inherit "already recorded" and the session would never land in the new store.
 * The key is `root | sessionId`: one recorder may still serve two stores.
 * @returns the recorder this plugin instance owns.
 */
export const createSessionRecorder = (): SessionRecorder => {
  /** Sessions already recorded by **this** recorder: the file is the authority, this just avoids re-reading. */
  const recordedSessions = new Set<string>()
  /** Attempts so far, per (store, session) (decision 177): "attempted" is not "recorded". */
  const sessionFailures = new Map<string, number>()

  const recordOnce = async (
    store: Store,
    actor: Actor,
    sessionId: string,
    facts: SessionFacts,
  ): Promise<void> => {
    const key = `${store.files.root}|${sessionId}`
    if (recordedSessions.has(key)) return
    // Decision 177: one failure used to mark the session "done", so a transient IO error meant the
    // whole session never got a record. Try a few times, then give up — and never let the record's
    // problems reach the write that triggered it: the issue is the job.
    if ((sessionFailures.get(key) ?? 0) >= SESSION_RECORD_ATTEMPTS) return
    try {
      const recorded = await ensureSessionRecord(store, actor, {
        id: sessionId,
        tool: facts.tool,
        ...(facts.model === undefined ? {} : { model: facts.model }),
        machineId: store.machineId,
        startedAt: actor.at,
        ...(facts.toolEvidence === undefined ? {} : { toolEvidence: facts.toolEvidence }),
      })
      if (recorded.ok) {
        recordedSessions.add(key)
        sessionFailures.delete(key)
      } else {
        sessionFailures.set(key, (sessionFailures.get(key) ?? 0) + 1)
      }
    } catch {
      sessionFailures.set(key, (sessionFailures.get(key) ?? 0) + 1)
    }
  }

  return Object.freeze({ recordOnce })
}

/** Decision 10: the raw evidence that identified the tool — recorded, not guessed later. */
export const toolEvidenceOf = (env: HostEnv): string => {
  for (const name of ['DSH_HOME', 'DSH_MACHINE_ID', 'DSH_SESSION_ID', 'CLAUDECODE', 'DEEPSEEK_API_KEY']) {
    if (env[name] !== undefined && env[name] !== '') return `${name}=1`
  }
  return 'none'
}

/** The machine-local state directory — one implementation, in `core/machine` (decision 150). */
export const stateDirOf = (env: HostEnv, root: string): string => machineStateDir(env, root)

/**
 * Decisions 31/100: at the session's end, walk the commits it made and record them on the issues
 * they mention — bounded, idempotent (the comment carries the sha), and never fatal.
 */
export const closeOutSession = async (
  store: Store,
  sessionId: string,
  headAtStart: string,
  stateDir: string,
  at: Timestamp,
): Promise<void> => {
  try {
    const watermarkPath = scanWatermarkPath(stateDir, sessionId)
    const watermark = await readWatermark(watermarkPath)
    const scanned = await sessionScan(
      store,
      { by: `human:${store.machineId}` as Identity, at },
      { sessionId, from: watermark.lastSha ?? headAtStart },
    )
    if (!scanned.ok) return
    const head = await runGit(store.files.root, ['rev-parse', 'HEAD'])
    if (head.code === 0) {
      await writeWatermark(watermarkPath, { lastSha: head.stdout.trim(), scans: watermark.scans + 1 })
    }
  } catch {
    // A close-out that fails must not turn a good session into a bad one (decision 100).
  }
}

/**
 * Where the machine remembers the last push that did **not** happen (decision 191).
 *
 * A failed flush was silent by construction (`void flushNow(...)`), and the store's own CI went red
 * twice on an innocent commit because of it. This is the smallest honest alarm: one small file in the
 * machine's state directory, shown by `/jira status` and `jira doctor`. Never part of the ledger.
 */
export const pushFailurePath = (stateDir: string): string => join(stateDir, 'push', 'last-failure.json')

export type PushFailure = Readonly<{ at: string; message: string }>

export const recordPushOutcome = async (
  stateDir: string,
  outcome: Readonly<{ kind: string; error?: { message: string } }>,
  at: string,
): Promise<void> => {
  const path = pushFailurePath(stateDir)
  try {
    if (outcome.kind === 'pushed') {
      await rm(path, { force: true })
      return
    }
    if (outcome.kind !== 'failed' || outcome.error === undefined) return
    await writeTextAtomic(path, `${JSON.stringify({ at, message: outcome.error.message })}\n`)
  } catch {
    // The alarm must never become the problem.
  }
}

export const readPushFailure = async (stateDir: string): Promise<PushFailure | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(pushFailurePath(stateDir), 'utf8')) as PushFailure
    return typeof parsed.message === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}
