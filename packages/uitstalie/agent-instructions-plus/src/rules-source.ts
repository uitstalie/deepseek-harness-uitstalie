/**
 * The built-in always-on context source: every Markdown file under
 * `<projectRoot>/.dsh/rules`, rendered with the instruction loader's own
 * renderer so the baseline framing stays native.
 * @module @deepseek-ai/dsh-agent-instructions-plus/rules-source
 */

import { renderAgentInstructions } from '@deepseek-ai/dsh-agent-instructions'
import { scanWorkspaceRules } from './rules.ts'
import type { ResolvedRulesConfig } from './config.ts'
import type { AgentContextSource } from './sources.ts'

/**
 * Build the workspace-rules source.
 * @param config - resolved rules configuration.
 * @returns the source rendering `.dsh/rules` as one baseline segment.
 */
export function createRulesSource(config: ResolvedRulesConfig): AgentContextSource {
  return {
    name: 'rules',
    async render({ fileSystem, projectRoot, signal }) {
      if (!config.enabled || config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
      const scan = await scanWorkspaceRules(fileSystem, {
        projectRoot,
        maxSourceBytes: config.maxSourceBytes,
        signal,
      })
      if (scan.files.length === 0) return { text: '', digest: scan.digest }
      const rendered = renderAgentInstructions(scan.files, { maxBytes: config.maxBytes })
      return { text: rendered.text, digest: scan.digest }
    },
  }
}
