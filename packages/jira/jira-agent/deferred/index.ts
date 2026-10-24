/**
 * plugin/index — the host adapter (decision 64's `src/plugin` layer), now **wiring only**
 * (decision 186): the envelope lives in `envelope.ts`, the host's shapes in `host.ts`, each tool's
 * schema and runner in `toolIssue.ts` / `toolList.ts` / `toolKb.ts`, and session bookkeeping in
 * `sessionRecord.ts`. What remains here is `apply` composing those atoms in order — plus a
 * re-export surface so existing importers of `plugin/index.ts` keep working unchanged.
 *
 * Decision 108: this file imports **no host package**. It declares the small shape it
 * needs, registers plain tool definitions, and defers all real behaviour to `core`. That
 * is what keeps the package buildable and installable offline on both machines, and it is
 * why the integration test (a real `dsh plugin add`) is the guard for host drift rather
 * than the compiler.
 *
 * Decision 101: the bundle patch inserts this row on the **host plane**, so every
 * `dsh web` session — including `minimal` — sees the tools.
 */

import { basename } from 'node:path'
import { configuredRootOf, resolveStoreRoot } from '../core/config.ts'
import { resolveMachineId } from '../core/machine.ts'
import { runGit } from '../core/git.ts'
import { ensureRemote } from '../core/provision.ts'
import { type Identity, type Timestamp } from '../core/entity.ts'
import { regenerateAndCommit } from '../core/generateStore.ts'
import { type JiraError, formatError } from '../core/errors.ts'
import { type InjectionRead, countStore, createStoreInjection } from '../core/injection.ts'
import { describeBinding, resolveWorkspace } from '../core/workspace.ts'
import { type KnowledgeEntry } from '../core/kb.ts'
import { renderKbSearch } from '../core/kbsearch.ts'
import { type ListResult, renderIssueListForModel } from '../core/list.ts'
import { clampText, fromWire, renderIssueHuman, toWire } from '../core/render.ts'
import { objectSchema } from '../core/schema.ts'
import { type Result, ok } from '../core/result.ts'
import { createPushQueue } from '../core/push.ts'
import { pullRebase } from '../core/rebase.ts'
import { type Store, createStore } from '../core/store.ts'
import { system } from '../core/system/index.ts'
import { type Caller, callerCwd, callerSessionId, describeCaller } from './caller.ts'
import { type CommandsHost, registerCommand } from './command.ts'
import { type SkillsHost, packageRootFrom, registerSkills } from './skills.ts'
import { type HostEnv, type JiraConfig, type JiraExec, type JiraHostContext, defaultEnv } from './host.ts'
import { type ToolValue, nowUtc } from './envelope.ts'
import { closeOutSession, createSessionRecorder, readPushFailure, recordPushOutcome, stateDirOf, toolEvidenceOf } from './sessionRecord.ts'
import {
  ISSUE_DESCRIPTION,
  ISSUE_OUTPUT_SCHEMA,
  ISSUE_PARAMETERS,
  READ_ACTIONS,
  READ_TIMEOUT_MS,
  TOOL_NAME,
  WRITE_ACTIONS,
  WRITE_TIMEOUT_MS,
  runIssueTool,
} from './toolIssue.ts'
import { LIST_DESCRIPTION, LIST_OUTPUT_SCHEMA, LIST_PARAMETERS, LIST_TOOL_NAME, runListTool } from './toolList.ts'
import { KB_DESCRIPTION, KB_OUTPUT_SCHEMA, KB_PARAMETERS, KB_TOOL_NAME, runKbTool } from './toolKb.ts'

export const name = 'dsh-jira'
export const inject = ['tools'] as const

/** How long a session end may spend pushing before the host's grace runs out. */
export const SESSION_END_FLUSH_MS = 3_000

/* ── re-export surface (decision 186): what used to live here keeps being importable from here ── */

