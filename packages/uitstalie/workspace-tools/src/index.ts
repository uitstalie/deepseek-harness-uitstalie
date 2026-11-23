/**
 * Loader entry of the workspace toolset: loader values and public types only.
 * @module @deepseek-ai/dsh-workspace-tools/index
 */

export { apply, Config, inject, name, WORKSPACE_TOOLSET_CAPABILITY_ID } from './api.ts'
export { LEASE_ACTIVE_TURN_GRACE_MS, LEASE_IDLE_MS, LEASE_MAX_MS, WORKSPACE_LEASE_HELD, WORKSPACE_LEASE_LOST, classifyLeaseTool } from './lease.ts'
export type { LeaseClass, LeaseGuardOptions, WorkspaceLeaseGuard } from './lease.ts'
export type * from './api.ts'
export type * from './records.ts'
export { INTENT_ITEM_KINDS, INTENT_ITEM_SOURCES, INTENT_STATUSES, TASK_STATUSES, TASK_TYPES } from './records.ts'
export { ARTIFACT_RESOLVE_MAX_BYTES, ARTIFACT_RESOLUTION_STATUSES } from './artifacts.ts'
export type { CancelDispatchTaskInput, WorkspaceTasksService } from './service.ts'
export type { DispatchTaskIdentity, DispatchTaskInput } from './tasks.ts'
