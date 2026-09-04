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
import type { AttemptView, OAuthRouteInfo } from '@deepseek-ai/dsh-llm-plus/types'
import type { RouteConfig } from '@deepseek-ai/dsh-llm-plus'
import { defaultDraft, draftError, materializeRoute, type ProviderDraft } from './draft.ts'
import { draftToRoute, routeDraftError, routeToDraft, type RouteDraft } from './route-edit.ts'

/** 本页用到的 wire 方法（窄化面）。 */
export interface ModelsDevWire {
  modelsDev: Pick<ClientRemote['modelsDev'], 'listCatalogProviders' | 'listCatalogModels'>
  settings: Pick<ClientRemote['settings'], 'mutate' | 'describe'>
  credentials: Pick<ClientRemote['credentials'], 'set'>
  /** llm-plus 的 OAuth Remote（登录流触发/轮询/回答/取消）。 */
  llmPlusAuth: Pick<ClientRemote['llmPlusAuth'], 'listOAuthRoutes' | 'beginFlow' | 'describeAttempt' | 'submitPromptAnswer' | 'cancelAttempt'>
}

/** 提交失败的结构化形态（组件映射为字典文案）。 */
export type SubmitFailure =
  | { readonly kind: 'protocol'; readonly provider: string }
  | { readonly kind: 'invalidJson'; readonly field: 'headers' | 'body'; readonly provider: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'message'; readonly message: string }

/** OAuth 登录区的状态（纯数据）。 */
export interface OAuthSectionState {
  /** 清单加载状态。 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 带 OAuth 能力的路由（含凭据在位状态）。 */
  routes: readonly OAuthRouteInfo[]
  /** routeId → 最新一次尝试的视图（轮询桥的结果）。 */
  attempts: Record<string, AttemptView>
  /** promptId → 文本输入框草稿（回答提交前的载体）。 */
  answerDrafts: Record<string, string>
}

