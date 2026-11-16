/**
 * The built-in always-on context source: every Markdown file under
 * `<projectRoot>/.dsh/rules`, rendered with the instruction loader's own
 * renderer so the baseline framing stays native.
 * @module @deepseek-ai/dsh-agent-instructions-plus/rules-source
 */

import { renderAgentInstructions } from '@deepseek-ai/dsh-agent-instructions'
import type { DshStore } from '@deepseek-ai/dsh-store-atom'
import type { ResolvedRulesConfig } from './config.ts'
import type { AgentContextSource } from './sources.ts'

/**
 * Build the workspace-rules source.
 * @param config - resolved rules configuration.
 * @param store - the owning `.dsh` store service.
 * @returns the source rendering `.dsh/rules` as one baseline segment.
 */
export function createRulesSource(config: ResolvedRulesConfig, store: DshStore): AgentContextSource {
  return {
    name: 'rules',
    async render({ projectRoot, signal }) {
      if (!config.enabled || config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
      const scan = await store.scanRules(projectRoot, {
        maxSourceBytes: config.maxSourceBytes,
        signal,
      })
      if (scan.files.length === 0) return { text: '', digest: scan.digest }
      const rendered = renderAgentInstructions(scan.files, { maxBytes: config.maxBytes })
      return { text: rendered.text, digest: scan.digest }
    },
  }
}
