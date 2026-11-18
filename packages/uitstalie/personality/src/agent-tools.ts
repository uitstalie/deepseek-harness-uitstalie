/**
 * The two model-facing tools of the rewritten capability.
 *
 * `personality_analyze` is registered for every agent and only reads;
 * `personality_apply` is registered only for root agents. It owns the two
 * global personality files — `PERSONALITY.md` and `WRITING_RULES.yaml` — and
 * writes only after the literal `confirm: true`, with exactly one of
 * `candidates` or `writingRules` per call. Neither tool has an automatic path.
 * @module @deepseek-ai/dsh-personality/agent-tools
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { analyzePersonality, renderAnalyzeResult } from './analyze.ts'
import type { AnalyzeInput } from './analyze.ts'
import { applyPersonalityCandidates, renderApplyResult } from './apply.ts'
import { globalPersonalityPath, PERSONALITY_ENTRY_KINDS } from './global-store.ts'
import { writingRulesPath } from './writing-rules.ts'
import type { WritingRuleInput } from './writing-rules.ts'
import {
  renderWritingRulesResult,
  runWritingRuleAction,
  WRITING_RULE_WRITE_ACTIONS,
} from './writing-tool.ts'

/** Entry kinds accepted by the non-identity tool paths. */
const NON_IDENTITY_ENTRY_KINDS = PERSONALITY_ENTRY_KINDS.filter(kind => kind !== 'identity')

/**
 * Build the all-agent read-only analysis tool.
 * @param ctx - plugin context carrying the Session query service used for the scan.
 * @returns the `personality_analyze` tool definition; its execute path returns the analysis result for the shared renderer.
 */
export function personalityAnalyzeTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'personality_analyze',
    description:
      'Read session records and return evidence-backed personality candidates. Read-only: it never writes '
      + 'a file or changes the prompt. Use only when the user asks to analyze their recent expressions or '
      + 'preferences. Every candidate carries a session id, event seq, and exact excerpt.',
    parameters: {
      scope: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            required: true,
            enum: ['current', 'session', 'recent'],
            description: 'current reads the caller session; session reads sessionId; recent scans the caller workspace up to limit sessions.',
          },
          sessionId: { type: 'string', description: 'Required when scope.kind is session; ignored otherwise.' },
          limit: { type: 'integer', description: 'For scope.kind recent: maximum sessions to scan, 1-20; defaults to 20.' },
        },
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: [...NON_IDENTITY_ENTRY_KINDS] },
        description: 'Candidate kinds to collect; defaults to understanding, preference, and style. identity is manual-only and not accepted.',
      },
      maxCandidates: { type: 'integer', description: 'Maximum candidates to return, 1-20; defaults to 10.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                candidateId: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                name: { type: 'string', required: true },
                text: { type: 'string', required: true },
                evidence: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      sessionId: { type: 'string', required: true },
                      seq: { type: 'integer', required: true },
                      quote: { type: 'string', required: true },
                      turn: { type: 'integer' },
                    },
                  },
                },
                occurrences: { type: 'integer', required: true },
                confidence: { type: 'string', required: true, enum: ['high', 'medium'] },
              },
            },
          },
          sessionsScanned: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderAnalyzeResult(value as never) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'personality_analyze')
      return await analyzePersonality(ctx, agent.session, args as AnalyzeInput, exec.signal) as never
    },
  })
}

/**
 * Build the root-only confirmed write tool for both global personality files.
 * @param ctx - plugin context carrying the global store used for writes.
 * @param refresh - reloads the calling agent's prompt after at least one accepted write.
 * @returns the merged `personality_apply` tool definition; write failures return readable rejections instead of throwing.
 */
