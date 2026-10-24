/**
 * cli/runtime — the shared wiring every command handler stands on (decision 187).
 *
 * `main.ts` used to carry the table, the preflight and twenty command bodies in one switch.
 * The split is mechanical: this module owns everything a handler needs (the request, the
 * resolved root, the store, the small combinators), `commands/*.ts` owns one command each,
 * and `main.ts` is only the table plus the dispatch. Nothing here reads `process` — the bin
 * wrapper injects `cwd` alongside `argv`/`env`/`io` (§3.1 ①).
 */

import { booleanFlag, stringFlag } from '@deepseek-ai/dsh-jira-core/args.ts'
import { type JiraError, formatError, invalidInput } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { type Identity, type Issue, type IssueKey, type Timestamp, asIssueKey } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { gitUserName } from '@deepseek-ai/dsh-jira-core/git.ts'
import { resolveMachineId } from '@deepseek-ai/dsh-jira-core/machine.ts'
import { assertProjectWritable } from '@deepseek-ai/dsh-jira-core/project.ts'
import { toWire } from '@deepseek-ai/dsh-jira-core/render.ts'
import { type Result, err } from '@deepseek-ai/dsh-jira-core/result.ts'
import {
  type Actor,
  type Mutation,
  type Store,
  type TransactOptions,
  type Transaction,
  createStore,
  projectOf,
  transact,
} from '@deepseek-ai/dsh-jira-core/store.ts'
import { system } from '@deepseek-ai/dsh-jira-core/system/index.ts'
import { resolveStoreRoot } from '@deepseek-ai/dsh-jira-core/config.ts'
import { queryIssues, readSnapshot } from '@deepseek-ai/dsh-jira-core/inspect.ts'
import { parseVocab, type Vocab } from '@deepseek-ai/dsh-jira-core/vocab.ts'

export type CliIo = Readonly<{ out: (line: string) => void; err: (line: string) => void }>
export type CliEnv = Readonly<Record<string, string | undefined>>

/**
 * One CLI invocation. `cwd` is injected by the bin wrapper (decision 187): the handlers that
 * need a working directory (workspace resolution, `project` paths) read it from here, so this
 * layer keeps its "nothing reads `process`" rule testable.
 */
export type CliRequest = Readonly<{
  argv: readonly string[]
  env: CliEnv
  io: CliIo
  cwd: string
}>

/** Everything a command handler needs, built once per invocation. */
export type CommandContext = Readonly<{
  io: CliIo
  env: CliEnv
  cwd: string
  json: boolean
  root: string
  store: Store
  flags: Readonly<Record<string, string | boolean | number>>
  positionals: readonly string[]
  /** Prints one line: JSON through `toWire` when `--json`, text otherwise. */
  say: (value: unknown) => void
  /** The current UTC second, computed when asked (a write stamps its own moment). */
  now: () => string
  /** The identity a CLI write is recorded under: the git user when there is one (§4.9). */
  actorFor: () => Promise<Actor>
  /** Decision 44's compare-and-swap, read once per command and applied inside the write lock. */
  expectOptions: () => TransactOptions
  /** §4.11: refuse a write to a project owned by another machine (agents only). */
  writeIssue: (
    key: IssueKey,
    actor: Actor,
    mutate: Mutation,
    what: string,
    options: TransactOptions,
  ) => Promise<Result<Transaction, JiraError>>
}>

/** A command body: reads the context, answers with the process exit code. */
export type Handler = (ctx: CommandContext) => Promise<number>

/** The one way a command reports a failure: the formatted error on stderr, the exit code back. */
export const fail = (io: CliIo, error: JiraError, code: number): number => {
  io.err(formatError(error))
  return code
}

export const nowUtc = (): string => `${new Date().toISOString().slice(0, 19)}Z`

/**
 * `--root` beats `$JIRA_ROOT` beats `$DSH_HOME/jira` beats `<home>/.dsh/jira` (decisions 57/123/153).
 *
 * The precedence itself lives in `core/config` — this function only maps the failure into the CLI's
 * Chinese voice, so the two surfaces cannot drift again (the CLI's copy had lost the `~/.dsh` fallback).
 */
export const resolveRoot = (
  flags: Readonly<Record<string, string | boolean | number>>,
  env: CliEnv,
): Result<string, JiraError> => {
  const configured = typeof flags.root === 'string' && flags.root !== '' ? flags.root : undefined
  const resolved = resolveStoreRoot({
    ...(configured === undefined ? {} : { configured }),
    env,
    platform: system.facts.platform,
  })
  if (resolved.ok) return resolved
  return err(invalidInput('无法确定账本根目录：请传 --root，或设置 JIRA_ROOT / DSH_HOME'))
}

/** The machine id, from the identity file when the environment does not pin one (73). */
export const machineOf = async (env: CliEnv, root: string): Promise<string> => {
  const resolved = await resolveMachineId({ env, fallbackRoot: root })
  return resolved.ok ? resolved.value.id : 'local'
}

/** Read the vocabulary for rendering; a broken one only costs the ordering. */
export const optionalVocab = async (root: string): Promise<Vocab | undefined> => {
  const snapshot = await readSnapshot(root)
  if (snapshot.configText === undefined) return undefined
  const parsed = parseVocab(snapshot.configText)
  return parsed.ok ? parsed.value : undefined
}