export { type JiraConfig, type JiraExec, type ToolGuard, type JiraToolDefinition, type JiraHostContext, type HostEnv, defaultEnv } from './host.ts'
export { type ToolValue, type RunOptions, nowUtc } from './envelope.ts'
export { createSessionRecorder, type SessionFacts } from './sessionRecord.ts'
export { TOOL_NAME, READ_ACTIONS, WRITE_ACTIONS, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, ISSUE_PARAMETERS, ISSUE_DESCRIPTION, ISSUE_OUTPUT_SCHEMA, runIssueTool } from './toolIssue.ts'
export { LIST_TOOL_NAME, LIST_PARAMETERS, LIST_DESCRIPTION, LIST_OUTPUT_SCHEMA, runListTool } from './toolList.ts'
export { KB_TOOL_NAME, KB_PARAMETERS, KB_DESCRIPTION, KB_OUTPUT_SCHEMA, runKbTool } from './toolKb.ts'

/** What the awareness line reads when the store cannot be resolved: nothing (decision 78/183). */
const EMPTY_INJECTION_READ: InjectionRead = Object.freeze({
  counts: Object.freeze({ projects: 0, knowledge: 0, openIssues: 0, readOnlyProjects: 0 }),
})

/**
 * Register the plugin's rows. Cordis calls this with `(ctx, config)`; `env` and `clock`
 * are injectable so tests never touch the real process or the real time (decision 102 ①).
 *
 * Decision 186: the body is a sequence of **named steps**, each a small function defined below —
 * the composition is readable top to bottom, and each step is testable in isolation.
 */
