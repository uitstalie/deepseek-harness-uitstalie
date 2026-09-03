/**
 * models-dev 插件的组合级测试：真实 Cordis Context + file:// 夹具，
 * 覆盖加载、查询、默认值映射、extra params 合并、DeepSeek body 注入、
 * 边界容错（畸形条目丢弃）与 fiber 处置后的服务摘除。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ModelsDevCatalog from '@deepseek-ai/dsh-models-dev'
import * as extraParams from '@deepseek-ai/dsh-models-dev/deepseek-extra-params'
import { DeepSeekLlmApiExtensionRegistry } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'

const FIXTURE_URL = pathToFileURL(fileURLToPath(new URL('./fixtures/api.json', import.meta.url))).href

/** 挂载带用户 extraParams 配置的目录服务，等首次加载完成后返回服务实例。 */
async function mountCatalog(ctx: Context) {
  await ctx.plugin(ModelsDevCatalog, {
    sourceUrl: FIXTURE_URL,
    extraParams: {
      deepseek: {
        headers: { 'x-custom': 'provider-level' },
        body: { thinking: { type: 'enabled' }, providerOnly: 1 },
        models: {
          'deepseek-v4-flash': {
            headers: { 'x-model': 'flash' },
            body: { thinking: { type: 'disabled' }, flashOnly: true },
          },
        },
      },
    },
  })
  const catalog = ctx.root.modelsDev
  await catalog.whenReady()
  return catalog
}

test('loads the file:// fixture and serves provider/model queries', async () => {
  const ctx = new Context()
  const catalog = await mountCatalog(ctx)

  expect(catalog.source).toBe('network')
  // broken-provider 无 models map 被丢弃；partial 与 deepseek 保留
  expect(catalog.listProviders().sort()).toEqual(['deepseek', 'partial'])
  // partial 里的 bad-model 被丢弃，good-model 保留
  expect(Object.keys(catalog.getProvider('partial')!.models)).toEqual(['good-model'])
})

test('maps model defaults to harness shape with route alias resolution', async () => {
  const ctx = new Context()
  const catalog = await mountCatalog(ctx)

  const defs = catalog.resolveModelDefaults('deepseek-official', 'deepseek-v4-flash')
  expect(defs).toMatchObject({
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    inputModalities: ['text'],
    reasoningEfforts: ['low', 'high', 'max'],
    reasoningToggle: true,
    toolCall: true,
    structuredOutput: true,
    interleavedField: 'reasoning_content',
    npm: '@ai-sdk/openai-compatible',
  })
  // 未知模型返回 undefined 而不是空对象
  expect(catalog.resolveModelDefaults('deepseek-official', 'no-such-model')).toBeUndefined()
  // 未配置别名的路由原样当 provider id 用
  expect(catalog.resolveModelDefaults('deepseek', 'deepseek-v4-flash')).toBeDefined()
})

test('resolves extra params with model-level config winning over provider-level', async () => {
  const ctx = new Context()
  const catalog = await mountCatalog(ctx)

  const params = catalog.resolveExtraParams('deepseek-official', 'deepseek-v4-flash')
  // model 级覆盖 provider 级的同名键，provider 级独有键保留
  expect(params.body).toEqual({
    thinking: { type: 'disabled' },
    providerOnly: 1,
    flashOnly: true,
  })
  expect(params.headers).toEqual({ 'x-custom': 'provider-level', 'x-model': 'flash' })

  // 无 model 级配置的模型只拿 provider 级
  const pro = catalog.resolveExtraParams('deepseek-official', 'deepseek-v4-pro')
  expect(pro.body).toEqual({ thinking: { type: 'enabled' }, providerOnly: 1 })

  // mode 参数带数据集的 experimental.modes 数据，用户配置仍然优先
  const fast = catalog.resolveExtraParams('deepseek-official', 'deepseek-v4-pro', 'fast')
  expect(fast.headers).toEqual({ 'x-beta': 'fast-mode', 'x-custom': 'provider-level' })
  expect(fast.body).toEqual({ speed: 'fast', thinking: { type: 'enabled' }, providerOnly: 1 })
})

test('injects configured body fields into DeepSeek requests via the api-extensions seam', async () => {
  const ctx = new Context()
  await mountCatalog(ctx)
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  await ctx.plugin(extraParams)

  const prepared = await ctx.root.deepseekLlmApiExtensions.prepare({
    body: { model: 'deepseek-v4-flash', messages: [] },
    signal: new AbortController().signal,
  })
  expect(prepared.fields).toEqual({
    thinking: { type: 'disabled' },
    providerOnly: 1,
    flashOnly: true,
  })

  // 未知模型只拿 provider 级字段（provider 级配置对该 provider 所有模型生效），
  // 不含 flash 的 model 级字段
  const unknown = await ctx.root.deepseekLlmApiExtensions.prepare({
    body: { model: 'good-model', messages: [] },
    signal: new AbortController().signal,
  })
  expect(unknown.fields).toEqual({ thinking: { type: 'enabled' }, providerOnly: 1 })
})

test('catalog service is removed with its fiber', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(ModelsDevCatalog, { sourceUrl: FIXTURE_URL })
  await fiber
  await fiber.dispose()
  expect(ctx.root.get('modelsDev', false)).toBeUndefined()
})

test('@Remote catalog queries serve provider and model summaries for the settings page', async () => {
  const ctx = new Context()
  const catalog = await mountCatalog(ctx)

  // 提供商摘要：id 排序、含协议方言/端点/凭据变量名/模型数（partial 缺字段即缺席）
  const providers = catalog.listCatalogProviders()
  expect(providers.map(provider => provider.id)).toEqual(['deepseek', 'partial'])
  expect(providers[0]).toMatchObject({
    id: 'deepseek',
    name: 'DeepSeek',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.deepseek.com',
    env: ['DEEPSEEK_API_KEY'],
    modelCount: 2,
  })

  // 模型摘要：能力字段齐备（设置页的模型子集勾选行）
  const models = catalog.listCatalogModels('deepseek')
  expect(models.map(model => model.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  expect(models[0]).toMatchObject({ id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 384_000, inputModalities: ['text'], reasoning: true })

  // 未知 provider 返回空数组而不是抛错（目录是 advisory 的）
  expect(catalog.listCatalogModels('no-such-provider')).toEqual([])
})