/** "我的路由"管理区状态（纯数据）。 */
export interface MyRoutesState {
  /** 当前路由表（llm-plus 命名空间的生效值；空 = 未加载或无路由）。 */
  routes: Record<string, RouteConfig>
  /** 正在编辑的路由（草稿载体）。 */
  editing: { routeId: string; draft: RouteDraft } | undefined
  /** 编辑/删除失败的 host 消息。 */
  failure: string | null
}

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
  /** OAuth 登录区。 */
  oauth: OAuthSectionState
  /** "我的路由"管理区。 */
  myRoutes: MyRoutesState
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
    oauth: { status: 'idle', routes: [], attempts: {}, answerDrafts: {} },
    myRoutes: { routes: {}, editing: undefined, failure: null },
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

  /** 拉取目录提供商列表（挂载时一次 + 失败重试共用此入口；后台刷新不打断现状）。 */
  async load(background = false): Promise<void> {
    // 后台轮询时不清空现有列表（避免闪烁）；只有首次/显式重试才进 loading 态
    if (!background) {
      this.store.update((draft) => {
        draft.status = 'loading'
        draft.error = null
      })
    }
    try {
      const result = await this.wire.modelsDev.listCatalogProviders()
      this.store.update((draft) => {
        if (result.ok) {
          draft.status = 'ready'
          draft.providers = result.value
          draft.error = null
        } else if (!background) {
          draft.status = 'error'
          draft.error = result.error.message
        }
      })
    } catch (error) {
      // RemoteResult 契约：业务失败折叠进 {ok:false}；能 reject 的只有装配
      // 故障（方法未挂载/连接未就绪）——显式加载进 error 态，后台轮询只记日志
      if (!background) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('ui-models-dev: catalog load rejected', error)
        this.store.update((draft) => {
          draft.status = 'error'
          draft.error = message
        })
      } else {
        console.error('ui-models-dev: background catalog refresh rejected', error)
      }
    }
  }

  /** 轮询循环的存活开关（fiber 摘除时停）。 */
  private polling = false

  /**
   * 目录刷新循环：60s 轮一次（目录 TTL 是小时级，摘要调用极轻；gateway 的
   * 转发事件通道是应用独占的，models-dev/updated 推不出来，轮询是诚实的
   * 通道）。host 侧 Remote 等到首次加载落地才答，启动竞速不在页面。
   */
  startCatalogPolling(): void {
    if (this.polling) return
    this.polling = true
    void (async () => {
      while (this.polling) {
        await new Promise(resolve => setTimeout(resolve, 60_000))
        if (this.polling) await this.load(true)
      }
    })()
  }

  /** 停止轮询循环（页面 fiber 摘除时调用）。 */
  stopCatalogPolling(): void {
    this.polling = false
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

  // -------------------------------------------------------------------------
  // OAuth 登录区（轮询桥的消费端：running 期间 800ms 轮一次 describeAttempt）
  // -------------------------------------------------------------------------

  /** 加载带 OAuth 能力的路由清单（挂载时 + 每次尝试终结后刷新 configured）。 */
  async loadOAuthRoutes(): Promise<void> {
    this.store.update((draft) => {
      draft.oauth.status = 'loading'
    })
    try {
      const result = await this.wire.llmPlusAuth.listOAuthRoutes()
      this.store.update((draft) => {
        draft.oauth.status = 'ready'
        if (result.ok) draft.oauth.routes = result.value
      })
    } catch (error) {
      console.error('ui-models-dev: oauth route list load rejected', error)
      this.store.update((draft) => {
        draft.oauth.status = 'error'
      })
    }
  }

  /** 发起一次登录尝试并驱动轮询直到终态。 */
  async beginLogin(routeId: string): Promise<void> {
    const result = await this.wire.llmPlusAuth.beginFlow(routeId)
    if (!result.ok) {
      console.error('ui-models-dev: beginFlow failed', result.error)
      return
    }
    const attemptId = result.value.attemptId
    // 轮询桥：直到终态；终结后刷新路由清单（configured 可能翻转为 true）
    let view: AttemptView | undefined
    do {
      const described = await this.wire.llmPlusAuth.describeAttempt(attemptId)
      if (described.ok) {
        view = described.value
        this.store.update((draft) => {
          draft.oauth.attempts[routeId] = described.value
        })
      }
      if (view === undefined || view.status === 'running') {
        await new Promise(resolve => setTimeout(resolve, 800))
      }
    } while (view === undefined || view.status === 'running')
    await this.loadOAuthRoutes()
  }

  /** 回答待答 prompt（文本框草稿随回答清除）。 */
  async answerPrompt(routeId: string, promptId: string): Promise<void> {
    const attemptId = this.store.getSnapshot().oauth.attempts[routeId]?.id ?? ''
    const value = this.store.getSnapshot().oauth.answerDrafts[promptId] ?? ''
    const result = await this.wire.llmPlusAuth.submitPromptAnswer(attemptId, promptId, value)
    if (result.ok) {
      this.store.update((draft) => {
        draft.oauth.answerDrafts = omitKeys(draft.oauth.answerDrafts, new Set([promptId]))
      })
    }
  }

  /** 更新 prompt 回答的输入框草稿。 */
  setAnswerDraft(promptId: string, value: string): void {
    this.store.update((draft) => {
      draft.oauth.answerDrafts[promptId] = value
    })
  }

  /** 取消一次在途尝试。 */
  async cancelLogin(routeId: string): Promise<void> {
    const attemptId = this.store.getSnapshot().oauth.attempts[routeId]?.id
    if (attemptId === undefined) return
    await this.wire.llmPlusAuth.cancelAttempt(attemptId)
  }

  // -------------------------------------------------------------------------
  // "我的路由"管理区（读 settings 的 llm-plus 命名空间生效值，写经 mutate 路径操作）
  // -------------------------------------------------------------------------

  /** 读当前路由表（挂载时 + 每次写操作后）。 */
  async loadMyRoutes(): Promise<void> {
    const described = await this.wire.settings.describe()
    if (!described.ok) return
    // describe 的命名空间视图：找 llm-plus 的生效值（base←user 已合并）
    const view = described.value.namespaces.find((ns: { ns: string }) => ns.ns === 'llm-plus')
    const value = (view as { value?: { routes?: Record<string, RouteConfig> } } | undefined)?.value
    this.store.update((draft) => {
      draft.myRoutes.routes = value?.routes ?? {}
    })
  }

  /** 进入一条路由的编辑（草稿从当前配置生成）。 */
  startEditRoute(routeId: string): void {
    const route = this.store.getSnapshot().myRoutes.routes[routeId]
    if (route === undefined) return
    this.store.update((draft) => {
      draft.myRoutes.editing = { routeId, draft: routeToDraft(route) }
      draft.myRoutes.failure = null
    })
  }

  /** 更新编辑草稿的局部字段。 */
  patchEditDraft(patch: Partial<RouteDraft>): void {
    this.store.update((draft) => {
      const current = draft.myRoutes.editing
      if (current !== undefined) draft.myRoutes.editing = { ...current, draft: { ...current.draft, ...patch } }
    })
  }

  /** 取消编辑。 */
  cancelEditRoute(): void {
    this.store.update((draft) => {
      draft.myRoutes.editing = undefined
    })
  }

  /** 保存编辑：物化草稿 + 原路由的非编辑面字段原样带回，mutate set 写回。 */
  async saveEditRoute(): Promise<void> {
    const editing = this.store.getSnapshot().myRoutes.editing
    if (editing === undefined) return
    const failure = routeDraftError(editing.draft)
    if (failure !== undefined) {
      this.store.update((draft) => {
        draft.myRoutes.failure = failure
      })
      return
    }
    const original = this.store.getSnapshot().myRoutes.routes[editing.routeId]
    // 非编辑面字段（modelsDevProvider/models/retryPolicy/requestImagePolicy）原样带回
    const next: Record<string, unknown> = {
      ...(original?.modelsDevProvider === undefined ? {} : { modelsDevProvider: original.modelsDevProvider }),
      ...(original?.models === undefined || original.models.length === 0 ? {} : { models: original.models }),
      ...(original?.retryPolicy === undefined ? {} : { retryPolicy: original.retryPolicy }),
      ...(original?.requestImagePolicy == null ? {} : { requestImagePolicy: original.requestImagePolicy }),
      ...draftToRoute(editing.draft),
    }
    const response = await this.wire.settings.mutate('llm-plus', [{ op: 'set', path: ['routes', editing.routeId], value: next as never }], undefined)
    this.store.update((draft) => {
      if (response.ok) {
        draft.myRoutes.editing = undefined
        draft.myRoutes.failure = null
      } else {
        draft.myRoutes.failure = response.error.message
      }
    })
    if (response.ok) await this.loadMyRoutes()
  }

  /** 删除一条路由（mutate unset）。 */
  async deleteRoute(routeId: string): Promise<void> {
    const response = await this.wire.settings.mutate('llm-plus', [{ op: 'unset', path: ['routes', routeId] }], undefined)
    this.store.update((draft) => {
      draft.myRoutes.failure = response.ok ? null : response.error.message
    })
    if (response.ok) await this.loadMyRoutes()
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
    // 物化成的路由进"我的路由"管理区
    await this.loadMyRoutes()
  }
}