/** The CLI's flags, as the shared query (the `/jira` command asks the same questions). */
export const queryFromFlags = (
  issues: readonly Issue[],
  flags: Readonly<Record<string, string | boolean | number>>,
  vocab: Vocab | undefined,
): readonly Issue[] => {
  const project = stringFlag(flags, 'project')
  const status = stringFlag(flags, 'status')
  const tag = stringFlag(flags, 'tag')
  return queryIssues(issues, {
    ...(project === undefined ? {} : { project }),
    ...(status === undefined ? {} : { status }),
    ...(tag === undefined ? {} : { tag }),
    includeClosed: flags.all === true,
  }, vocab)
}

/** Build the context a handler runs against: store, machine identity, and the combinators. */
export const buildContext = async (
  request: CliRequest,
  args: Readonly<{ flags: Readonly<Record<string, string | boolean | number>>; positionals: readonly string[] }>,
  root: string,
): Promise<CommandContext> => {
  const { env, io, cwd } = request
  const flags = args.flags
  const json = booleanFlag(flags, 'json')
  const store = createStore({ root, machineId: await machineOf(env, root), host: system.hostName(env) })
  // Already-rendered text is passed through: a JSON string that went through `JSON.stringify`
  // twice would reach the caller quoted, which is how `get --json` once came out as one long
  // escaped line. Decision 41: every `--json` value crosses into JSON through one transform.
  const say = (value: unknown): void => {
    if (typeof value === 'string') {
      io.out(json ? value : value.replace(/\n$/, ''))
      return
    }
    io.out(json ? JSON.stringify(toWire(value)) : String(value))
  }
  return Object.freeze({
    io,
    env,
    cwd,
    json,
    root,
    store,
    flags,
    positionals: args.positionals,
    say,
    now: nowUtc,
    actorFor: async (): Promise<Actor> => {
      const name = await gitUserName(store.files.root)
      return Object.freeze({
        by: (name === undefined ? `human:${store.machineId}` : `human:${name}`) as Identity,
        at: nowUtc() as Timestamp,
      })
    },
    expectOptions: (): TransactOptions => {
      const value = flags['expected-revision']
      return typeof value === 'number' ? { expectedRevision: value } : {}
    },
    writeIssue: async (key, actor, mutate, what, options) => {
      const allowed = await assertProjectWritable(store, projectOf(key), String(actor.by))
      if (!allowed.ok) return allowed as unknown as Result<Transaction, JiraError>
      return transact(store, key, actor, mutate, what, options)
    },
  })
}

/* ------------------------------------------------------------------ */
/* The write-command combinator (decision 187):                        */
/* key check → plan → actor → writeIssue → report → say, in one place. */
/* ------------------------------------------------------------------ */

/** What a write command wants done, once its own arguments have been read. */
export type WritePlan = Readonly<{
  mutate: Mutation
  what: string
  /** Extra transaction options (e.g. the assignee's blockers), merged over `expectOptions()`. */
  options?: TransactOptions
  /** The `--json` value; defaults to the changed issue. */
  jsonValue?: (tx: Transaction) => unknown
  /** The human-facing line. */
  line: (tx: Transaction) => string
}>

/** A plan that cannot run, with the exit code its failure deserves. */
export type PlanFailure = Readonly<{ error: JiraError; code: number }>

/** The argument was wrong — exit 2. */
export const planUsage = (error: JiraError): Result<never, PlanFailure> =>
  err(Object.freeze({ error, code: 2 }))

/** The store refused — exit 1. */
export const planStore = (error: JiraError): Result<never, PlanFailure> =>
  err(Object.freeze({ error, code: 1 }))

/**
 * The five write commands (update / comment / switch / link / assignee) used to spell the same
 * skeleton five times. `prepare` reads the command's own flags and returns the plan; everything
 * before and after it — the key check, the actor, the writable guard, the CAS options, the
 * success line — is this one function. The actor is resolved before `prepare` because one plan
 * (assignee) bakes the identity into its mutation.
 */
export const writeCommand = async (
  ctx: CommandContext,
  command: string,
  prepare: (key: IssueKey, actor: Actor) => Promise<Result<WritePlan, PlanFailure>>,
): Promise<number> => {
  const rawKey = ctx.positionals[0] ?? ''
  const key = asIssueKey(rawKey)
  if (key === undefined) return fail(ctx.io, invalidInput(`${command} 需要一个 <KEY>`), 2)
  const actor = await ctx.actorFor()
  const planned = await prepare(key, actor)
  if (!planned.ok) return fail(ctx.io, planned.error.error, planned.error.code)
  const plan = planned.value
  const result = await ctx.writeIssue(key, actor, plan.mutate, plan.what, {
    ...ctx.expectOptions(),
    ...(plan.options ?? {}),
  })
  if (!result.ok) return fail(ctx.io, result.error, 1)
  ctx.say(ctx.json
    ? (plan.jsonValue === undefined ? result.value.change.issue : plan.jsonValue(result.value))
    : plan.line(result.value))
  return 0
}
