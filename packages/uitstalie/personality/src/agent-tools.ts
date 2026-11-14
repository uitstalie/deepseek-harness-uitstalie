/**
 * The two model-facing tools of the rewritten capability.
 *
 * `personality_analyze` is registered for every agent and only reads;
 * `personality_apply` is registered only for root agents and writes only after
 * the literal `confirm: true`. Neither tool has an automatic path.
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

/** Entry kinds accepted by the non-identity tool paths. */
const NON_IDENTITY_ENTRY_KINDS = PERSONALITY_ENTRY_KINDS.filter(kind => kind !== 'identity')

/** Build the all-agent read-only analysis tool. */
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

/** Build the root-only confirmed write tool. */
export function personalityApplyTool(ctx: Context, refresh: (agent: Agent) => Promise<void>): ToolDefinition {
  return defineTool({
    name: 'personality_apply',
    description:
      'Write confirmed personality candidates into the global PERSONALITY.md. Call only after the user '
      + 'explicitly asks to apply reviewed candidates and pass confirm: true. This tool never learns '
      + 'automatically and is available only to a root agent.',
    parameters: {
      candidates: {
        type: 'array',
        required: true,
        description: 'Confirmed candidates to write, 1-20; each needs exact evidence and is rejected individually on failure.',
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderApplyResult(value as never) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'personality_apply')
      try {
        const result = await applyPersonalityCandidates(ctx, {
          candidates: args.candidates,
          confirm: args.confirm as true,
        }, exec.signal)
        if (result.applied.length > 0) await refresh(agent)
        return result as never
      } catch (error: unknown) {
        return { applied: [], rejected: [{ name: '', reason: String(error) }], path: globalPersonalityPath(), revision: 0 }
      }
    },
  })
}

/** Require the owning agent session a tool needs. */
function requireAgent(agent: Agent | undefined, tool: string): Agent {
  /* v8 ignore next -- the tool runtime always passes the owning agent. */
  if (agent === undefined) throw new Error(`${tool} requires an owning agent`)
  return agent
}