export function personalityApplyTool(ctx: Context, refresh: (agent: Agent) => Promise<void>): ToolDefinition {
  return defineTool({
    name: 'personality_apply',
    description:
      'Write confirmed personality changes to the global PERSONALITY.md or WRITING_RULES.yaml. Pass exactly '
      + 'one of candidates (confirmed profile candidates) or writingRules (one rule action). Call only after '
      + 'the user explicitly asks to apply the change and pass confirm: true. This tool never learns '
      + 'automatically and is available only to a root agent.',
    parameters: {
      candidates: {
        type: 'array',
        description: 'Confirmed candidates to write, 1-20; each needs exact evidence and is rejected individually on failure. Pass this or writingRules, not both.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: [...NON_IDENTITY_ENTRY_KINDS] },
            name: { type: 'string', required: true },
            text: { type: 'string', required: true },
            evidence: {
              type: 'array',
              required: true,
              description: 'At least one exact session excerpt supporting the candidate.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sessionId: { type: 'string', required: true },
                  seq: { type: 'integer', required: true },
                  quote: { type: 'string', required: true },
                  turn: { type: 'integer' },
                },
              },
            },
          },
        },
      },
      writingRules: {
        type: 'object',
        additionalProperties: false,
        description: 'One WRITING_RULES.yaml action. The change affects every agent; pass this or candidates, not both.',
        properties: {
          action: {
            type: 'string',
            required: true,
            enum: ['list', 'add', 'update', 'remove', 'enable', 'disable', 'preview'],
            description: 'list/preview need no other field; add needs text; update needs id and accepts text/order/enabled; remove and enable/disable need id.',
          },
          id: { type: 'string', description: 'Required for update/remove/enable/disable; optional for add (generated when absent).' },
          text: { type: 'string', description: 'Required for add; optional for update. Trimmed and whitespace-collapsed.' },
          order: { type: 'integer', description: 'Optional safe-integer order; add appends, update preserves unless supplied.' },
          enabled: { type: 'boolean', description: 'Optional enabled state; add defaults true, update preserves unless supplied.' },
        },
      },
      confirm: { type: 'boolean', required: true, description: 'Must be true; false rejects the whole call without writing.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'array', required: true, items: { type: 'string' } },
          rejected: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          path: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          writingRules: {
            type: 'object',
            additionalProperties: false,
            description: 'Present only for a writingRules call: the action result.',
            properties: {
              action: { type: 'string', required: true, enum: ['list', 'add', 'update', 'remove', 'enable', 'disable', 'preview'] },
              ok: { type: 'boolean', required: true },
              error: { type: 'string' },
              rules: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    text: { type: 'string', required: true },
                    enabled: { type: 'boolean', required: true },
                    order: { type: 'integer', required: true },
                  },
                },
              },
              promptSection: { type: 'string' },
              path: { type: 'string', required: true },
              version: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.writingRules === undefined
          ? renderApplyResult(value)
          : renderWritingRulesResult(value.writingRules),
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'personality_apply')
      if ((agent.role ?? 'agent') === 'subagent') throw new Error('personality_apply is unavailable to subagents')
      if (args.candidates !== undefined) {
        if (args.writingRules !== undefined) {
          return refusal('pass exactly one of candidates or writingRules, not both')
        }
        try {
          const result = await applyPersonalityCandidates(ctx, {
            candidates: args.candidates,
            confirm: args.confirm as true,
          }, exec.signal)
          if (result.applied.length > 0) await refresh(agent)
          return {
            applied: [...result.applied],
            rejected: result.rejected.map(item => ({ name: item.name, reason: item.reason })),
            path: result.path,
            revision: result.revision,
          }
        } catch (error: unknown) {
          return { applied: [], rejected: [{ name: '', reason: String(error) }], path: globalPersonalityPath(), revision: 0 }
        }
      }
      if (args.writingRules !== undefined) {
        if (args.confirm !== true) {
          return writingRulesFailure(args.writingRules, 'confirm must be the literal true; the user must explicitly ask to apply')
        }
        const result = await runWritingRuleAction(ctx, args.writingRules, exec.signal)
        if (result.ok && WRITING_RULE_WRITE_ACTIONS.has(result.action)) await refresh(agent)
        return {
          applied: [],
          rejected: [],
          path: writingRulesPath(),
          revision: 0,
          writingRules: { ...result, rules: [...result.rules] },
        }
      }
      return refusal('pass candidates or writingRules')
    },
  })
}

/** One whole-call refusal for an unusable candidate/writingRules combination. */
function refusal(reason: string) {
  return { applied: [], rejected: [{ name: '', reason }], path: globalPersonalityPath(), revision: 0 }
}

/** One writingRules call refused before any read because confirmation was not literal true. */
function writingRulesFailure(input: WritingRuleInput, reason: string) {
  return {
    applied: [],
    rejected: [],
    path: writingRulesPath(),
    revision: 0,
    writingRules: { action: input.action, ok: false, error: reason, rules: [], path: writingRulesPath() },
  }
}

/** Require the owning agent session a tool needs. */
function requireAgent(agent: Agent | undefined, tool: string): Agent {
  /* v8 ignore next -- the tool runtime always passes the owning agent. */
  if (agent === undefined) throw new Error(`${tool} requires an owning agent`)
  return agent
}
