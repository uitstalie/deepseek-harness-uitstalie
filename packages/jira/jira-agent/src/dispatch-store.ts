import type { Context } from '@deepseek-ai/cordis'
import {
  createDispatchStore as createCoreDispatchStore,
  DispatchStore,
  type DispatchProjection,
} from '@deepseek-ai/dsh-superagent-core'
import { markdownDispatchProjection } from './dispatch-projection.ts'

/** Preserve the Jira import path and inject the existing Markdown projection. */
export const createDispatchStore = (ctx: Context, root: string | undefined): DispatchStore | undefined =>
  root === undefined ? undefined : createCoreDispatchStore(ctx, root, markdownDispatchProjection(root))

export * from '@deepseek-ai/dsh-superagent-core'
export type { DispatchProjection }