export const apply = async (
  ctx: JiraHostContext,
  config: JiraConfig = {},
  env: HostEnv = defaultEnv(),
  clock: () => number = () => Date.now(),
): Promise<() => void> => {
  const configuredRoot = configuredRootOf(config.root)
  const root = resolveStoreRoot(configuredRoot === undefined ? { env } : { configured: configuredRoot, env })
  // The machine identity is a file, not a hostname (decision 73): two machines sharing an id
  // would claim the same number block in the shared store.
  const machine = await resolveMachineId({
    ...(config.machine_id === undefined ? {} : { configured: config.machine_id }),
    env,
    ...(root.ok ? { fallbackRoot: root.value } : {}),
  })
  const machineId = machine.ok ? machine.value.id : 'local'

  // Joining the shared repository is a local, offline operation: set the origin, never clone
  // or fetch here (a write must not need the network, and `jira init` owns provisioning).
  if (root.ok && config.remote !== undefined) {
    await ensureRemote(root.value, config.remote)
  }

  const makeStore = (): Result<Store, JiraError> => {
    if (!root.ok) return root
    return ok(createStore({
      root: root.value,
      machineId,
      host: config.host ?? system.hostName(env),
    }))
  }

  /** Step: one debounced queue per store root (decision 60) — a write schedules a push, a
   *  session end or an explicit sync flushes it, and nothing ever waits on the network here. */
  const queue = createPushQueue({
    root: root.ok ? root.value : '',
    // Decision 119: pull --rebase before pushing, marking whatever both machines touched.
    //
    // This was dead code until 2026-10-17: the comment and the code below ended up on **one line**
    // when the hook was introduced (`db7743e`), so `//` swallowed the whole hook and the plugin
    // simply never pulled — a two-machine push was rejected as non-fast-forward and retried forever.
    // Only the CLI's `sync` had it. Found while wiring decision 148's settle step, which is ordered
    // *after* this one.
    pull: async () => {
      const made = makeStore()
      if (!made.ok) return made
      return pullRebase(made.value, { by: 'human:dsh-jira' as Identity, at: nowUtc(clock) })
    },
    // Decision 148: refresh the derived files after the rebase and before the push, so the commit
    // that leaves this machine cannot contradict its own `source_tree`. Without this, every push a
    // debounce after a write carried a stale `log.md` (the write's own commit is keyed, and `log.md`
    // lists keyed commits) and the store's `generate --check` gate went red mid-session.
    settle: async () => {
      const made = makeStore()
      if (!made.ok) return made
      return regenerateAndCommit(made.value, nowUtc(clock))
    },
    // Decision 191: a failed flush is remembered where a human can see it — a silent failure is how
    // the store's CI went red twice on an innocent commit.
    onOutcome: (outcome) => {
      void recordPushOutcome(stateDirOf(env, root.ok ? root.value : ''), outcome, nowUtc(clock))
    },
    ...(config.push?.enabled === undefined ? {} : { enabled: config.push.enabled }),
    ...(config.push?.debounce_ms === undefined ? {} : { debounceMs: config.push.debounce_ms }),
  })

  // Decision 166: everything `apply` registers is collected so a reload can undo it. The host re-runs
  // `apply` for a live config change; without this, every reload leaves another `agent/created`
  // listener (so the session end regenerates N times), another tool registration and another armed
  // debounce timer holding a stale closure.
  const disposers: (() => void)[] = []
  const keep = (handle: unknown): void => {
    if (typeof handle === 'function') disposers.push(handle as () => void)
  }

  // Decision 183: the session recorder's memory is this apply's, not the module's — a reload starts
  // clean instead of inheriting "already recorded" from the previous instance.
  const sessionRecorder = createSessionRecorder()

  /** Step: `/jira` — the slash command, sharing this apply's root, machine identity and queue. */
  const registerSlashCommand = (): void => {
    const commandOptions = {
      root: () => root,
      // The **resolved** machine id, the same one `makeStore` uses (decision 166): `dsh-<env>` here and
      // the file/env id there meant one machine had two identities — two counter blocks, two audit
      // trails — because the counters are keyed by machine id.
      machineId,
      identity: `human:${machineId}`,
      // The lock owner's `host` (decision 181): one answer for every store this process builds.
      host: config.host ?? system.hostName(env),
      now: () => nowUtc(clock),
      // `/jira sync` reuses this queue, so it rebases and settles like every other push does, and it
      // cancels the timer the last write armed instead of racing it.
      queue,
      // Decision 191: `/jira status` also says whether the last push went out.
      pushStatus: async () => {
        const failure = await readPushFailure(stateDirOf(env, root.ok ? root.value : ''))
        return failure === undefined ? undefined : `上次推送失败（${failure.at}）：${failure.message}`
      },
      // Decision 177: `/jira status` reports what this process actually knows about writing.
      writable: () => {
        const caller = describeCaller({
          machine: machineId,
          ...(env.DSH_READ_ONLY_SESSION === undefined ? { readOnly: false } : { readOnly: env.DSH_READ_ONLY_SESSION !== '0' }),
        })
        return caller.writable ? '本会话可以写' : `不能写（${caller.reason ?? 'read-only'}）`
      },
    }
    // Optional services go through `ctx.get`: a property read of a service that is not in `inject`
    // throws in the host, and requiring these would keep the plugin from loading in a profile with
    // no command or skill registry.
    const commands = ctx.get?.('commands') as CommandsHost['commands']
    keep(registerCommand(commands === undefined ? {} : { commands }, commandOptions))
  }

  /** Step: the three bundled skills. Awaited, so a caller that composed the plugin can rely on the
   *  skills being there: an unawaited registration lost the race against the first catalogue read. */
  const registerPluginSkills = async (): Promise<void> => {
    const skills = ctx.get?.('skills') as SkillsHost['skills']
    keep((await registerSkills(skills === undefined ? {} : { skills }, packageRootFrom(import.meta.url))).unregister)
  }

  /** Step: decision 96's **monotonic** guard — no later plugin can force-allow a call this one
   *  denies. The handlers refuse as well (defence in depth, and that refusal is an ordinary tool
   *  result); the guard simply denies earlier, and cannot be argued with. */
  const installWriteGuard = (): void => {
    keep(ctx.tools.guard?.((execution) => {
      if (execution.name !== TOOL_NAME) return undefined
      const action = String((execution.arguments as { action?: unknown } | undefined)?.action ?? '')
      if (!WRITE_ACTIONS.includes(action)) return undefined
      const caller = describeCaller({
        ...(execution.agent === undefined ? {} : { agent: execution.agent }),
        machine: machineId,
        ...(env.DSH_READ_ONLY_SESSION === undefined ? { readOnly: false } : { readOnly: env.DSH_READ_ONLY_SESSION !== '0' }),
      })
      if (caller.writable) return undefined
      return 'dsh-jira: ' + action + ' writes the ledger, and this session may not write (' + (caller.reason ?? 'read-only') + ')'
    }))
  }

  /** Step: decision 100's seam — the host awaits these effects before closing the session, and the
   *  hard-coded shutdown grace is a few seconds, so the flush is **bounded**. A push that does not
   *  make it is not lost: the commit is local and the next run retries it. */
  const subscribeSessionEnd = (): void => {
    keep(ctx.on?.('agent/created', ({ agent }) => {
      // Decisions 31/100: the scan wants the commits this session made, so the starting point
      // is captured now, while the session is young.
      const sessionId = callerSessionId(agent)
      // No store root means no repository to ask: spawning git in the process's own cwd would read a
      // repository that has nothing to do with this store (and, with a store root that failed to
      // resolve, `git -C ''` is not even meaningful).
      const headAtStart = root.ok
        ? runGit(root.value, ['rev-parse', 'HEAD']).then(head => head.stdout.trim()).catch(() => '')
        : Promise.resolve('')
      const scope = (agent as { ctx?: { effect?: (body: () => () => Promise<void>, label?: string) => unknown } } | undefined)?.ctx
      scope?.effect?.(() => async () => {
        const made = makeStore()
        // Decision 15/34, corrected 2026-10-17: generation belongs to **this process** — an
        // out-of-process timer is a failed change — and it has to run **before the flush**, because what
        // leaves the machine has to agree with its own sources or the store's freshness gate goes red.
        // A read-only session does not write, not even here (decisions 89/93): a subagent's or a
        // read-only session's end must not produce commits in a store it may not write.
        const mayWrite = made.ok && describeCaller({
          ...(agent === undefined ? {} : { agent }),
          machine: machineId,
          ...(env.DSH_READ_ONLY_SESSION === undefined ? { readOnly: false } : { readOnly: env.DSH_READ_ONLY_SESSION !== '0' }),
        }).writable
        if (mayWrite && made.ok) {
          await regenerateAndCommit(made.value, nowUtc(clock))
          // Decision 161: the close-out scan is a **write** — it records `sessions/<id>.md` and appends one
          // comment per issue the session touched, through the ordinary write transaction. It used to run
          // unconditionally here, so a read-only or delegated session's end wrote the ledger anyway (and
          // labelled its comments with that session's id); the regeneration right above was gated, this was
          // not, which is exactly what the audit caught.
          if (sessionId !== undefined) {
            await closeOutSession(made.value, sessionId, await headAtStart, stateDirOf(env, made.value.files.root), nowUtc(clock))
          }
        }
        // Decision 148: the flush's own settle step writes too, so it carries the same permission the
        // regeneration above just used — a read-only or delegated session must not settle either.
        await Promise.race([
          queue.flushNow({ settle: mayWrite }),
          new Promise(resolve => setTimeout(resolve, SESSION_END_FLUSH_MS)),
        ])
      }, 'dsh-jira.pushFlush')
    }))
  }

  /** The store, the caller and the "who am I" envelope — resolved once per tool call. */
  const callContext = (
    exec: JiraExec,
  ): Readonly<{ ok: true; store: Store; caller: Caller; me: unknown }> | Readonly<{ ok: false; value: ToolValue }> => {
    const store = makeStore()
    const caller = describeCaller({
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec.model === undefined ? {} : { model: exec.model }),
      machine: machineId,
      ...(env.DSH_READ_ONLY_SESSION === undefined
        ? { readOnly: false }
        : { readOnly: env.DSH_READ_ONLY_SESSION !== '0' }),
    })
    const me = Object.freeze({
      tool: 'dsh',
      ...(exec.model === undefined ? {} : { model: exec.model }),
      machine: machineId,
      ...(callerSessionId(exec.agent) === undefined ? {} : { session: callerSessionId(exec.agent) }),
    })
    if (!store.ok) {
      return Object.freeze({
        ok: false,
        value: Object.freeze({
          ok: false,
          error: store.error,
          writable: caller.writable,
          me,
          ...(caller.reason === undefined ? {} : { reason: caller.reason }),
        }),
      })
    }
    return Object.freeze({ ok: true, store: store.value, caller, me })
  }

  /**
   * Every tool result crosses into JSON through here (decision 41): entities are camelCase inside, the
   * wire is snake_case. Wrapping the **boundary** rather than each builder means a new field or a new
   * tool cannot quietly ship a camelCase key.
   */
  const wire = (value: ToolValue): ToolValue => toWire(value) as ToolValue

  const renderValue = (text: string): readonly unknown[] => [{ type: 'text' as const, text: clampText(text) }]

  /** Step: decision 78, §6.4 — one line of **awareness**, not an agenda. It is a `PromptContext`
   *  rather than a prompt section because the counts change, and a changing section would invalidate
   *  the KV cache every time they do; it is reused for five seconds; and an **empty store injects
   *  nothing at all**. The host's provider is synchronous, so the text is served from a cache that a
   *  refresh keeps current. */
  const registerAwarenessLine = async (): Promise<void> => {
    const injection = createStoreInjection({
      read: async (cwd) => {
        // `makeStore`/`countStore` hand back Results: a missing root or an unreadable store is not an
        // exception — the line simply says nothing (an all-zero read injects no text, decision 78).
        // Decision 183: no `throw` here; the catch in `createStoreInjection.refresh` stays as the
        // last-resort net for a genuinely exceptional read.
        const made = makeStore()
        if (!made.ok) return EMPTY_INJECTION_READ
        const counts = await countStore(made.value)
        if (!counts.ok) return EMPTY_INJECTION_READ

        // Which project is *this* checkout (§4.10)? Read-only: nothing is registered here.
        let binding: string | undefined
        if (cwd !== undefined) {
          const resolved = await resolveWorkspace(made.value, cwd)
          if (resolved.ok) binding = describeBinding(resolved.value)
        }
        return Object.freeze({
          counts: counts.value,
          storeLabel: basename(made.value.files.root),
          ...(binding === undefined || binding === '' ? {} : { binding }),
        })
      },
      cwdOf: scope => callerCwd(scope),
      now: clock,
    })
    const systemPrompt = ctx.get?.('systemPrompt') as
      | { context?: (context: { name: string; order: number; text: () => string }) => unknown }
      | undefined
    if (systemPrompt?.context !== undefined) {
      // Decision 166/183: this registration is undoable too — a reload must not stack contexts.
      keep(systemPrompt.context({ name: injection.name, order: injection.order, text: injection.text }))
      await injection.refresh()
    }
  }

  /** Step: one tool registration, with the shared wiring (callContext → wire → keep) applied once. */
  const registerTool = (definition: Readonly<{
    name: string
    description: string
    parameters: Record<string, unknown>
    outputSchema: Record<string, unknown>
    render: (value: ToolValue) => readonly unknown[]
    timeoutMs: number
    isConcurrencySafe: (args: unknown) => boolean
    run: (args: unknown, context: Readonly<{ store: Store; caller: Caller; me: unknown }>, exec: JiraExec) => Promise<ToolValue>
  }>): void => {
    keep(ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: {
        schema: definition.outputSchema,
        render: (_args, value) => {
          // The host hands back the **wire** value (decision 159), so undo it before rendering with the
          // entity-typed renderers — otherwise every camelCase field they read is `undefined` here.
          const typed = fromWire(value) as ToolValue
          if (!typed.ok) {
            const detail = typed.error === undefined ? 'unknown error' : formatError(typed.error)
            return renderValue(`error: ${detail}`)
          }
          return definition.render(typed)
        },
      },
      timeoutMs: definition.timeoutMs,
      isConcurrencySafe: definition.isConcurrencySafe,
      execute: async (args, exec) => {
        const context = callContext(exec)
        // Decision 84: `timeoutMs` is declared, so the signal has to reach the handler.
        if (!context.ok) return wire(context.value)
        return wire(await definition.run(args, context, exec))
      },
    }))
  }

  /** Step: the three resident tools (decisions 50/53/82). */
  const registerTools = (): void => {
    registerTool({
      name: TOOL_NAME,
      description: ISSUE_DESCRIPTION,
      parameters: objectSchema(ISSUE_PARAMETERS) as Record<string, unknown>,
      outputSchema: ISSUE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: (typed) => {
        const text = typed.issue === undefined ? 'ok' : renderIssueHuman(typed.issue as never, [], nowUtc(clock)).replace(/\n$/, '')
        return renderValue(text)
      },
      timeoutMs: WRITE_TIMEOUT_MS,
      isConcurrencySafe: args => READ_ACTIONS.includes(String((args as { action?: unknown } | undefined)?.action ?? '')),
      run: (args, context, exec) => runIssueTool(
        args,
        { store: context.store, caller: context.caller, at: nowUtc(clock), onWrote: () => queue.schedule(),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          session: {
            tool: 'dsh',
            ...(exec.model === undefined ? {} : { model: exec.model }),
            toolEvidence: toolEvidenceOf(env),
            stateDir: stateDirOf(env, context.store.files.root),
          },
          recordSession: sessionRecorder.recordOnce,
        },
        context.me,
      ),
    })

    // The second resident tool (decision 53). Read-only, so a subagent may use it too (decision 89).
    registerTool({
      name: LIST_TOOL_NAME,
      description: LIST_DESCRIPTION,
      parameters: objectSchema(LIST_PARAMETERS) as Record<string, unknown>,
      outputSchema: LIST_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: typed => renderValue(renderIssueListForModel(typed as unknown as ListResult)),
      timeoutMs: READ_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      run: (args, context) => runListTool(args, { store: context.store, caller: context.caller, at: nowUtc(clock) }, context.me),
    })

    // The third resident tool (decisions 29/54): knowledge. Reading is open to every session; writing
    // goes through the same guard as the issue tool.
    registerTool({
      name: KB_TOOL_NAME,
      description: KB_DESCRIPTION,
      parameters: objectSchema(KB_PARAMETERS) as Record<string, unknown>,
      outputSchema: KB_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: (typed) => {
        const hits = typed.hits as readonly never[] | undefined
        if (hits !== undefined) {
          const counts = (typed.counts ?? {}) as { matched?: number }
          return renderValue(renderKbSearch({
            hits,
            matched: counts.matched ?? hits.length,
            truncated: typed.truncated === true,
            topK: hits.length,
          }))
        }
        const item = typed.item as KnowledgeEntry | undefined
        if (item === undefined) return renderValue('ok')
        return renderValue([
          `${item.key}  ${item.kbType}  ${item.title}`,
          `${item.domain} · captured ${item.source.capturedAt} · ${String(item.source.machineId)}`,
          ...(item.issues.length === 0 ? [] : [`issues: ${item.issues.join(', ')}`]),
        ].join('\n'))
      },
      timeoutMs: WRITE_TIMEOUT_MS,
      // Decision 166 (S3 of DPMJ-8): the knowledge reads are reads — `get`/`search` may run in parallel
      // like `jira_list` does; anything else keeps the conservative default (fail closed).
      isConcurrencySafe: (args) => {
        const action = String((args as { action?: unknown } | undefined)?.action ?? '')
        return action === 'get' || action === 'search'
      },
      run: (args, context) => runKbTool(
        args,
        { store: context.store, caller: context.caller, at: nowUtc(clock), onWrote: () => queue.schedule() },
        context.me,
      ),
    })
  }

  /* ── the composition, top to bottom (decision 186) ─────────────────────────────────── */
  registerSlashCommand()
  await registerPluginSkills()
  installWriteGuard()
  subscribeSessionEnd()
  await registerAwarenessLine()
  registerTools()

  // Decision 166: undo everything above when the host drops this row (a live config reload re-runs
  // `apply`), newest first. The queue goes last so a flush that is already running is not cancelled
  // mid-flight — `dispose` only stops *future* pushes.
  return () => {
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch {
        // A failing disposer must not stop the others: leaking one registration is better than
        // leaking all of them behind the first throw.
      }
    }
    queue.dispose()
  }
}
