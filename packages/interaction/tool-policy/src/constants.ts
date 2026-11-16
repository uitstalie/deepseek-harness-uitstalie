/** Runtime vocabulary shared by the soft tool-policy profiles and prompts. */

import type { FileAccessOperation } from './types.ts'

/** Every file operation, in a stable order for prompts and diagnostics. */
export const FILE_ACCESS_OPERATIONS: readonly FileAccessOperation[] = ['read', 'write', 'list']
