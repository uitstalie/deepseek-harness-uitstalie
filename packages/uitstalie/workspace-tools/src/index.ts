/**
 * Loader entry of the workspace toolset: loader values and public types only.
 * @module @deepseek-ai/dsh-workspace-tools/index
 */

export { apply, inject, name, WORKSPACE_TOOLSET_CAPABILITY_ID } from './api.ts'
export type * from './api.ts'
export type * from './records.ts'
export { TASK_STATUSES, TASK_TYPES } from './records.ts'
export { ARTIFACT_RESOLVE_MAX_BYTES, ARTIFACT_RESOLUTION_STATUSES } from './artifacts.ts'
