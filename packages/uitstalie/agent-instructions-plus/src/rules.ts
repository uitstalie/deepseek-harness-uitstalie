/**
 * Workspace-rules discovery moved to the store atom so the `.dsh` rules area has one owner and the
 * dependency arrow stays one-way (`agent-instructions-plus` → atom). Re-exported here because this
 * package's loader and its tests import the scan from this path.
 * @module @deepseek-ai/dsh-agent-instructions-plus/rules
 */

export {
  RULES_DIRECTORY,
  rulesScanChanged,
  scanWorkspaceRules,
} from '@deepseek-ai/dsh-store-atom'
export type { RulesScan, RulesScanOptions } from '@deepseek-ai/dsh-store-atom'
