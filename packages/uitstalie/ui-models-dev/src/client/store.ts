/**
 * models.dev 设置页的页面 store：目录快照 + 每提供商草稿 + 提交状态。
 * Host 是唯一事实来源——目录经 modelsDev Remote 拉取，成品路由经
 * settings.mutate 写 llm-plus 命名空间（写完由 llm-plus 的热更新接线接管），
 * 一次性密钥经 credentials.set 写凭据服务（本页不持久化密钥）。
 *
 * 文案纪律：store 只产出结构化失败数据（SubmitFailure），文案由组件层
 * 经 locales 字典映射。
 *
 * @module @deepseek-ai/dsh-client-ui-models-dev/store
 */

import type { ClientRemote, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CatalogModelSummary, CatalogProviderSummary } from '@deepseek-ai/dsh-models-dev/types'
import { defaultDraft, draftError, materializeRoute, type ProviderDraft } from './draft.ts'

/** 本页用到的 wire 方法（窄化面）。 */
export interface ModelsDevWire {
  modelsDev: Pick<ClientRemote['modelsDev'], 'listCatalogProviders' | 'listCatalogModels'>
  settings: Pick<ClientRemote['settings'], 'mutate'>
  credentials: Pick<ClientRemote['credentials'], 'set'>
}

/** 提交失败的结构化形态（组件映射为字典文案）。 */
export type SubmitFailure =
  | { readonly kind: 'protocol'; readonly provider: string }
  | { readonly kind: 'invalidJson'; readonly field: 'headers' | 'body'; readonly provider: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'message'; readonly message: string }

/** 页面快照（纯数据）。 */
export interface ModelsDevState {
  /** 目录加载状态。 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 加载失败的 host 消息。 */
  error: string | null
  /** 目录提供商（已按 id 排序）。 */
  providers: readonly CatalogProviderSummary[]
  /** 筛选串（小写匹配 id/name/npm）。 */
  filter: string
  /** 勾选的提供商 id → 草稿。 */
  drafts: Record<string, ProviderDraft>
  /** 模型子集数据（'loading' = 拉取中；缺席 = 未拉取）。 */
  models: Record<string, readonly CatalogModelSummary[] | 'loading'>
  /** 提交进行中。 */
  submitting: boolean
  /** 最近一次提交失败。 */
  submitError: SubmitFailure | null
  /** 最近一次提交写成的路由 id 集（成功回执）。 */
  addedRoutes: readonly string[]
}

/** 初始快照。 */
function initialState(): ModelsDevState {
  return {
    status: 'idle',
    error: null,
    providers: [],
    filter: '',
    drafts: {},
    models: {},
    submitting: false,
    submitError: null,
    addedRoutes: [],
  }
}

/** 去掉一个键的 Record 副本（no-dynamic-delete：动态键删除用重建代替）。 */
function omitKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => !keys.has(candidate)))
}

/** 页面控制器（register 的 inject 持有；hooks 舱位把 store 绑成 useSnapshot）。 */
export class ModelsDevStore {
  /** 页面快照源（renderer 绑为 useSnapshot）。 */
  readonly store: SnapshotStore<ModelsDevState> = createSnapshotStore(initialState())

  constructor(private readonly wire: ModelsDevWire) {}

  /** 拉取目录提供商列表（挂载时一次 + 失败重试共用此入口）。 */
  async load(): Promise<void> {
    this.store.update((draft) => {
      draft.status = 'loading'
      draft.error = null
    })
    try {
      const result = await this.wire.modelsDev.listCatalogProviders()
      this.store.update((draft) => {
        if (result.ok) {
          draft.status = 'ready'
          draft.providers = result.value
        } else {
          draft.status = 'error'
          draft.error = result.error.message
        }
      })
    } catch (error) {
      // RemoteResult 契约：业务失败折叠进 {ok:false}；能 reject 的只有装配
      // 故障（方法未挂载/连接未就绪）——同样是 error 态 + 可重试
      const message = error instanceof Error ? error.message : String(error)
      console.error('ui-models-dev: catalog load rejected', error)
      this.store.update((draft) => {
        draft.status = 'error'
        draft.error = message
      })
    }
  }

  /** 更新筛选串。 */
  setFilter(filter: string): void {
    this.store.update((draft) => {
      draft.filter = filter
    })
  }

  /** 勾选/取消一个提供商；勾选时以目录默认值生成草稿。 */
  toggleProvider(provider: CatalogProviderSummary, checked: boolean): void {
    this.store.update((draft) => {
      if (checked) draft.drafts[provider.id] = defaultDraft(provider)
      else draft.drafts = omitKeys(draft.drafts, new Set([provider.id]))
    })
  }

