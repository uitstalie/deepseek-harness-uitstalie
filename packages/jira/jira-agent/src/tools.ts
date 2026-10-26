/**
 * The three resident model tools, registered against the repository's typed tool registry.
 *
 * Each definition keeps the shape the standalone plugin handed its duck-typed host: the frozen
 * JSON Schema `objectSchema` builds, an output schema the registry validates, a text renderer,
 * the declared timeout and the concurrency classification. What changed with the move into the
 * repository is where the store comes from: `ctx.jira.store()` resolves it once per call, and a
 * write reports itself through `ctx.jira.notifyWrite()` so the service's `changed` event and push
 * queue stay the single source of truth.
 *
 * The model-facing names, verbs and descriptions are the standalone plugin's, unchanged.
 *
 * @module @deepseek-ai/dsh-jira-agent/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { type Issue } from '@deepseek-ai/dsh-jira-core/entity.ts'
import { formatError, ioFailed } from '@deepseek-ai/dsh-jira-core/errors.ts'
import { type KnowledgeEntry } from '@deepseek-ai/dsh-jira-core/kb.ts'
import { type KbSearch, renderKbSearch } from '@deepseek-ai/dsh-jira-core/kbsearch.ts'
import { type ListResult, renderIssueListForModel } from '@deepseek-ai/dsh-jira-core/list.ts'
import { clampText, fromWire, renderIssueHuman, toWire } from '@deepseek-ai/dsh-jira-core/render.ts'
import { type FieldSpec, objectSchema } from '@deepseek-ai/dsh-jira-core/schema.ts'
import { type Store } from '@deepseek-ai/dsh-jira-core/store.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JiraServiceApi } from '@deepseek-ai/dsh-jira-service'
import { type Caller, callerSessionId, describeCaller } from './caller.ts'
import { type HostEnv, readOnlySession } from './env.ts'
import { type ToolValue, nowUtc } from './envelope.ts'
import {
  ISSUE_DESCRIPTION,
  ISSUE_OUTPUT_SCHEMA,
  ISSUE_PARAMETERS,
  READ_ACTIONS,
  READ_TIMEOUT_MS,
  TOOL_NAME,
  WRITE_TIMEOUT_MS,
  runIssueTool,
} from './toolIssue.ts'
import { KB_DESCRIPTION, KB_OUTPUT_SCHEMA, KB_PARAMETERS, KB_TOOL_NAME, runKbTool } from './toolKb.ts'
import { LIST_DESCRIPTION, LIST_OUTPUT_SCHEMA, LIST_PARAMETERS, LIST_TOOL_NAME, runListTool } from './toolList.ts'
import { type SessionFacts, type SessionRecorder, stateDirOf, toolEvidenceOf } from './sessionRecord.ts'

/** Everything a tool call reads besides the model's arguments. */
export interface ToolHost {
  /** The plugin context; `ctx.jira` is the ledger service. */
  readonly ctx: Context
  /** The process environment: the read-only switch and the tool evidence. */
  readonly env: HostEnv
  /** The clock, in milliseconds, that audit timestamps are formatted from. */
  readonly clock: () => number
  /** The per-plugin session recorder; a reload starts a fresh one. */
  readonly recorder: SessionRecorder
}

/** The resolved store, caller and identity of one call. */
export interface CallContext {
  /** The ledger service every migrated runner calls. */
  readonly jira: JiraServiceApi
  /** The store this call reads and writes through. */
  readonly store: Store
  /** Who is asking, and whether they may write. */
  readonly caller: Caller
  /** The frozen identity tuple every result carries, successful or refused. */
  readonly me: Readonly<Record<string, string>>
}

/** One tool declaration before the shared wiring is applied. */
interface Spec {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, FieldSpec>>
  readonly outputSchema: unknown
  readonly timeoutMs: number
  readonly isConcurrencySafe: (args: unknown) => boolean
  readonly render: (value: ToolValue) => ContentBlock[]
  readonly run: (args: unknown, call: CallContext, exec: ToolRunContext) => Promise<ToolValue>
}

