/**
 * `/policy`: the user-facing write path for the active soft policy profile.
 * The model cannot change the profile; only this command (and the deployment
 * config) can. The selection reuses the `permission/preset` session event so a
 * newer session remains replayable by an older build.
 *
 * @module @deepseek-ai/dsh-tool-policy/command
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands'
import type { ToolPolicyService } from './index.ts'

/**
 * Register the `/policy` command when a command registry is composed.
 * @param ctx - plugin context.
 * @param service - the policy service holding the profile table.
 */
export function installPolicyCommand(ctx: Context, service: ToolPolicyService): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-tool-policy'),
      name: 'policy',
      description: 'Switch the soft tool policy profile (best-effort; not an OS sandbox)',
      input: { hint: '<profile>' },
      handler: ({ agent, rawInput }) => {
        const name = rawInput.trim()
        const current = service.profileForSession(agent.session).name
        const available = service.names.join(', ')
        if (name === '') {
          return { kind: 'success', text: `current tool policy ${current} (available: ${available})` }
        }
        if (!service.has(name)) {
          return { kind: 'error', text: `unknown tool policy profile "${name}" (available: ${available})` }
        }
        service.select(agent.session, name)
        return { kind: 'success', text: `tool policy ${name}` }
      },
    })
  })
}