  /** 更新一个草稿的局部字段（组件按字段名派发）。 */
  updateDraft(id: string, patch: Partial<ProviderDraft>): void {
    this.store.update((draft) => {
      const current = draft.drafts[id]
      if (current !== undefined) draft.drafts[id] = { ...current, ...patch }
    })
  }

  /** 惰性拉取一个提供商的模型列表（subset 模式与模型数展示用）。 */
  async ensureModels(id: string): Promise<void> {
    if (this.store.getSnapshot().models[id] !== undefined) return
    this.store.update((draft) => {
      draft.models[id] = 'loading'
    })
    const result = await this.wire.modelsDev.listCatalogModels(id)
    this.store.update((draft) => {
      // 失败按空表处理（模型数是 advisory 展示；目录缺席不阻塞物化）
      draft.models[id] = result.ok ? result.value : []
      // 首次进入 subset 前的默认全选，等数据就位再铺
      const current = draft.drafts[id]
      if (current?.modelMode === 'subset' && current.modelIds.length === 0 && result.ok) {
        draft.drafts[id] = { ...current, modelIds: result.value.map(model => model.id) }
      }
    })
  }

  /** 切换模型子集模式；进入 subset 时默认全选（数据未到则待 ensureModels 铺）。 */
  setModelMode(id: string, mode: ProviderDraft['modelMode']): void {
    this.store.update((draft) => {
      const current = draft.drafts[id]
      if (current === undefined) return
      const loaded = draft.models[id]
      const allIds = loaded !== undefined && loaded !== 'loading' ? loaded.map(model => model.id) : []
      draft.drafts[id] = { ...current, modelMode: mode, modelIds: mode === 'subset' ? allIds : [] }
    })
    if (mode === 'subset') void this.ensureModels(id)
  }

  /** subset 模式下勾选一个模型。 */
  toggleModel(id: string, modelId: string, checked: boolean): void {
    this.store.update((draft) => {
      const current = draft.drafts[id]
      if (current === undefined) return
      draft.drafts[id] = {
        ...current,
        modelIds: checked
          ? [...current.modelIds, modelId]
          : current.modelIds.filter(candidate => candidate !== modelId),
      }
    })
  }

  /**
   * 物化提交：全部草稿先过本地校验（一个非法整体不写），一次 mutate 写入
   * 全部路由，再逐个写入一次性密钥。成功清除已添加的草稿并记录回执。
   */
  async submit(): Promise<void> {
    const snapshot = this.store.getSnapshot()
    if (snapshot.submitting) return
    const entries = Object.entries(snapshot.drafts)
    if (entries.length === 0) return
    this.store.update((draft) => {
      draft.submitting = true
      draft.submitError = null
      draft.addedRoutes = []
    })
    const fail = (failure: SubmitFailure): void => {
      this.store.update((draft) => {
        draft.submitting = false
        draft.submitError = failure
      })
    }
    // 本地校验：协议必选、JSON 字段必须合法（一个非法整体不写）
    for (const [id, draft] of entries) {
      const error = draftError(draft)
      if (error === 'protocol') return fail({ kind: 'protocol', provider: id })
      if (error === 'headers' || error === 'body') return fail({ kind: 'invalidJson', field: error, provider: id })
    }
    const ops: SettingsPathOpView[] = entries.map(([id, draft]) => {
      const loaded = snapshot.models[id]
      return {
        op: 'set',
        path: ['routes', draft.routeId.trim() === '' ? id : draft.routeId.trim()],
        value: materializeRoute(id, draft, loaded === undefined || loaded === 'loading' ? [] : loaded),
      }
    })
    // expectedRevision 不传（本页不跟踪 llm-plus 命名空间的修订号；
    // 冲突场景由 host 的 settings-conflict 兜住语义，v1 不做乐观锁）
    const response = await this.wire.settings.mutate('llm-plus', ops, undefined)
    if (!response.ok) {
      return fail(response.error.code === 'settings-conflict' ? { kind: 'conflict' } : { kind: 'message', message: response.error.message })
    }
    // 一次性密钥：逐个写凭据服务（密钥不经过 settings，也不在本页持久化）
    for (const [, draft] of entries) {
      const ref = draft.apiKeyRef.trim()
      const key = draft.apiKey.trim()
      if (ref === '' || key === '') continue
      const stored = await this.wire.credentials.set(ref, key)
      if (!stored.ok) return fail({ kind: 'message', message: stored.error.message })
    }
    const added = ops.flatMap(op => op.path[1] === undefined ? [] : [op.path[1]])
    this.store.update((draft) => {
      draft.submitting = false
      draft.addedRoutes = added
      // 已提交的草稿整体清除（entries 是提交前的快照，含改过的 routeId）
      draft.drafts = omitKeys(draft.drafts, new Set(entries.map(([id]) => id)))
    })
  }
}