/** The `action` argument of a tool call, when the model supplied one as a string. */
const actionOf = (args: unknown): string | undefined => {
  const value = (args as { action?: unknown } | undefined)?.action
  return typeof value === 'string' ? value : undefined
}

/** One text block, clamped to the model's budget; every renderer returns exactly this. */
const renderValue = (text: string): ContentBlock[] => [{ type: 'text', text: clampText(text) }]

/** The caller facts for one execution, shared by the tools and the write guard. */
export const callerOf = (host: Pick<ToolHost, 'ctx' | 'env'>, agent: unknown): Caller =>
  describeCaller({
    ...(agent === undefined ? {} : { agent }),
    machine: host.ctx.jira.machineId,
    readOnly: readOnlySession(host.env),
  })

/**
 * The frozen identity tuple a result carries: who answered, from which machine and session.
 * @param host - the plugin host the machine identity is read from.
 * @param agent - the calling agent, when the execution carries one.
 * @returns the `me` value, frozen for the wire.
 */
export const identityOf = (host: Pick<ToolHost, 'ctx'>, agent: unknown): Readonly<Record<string, string>> => {
  const sessionId = callerSessionId(agent)
  return Object.freeze({
    tool: 'dsh',
    machine: host.ctx.jira.machineId,
    ...(sessionId === undefined ? {} : { session: sessionId }),
  })
}

/** Resolve the store and the caller for one call; `undefined` when the root cannot be resolved. */
const resolveCall = async (host: ToolHost, exec: ToolRunContext): Promise<CallContext | undefined> => {
  const opened = await host.ctx.jira.store()
  if (!opened.ok) return undefined
  return Object.freeze({
    jira: host.ctx.jira,
    store: opened.value,
    caller: callerOf(host, exec.agent),
    me: identityOf(host, exec.agent),
  })
}

/** The envelope an unresolved ledger produces: the same fields a handler refusal carries. */
const unresolved = (host: ToolHost, exec: ToolRunContext): ToolValue => {
  const caller = callerOf(host, exec.agent)
  return Object.freeze({
    ok: false,
    error: ioFailed('cannot resolve the store root'),
    writable: caller.writable,
    ...(caller.reason === undefined ? {} : { reason: caller.reason }),
    me: identityOf(host, exec.agent),
  })
}

/** Every tool result crosses into JSON here: entities are camelCase inside, the wire snake_case. */
const wire = (value: ToolValue): ToolValue => toWire(value) as ToolValue

/** The session facts one write records about the session that made it. */
const sessionFactsOf = (host: ToolHost, root: string): SessionFacts => Object.freeze({
  tool: 'dsh',
  toolEvidence: toolEvidenceOf(host.env),
  stateDir: stateDirOf(host.env, root),
})

/** The options the three runners share. */
const runOptionsOf = (host: ToolHost, call: CallContext) => Object.freeze({
  jira: call.jira,
  store: call.store,
  caller: call.caller,
  at: nowUtc(host.clock),
  onWrote: () => { host.ctx.jira.notifyWrite() },
})

/**
 * Compile one declaration into a registry-ready definition.
 * @param host - the plugin host the call context is resolved from.
 * @param spec - the tool's schema, renderer and runner.
 * @returns the definition, with its output schema asserted against the registry's subset.
 */
const defineJiraTool = (host: ToolHost, spec: Spec): ToolDefinition => {
  const outputSchema = spec.outputSchema
  // The registry rejects an unsupported schema at registration; asserting here makes the
  // narrowing explicit and fails at module evaluation instead of during a quiet boot.
  assertSupportedJsonSchema(outputSchema)
  return {
    name: spec.name,
    description: spec.description,
    parameters: { ...objectSchema(spec.parameters) },
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        // The registry hands the renderer the canonical wire value (snake_case); the entity
        // renderers read camelCase, so undo the conversion once at this boundary.
        const typed = fromWire(value) as ToolValue
        if (!typed.ok) {
          const detail = typed.error === undefined ? 'unknown error' : formatError(typed.error)
          return renderValue(`error: ${detail}`)
        }
        return spec.render(typed)
      },
    },
    timeoutMs: spec.timeoutMs,
    isConcurrencySafe: spec.isConcurrencySafe,
    execute: async (args, exec) => {
      const call = await resolveCall(host, exec)
      if (call === undefined) return wire(unresolved(host, exec))
      return wire(await spec.run(args, call, exec))
    },
  }
}

/**
 * Build the three resident tools for this plugin instance.
 * @param host - the context, environment, clock and recorder the definitions run against.
 * @returns the registry-ready definitions, in the order the plugin registers them.
 */
export const jiraTools = (host: ToolHost): readonly ToolDefinition[] => {
  const issue: Spec = {
    name: TOOL_NAME,
    description: ISSUE_DESCRIPTION,
    parameters: ISSUE_PARAMETERS,
    outputSchema: ISSUE_OUTPUT_SCHEMA,
    timeoutMs: WRITE_TIMEOUT_MS,
    isConcurrencySafe: (args) => {
      const action = actionOf(args)
      return action !== undefined && READ_ACTIONS.includes(action)
    },
    render: (typed) => {
      const issue = typed.issue as Partial<Issue> | undefined
      // `tag_create` reports the registered tag rather than an issue; the envelope keeps the
      // standalone plugin's payload under `issue`, so the renderer recognizes it by the missing key.
      const text = issue === undefined || issue.key === undefined
        ? 'ok'
        : renderIssueHuman(issue as Issue, [], nowUtc(host.clock)).replace(/\n$/u, '')
      return renderValue(text)
    },
    run: (args, call, exec) => runIssueTool(args, {
      ...runOptionsOf(host, call),
      signal: exec.signal,
      session: sessionFactsOf(host, call.jira.root),
      recordSession: (jira, actor, sessionId, facts) => host.recorder.recordOnce(jira, actor, sessionId, facts),
    }, call.me),
  }

  const list: Spec = {
    name: LIST_TOOL_NAME,
    description: LIST_DESCRIPTION,
    parameters: LIST_PARAMETERS,
    outputSchema: LIST_OUTPUT_SCHEMA,
    timeoutMs: READ_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    render: typed => renderValue(renderIssueListForModel(typed as ListResult)),
    run: (args, call) => runListTool(args, runOptionsOf(host, call), call.me),
  }

  const knowledge: Spec = {
    name: KB_TOOL_NAME,
    description: KB_DESCRIPTION,
    parameters: KB_PARAMETERS,
    outputSchema: KB_OUTPUT_SCHEMA,
    timeoutMs: WRITE_TIMEOUT_MS,
    // The knowledge reads are reads — `get`/`search` may run in parallel like `jira_list` does;
    // anything else keeps the conservative default (fail closed).
    isConcurrencySafe: (args) => {
      const action = actionOf(args)
      return action === 'get' || action === 'search'
    },
    render: (typed) => {
      if (typed.hits !== undefined) {
        const hits = typed.hits as KbSearch['hits']
        const counts = typed.counts as { matched?: number } | undefined
        return renderValue(renderKbSearch({
          hits,
          matched: counts?.matched ?? hits.length,
          truncated: typed.truncated === true,
          topK: hits.length,
        }))
      }
      const item = typed.item as KnowledgeEntry | undefined
      if (item === undefined) return renderValue('ok')
      return renderValue([
        `${item.key}  ${item.kbType}  ${item.title}`,
        `${item.domain} · captured ${item.source.capturedAt} · ${item.source.machineId}`,
        ...(item.issues.length === 0 ? [] : [`issues: ${item.issues.join(', ')}`]),
      ].join('\n'))
    },
    run: (args, call) => runKbTool(args, runOptionsOf(host, call), call.me),
  }

  return Object.freeze([issue, list, knowledge].map(spec => defineJiraTool(host, spec)))
}
