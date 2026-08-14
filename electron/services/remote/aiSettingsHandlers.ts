/**
 * 远程 AI 设置通道（手机遥控端）：TTS / 嵌入 / 重排 / 作图 的完整配置，外加主模型默认值。
 *
 * 字段定义（schema）由这边下发，手机端照着渲染表单——四个服务字段各不相同、
 * TTS 还要按服务商分支，两端各写一套表单迟早会漂移。以后桌面端加字段，
 * 只要往这里的 schema 补一行，手机端自动就有。
 *
 * 按用户明确要求做成「完整镜像桌面端」：apiKey 等密钥可读可写。
 * 代价是配对手机等同一份密钥副本，止血手段是设置页里的解除配对/吊销设备。
 */
import {
  ALIYUN_QWEN_TTS_MODELS,
  ALIYUN_QWEN_TTS_VOICES,
} from '../../../src/lib/aliyunQwenTtsCatalog'
import {
  STEPFUN_TTS_MODELS,
  STEPFUN_TTS_VOICES,
} from '../../../src/lib/stepfunTtsCatalog'
import {
  VOLCENGINE_TTS_RESOURCES,
  VOLCENGINE_TTS_SUPPORTED_ENDPOINTS,
  VOLCENGINE_TTS_VOICES,
} from '../../../src/lib/volcengineTtsCatalog'
import {
  XIAOMI_MIMO_TTS_MODELS,
  XIAOMI_MIMO_TTS_VOICES,
} from '../../../src/lib/xiaomiMimoTtsCatalog'
import type { ConfigService } from '../config'
import { agentRpcHandlers } from './agentRpcRegistry'

export type AiSettingField = {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'switch' | 'select'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
}

export type AiServiceId = 'tts' | 'embedding' | 'rerank' | 'imageGen'

const TTS_PROVIDERS: Array<{ value: string; label: string }> = [
  { value: 'xiaomi', label: '小米 MiMo' },
  { value: 'volcengine', label: '豆包（火山引擎）' },
  { value: 'aliyun-qwen', label: '阿里通义千问' },
  { value: 'stepfun', label: '阶跃星辰' },
]

/** 四个服务共用的连接字段，只有标签和占位不同 */
function connectionFields(options: {
  keyLabel?: string
  modelPlaceholder?: string
}): AiSettingField[] {
  return [
    { key: 'apiKey', label: options.keyLabel || 'API Key', type: 'password', placeholder: '留空表示不修改' },
    { key: 'baseURL', label: '接口地址', type: 'text', placeholder: 'https://…' },
    { key: 'model', label: '模型', type: 'text', placeholder: options.modelPlaceholder || '' },
  ]
}

function selectOptions(
  items: Array<{ id: string; label: string }>,
  currentValue: unknown,
): Array<{ value: string; label: string }> {
  const options = items.map((item) => ({ value: item.id, label: item.label }))
  const current = String(currentValue || '').trim()
  if (current && !options.some((item) => item.value === current)) {
    options.unshift({ value: current, label: current })
  }
  return options
}

function ttsFields(provider: string, config: Record<string, unknown>): AiSettingField[] {
  const base: AiSettingField[] = [
    { key: 'enabled', label: '启用语音合成', type: 'switch' },
    { key: 'activeProvider', label: '服务商', type: 'select', options: TTS_PROVIDERS },
    {
      key: 'apiKey',
      label: provider === 'volcengine' ? 'TTS / 声音复刻 API Key' : 'API Key',
      type: 'password',
      placeholder: '留空表示不修改',
    },
  ]

  if (provider === 'volcengine') {
    base.push(
      {
        key: 'baseURL',
        label: '接口地址',
        type: 'select',
        options: selectOptions(
          VOLCENGINE_TTS_SUPPORTED_ENDPOINTS.map((item) => ({ id: item.url, label: item.label })),
          config.baseURL,
        ),
      },
      {
        key: 'model',
        label: '模型',
        type: 'select',
        options: selectOptions(VOLCENGINE_TTS_RESOURCES, config.model),
      },
    )
    const resourceId = String(config.model || '')
    const voices = VOLCENGINE_TTS_VOICES.filter((item) => item.resourceIds.includes(resourceId))
    base.push(voices.length > 0
      ? { key: 'voice', label: '音色', type: 'select', options: selectOptions(voices, config.voice) }
      : { key: 'voice', label: 'Speaker ID', type: 'text', placeholder: '声音复刻返回的 Speaker ID' })
    // 豆包实时通话走另一套凭据，和普通合成的 apiKey 不是一个东西。
    base.push(
      { key: 'realtimeAppId', label: '通话 App ID', type: 'text' },
      { key: 'realtimeAccessKey', label: '通话 Access Key', type: 'password' },
    )
  } else if (provider === 'aliyun-qwen') {
    base.push(
      { key: 'baseURL', label: '接口地址', type: 'text', placeholder: 'wss://…' },
      { key: 'model', label: '模型', type: 'select', options: selectOptions(ALIYUN_QWEN_TTS_MODELS, config.model) },
    )
    const model = ALIYUN_QWEN_TTS_MODELS.find((item) => item.id === config.model)
    base.push(model?.kind === 'voice-clone'
      ? { key: 'voice', label: '复刻 voice', type: 'text', placeholder: '声音复刻返回的 voice' }
      : { key: 'voice', label: '音色', type: 'select', options: selectOptions(ALIYUN_QWEN_TTS_VOICES, config.voice) })
  } else if (provider === 'stepfun') {
    base.push(
      { key: 'baseURL', label: '接口地址', type: 'text', placeholder: 'https://…' },
      { key: 'model', label: '模型', type: 'select', options: selectOptions(STEPFUN_TTS_MODELS, config.model) },
      { key: 'voice', label: '音色', type: 'select', options: selectOptions(STEPFUN_TTS_VOICES, config.voice) },
    )
  } else if (provider === 'xiaomi') {
    base.push(
      { key: 'baseURL', label: '接口地址', type: 'text', placeholder: 'https://…' },
      { key: 'model', label: '模型', type: 'select', options: selectOptions(XIAOMI_MIMO_TTS_MODELS, config.model) },
    )
    const model = XIAOMI_MIMO_TTS_MODELS.find((item) => item.id === config.model)
    base.push(model?.kind === 'preset'
      ? { key: 'voice', label: '音色', type: 'select', options: selectOptions(XIAOMI_MIMO_TTS_VOICES, config.voice) }
      : {
          key: 'voice',
          label: model?.kind === 'voice-clone' ? '音色样本' : '音色',
          type: 'text',
          placeholder: model?.kind === 'voice-clone' ? '音频 Base64 Data URL' : '音色设计模型无需填写',
        })
  } else {
    base.push(
      ...connectionFields({ modelPlaceholder: '如 tts-1' }).slice(1),
      { key: 'voice', label: '音色', type: 'text', placeholder: '服务商的音色 ID' },
    )
  }
  base.push(
    { key: 'speed', label: '语速', type: 'number', placeholder: '1.0' },
    { key: 'instructions', label: '声音风格提示', type: 'text', placeholder: '可留空' },
  )
  return base
}

const EMBEDDING_FIELDS: AiSettingField[] = [
  { key: 'enabled', label: '启用嵌入', type: 'switch' },
  ...connectionFields({ modelPlaceholder: '如 text-embedding-3-small' }),
  { key: 'dimension', label: '向量维度', type: 'number', placeholder: '1024' },
  { key: 'imageEnabled', label: '启用图片向量化', type: 'switch' },
]

const RERANK_FIELDS: AiSettingField[] = [
  { key: 'enabled', label: '启用重排', type: 'switch' },
  ...connectionFields({ modelPlaceholder: '如 bge-reranker-v2-m3' }),
  { key: 'timeoutMs', label: '超时（毫秒）', type: 'number', placeholder: '8000' },
]

const IMAGE_GEN_FIELDS: AiSettingField[] = [
  { key: 'enabled', label: '启用作图', type: 'switch' },
  {
    key: 'protocol',
    label: '协议',
    type: 'select',
    options: [
      { value: 'openai-compatible', label: 'OpenAI 兼容' },
      { value: 'openai', label: 'OpenAI' },
      { value: 'google', label: 'Google' },
      { value: 'custom', label: '自定义' },
    ],
  },
  ...connectionFields({ modelPlaceholder: '如 gpt-image-1' }),
  { key: 'size', label: '图片尺寸', type: 'text', placeholder: '留空由 AI 自选，如 1024x1024' },
  { key: 'timeoutMs', label: '超时（毫秒）', type: 'number', placeholder: '120000' },
]

async function loadServiceConfig(
  service: AiServiceId,
  ttsProvider?: unknown,
): Promise<Record<string, unknown>> {
  if (service === 'tts') {
    const { getTtsConfig } = await import('../ai/ttsService')
    const config = getTtsConfig() as Record<string, unknown>
    const requestedProvider = String(ttsProvider || '')
    const provider = TTS_PROVIDERS.some((item) => item.value === requestedProvider)
      ? requestedProvider
      : String(config.activeProvider || 'xiaomi')
    const providers = (config.providers || {}) as Record<string, Record<string, unknown>>
    // 表单是平铺的，把当前服务商那份摊上来；写回时 saveTtsConfig 认这种平铺 patch
    return { ...config, ...(providers[provider] || {}), activeProvider: provider }
  }
  if (service === 'embedding') {
    const { getEmbeddingConfig } = await import('../ai/embeddingService')
    return getEmbeddingConfig() as unknown as Record<string, unknown>
  }
  if (service === 'rerank') {
    const { getRerankConfig } = await import('../ai/rerankService')
    return getRerankConfig() as unknown as Record<string, unknown>
  }
  const { getImageGenConfig } = await import('../ai/imageGenService')
  return getImageGenConfig() as unknown as Record<string, unknown>
}

/**
 * 四个服务的配置形状各不相同，这里统一按 Record 搬运，落到各自的 save 时用宽松断言。
 * 之所以安全：每个 saveXxxConfig 内部都会 normalize——多余的键丢弃、缺失的补默认值、
 * 类型不对的回落。手机端传来什么都不会写出一份非法配置。
 */
async function saveServiceConfig(
  service: AiServiceId,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (service === 'tts') {
    const { saveTtsConfig } = await import('../ai/ttsService')
    return saveTtsConfig(patch as never) as unknown as Record<string, unknown>
  }
  if (service === 'embedding') {
    const { saveEmbeddingConfig } = await import('../ai/embeddingService')
    return saveEmbeddingConfig(patch as never) as unknown as Record<string, unknown>
  }
  if (service === 'rerank') {
    const { saveRerankConfig } = await import('../ai/rerankService')
    return saveRerankConfig(patch as never) as unknown as Record<string, unknown>
  }
  const { saveImageGenConfig } = await import('../ai/imageGenService')
  return saveImageGenConfig(patch as never) as unknown as Record<string, unknown>
}

function fieldsFor(service: AiServiceId, config: Record<string, unknown>): AiSettingField[] {
  if (service === 'tts') return ttsFields(String(config.activeProvider || ''), config)
  if (service === 'embedding') return EMBEDDING_FIELDS
  if (service === 'rerank') return RERANK_FIELDS
  return IMAGE_GEN_FIELDS
}

/** 概览行的副标题：一眼看出配没配、用的什么模型 */
function summarize(service: AiServiceId, config: Record<string, unknown>): string {
  const enabled = config.enabled === true
  const model = String(config.model || '')
  if (service === 'tts') {
    const provider = TTS_PROVIDERS.find((item) => item.value === config.activeProvider)?.label || '未选服务商'
    const voice = String(config.voice || '')
    return `${enabled ? provider : '已关闭'}${voice ? ` · ${voice}` : ''}`
  }
  if (!enabled) return '已关闭'
  return model || '未填模型'
}

const SERVICES: Array<{ id: AiServiceId; name: string }> = [
  { id: 'tts', name: '语音合成' },
  { id: 'embedding', name: '嵌入（语义检索）' },
  { id: 'rerank', name: '重排' },
  { id: 'imageGen', name: '作图' },
]

function isAiServiceId(value: unknown): value is AiServiceId {
  return value === 'tts' || value === 'embedding' || value === 'rerank' || value === 'imageGen'
}

export function registerRemoteAiSettingsHandlers(configService: ConfigService): void {
  /** 概览：四个服务的状态一次拿回，避免手机端连开四个往返 */
  agentRpcHandlers.set('ai:listServices', async () => {
    try {
      const services = []
      for (const item of SERVICES) {
        const config = await loadServiceConfig(item.id)
        services.push({
          id: item.id,
          name: item.name,
          enabled: config.enabled === true,
          summary: summarize(item.id, config),
        })
      }
      return { success: true, services }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /** 单个服务的完整配置 + 字段定义，手机端照着渲染表单 */
  agentRpcHandlers.set('ai:getServiceConfig', async (_event, payload?: unknown) => {
    try {
      const input = (payload || {}) as { service?: unknown; ttsProvider?: unknown }
      const service = input.service
      if (!isAiServiceId(service)) return { success: false, error: '未知的服务' }
      const config = await loadServiceConfig(service, input.ttsProvider)
      return {
        success: true,
        name: SERVICES.find((item) => item.id === service)?.name || service,
        config,
        fields: fieldsFor(service, config),
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  agentRpcHandlers.set('ai:setServiceConfig', async (_event, payload?: unknown) => {
    try {
      const input = (payload || {}) as { service?: unknown; patch?: unknown }
      if (!isAiServiceId(input.service)) return { success: false, error: '未知的服务' }
      const patch = input.patch && typeof input.patch === 'object'
        ? { ...(input.patch as Record<string, unknown>) }
        : {}
      if (!Object.keys(patch).length) return { success: false, error: '没有可更新的字段' }
      // 空密钥表示「不修改」：手机端读回来的是明文，但用户多半只想改别的字段，
      // 清空输入框不该被当成把密钥抹掉
      if (patch.apiKey === '') delete patch.apiKey
      if (patch.realtimeAccessKey === '') delete patch.realtimeAccessKey

      // 切 TTS 服务商时，必须把目标服务商自己存的字段一起平铺进去。
      // saveTtsConfig 内部会 `...stored` 展开出上一个服务商的顶层密钥，
      // 而它判断「这是一份平铺 patch」的条件恒为真——只传 activeProvider 的话，
      // 旧服务商的密钥会被写进新服务商。桌面端靠 switchActiveProviderConfig 绕开了这点。
      if (input.service === 'tts' && typeof patch.activeProvider === 'string') {
        const { getTtsConfig } = await import('../ai/ttsService')
        const providers = (getTtsConfig() as unknown as {
          providers?: Record<string, Record<string, unknown>>
        }).providers || {}
        const target = providers[patch.activeProvider]
        if (target) Object.assign(patch, { ...target, ...patch })
      }

      const saved = await saveServiceConfig(input.service, patch)
      const config = await loadServiceConfig(input.service)
      return {
        success: true,
        config,
        fields: fieldsFor(input.service, config),
        saved: Boolean(saved),
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  agentRpcHandlers.set('ai:testService', async (_event, payload?: unknown) => {
    try {
      const service = (payload as { service?: unknown })?.service
      if (!isAiServiceId(service)) return { success: false, error: '未知的服务' }
      // 用已保存的配置测，不接受手机端现场传配置——那等于绕开保存这一步
      const config = await loadServiceConfig(service)
      if (service === 'tts') {
        const { synthesizeSpeech } = await import('../ai/ttsService')
        const result = await synthesizeSpeech('语音合成测试', { config: config as never })
        return result.success
          ? { success: true, message: '合成成功' }
          : { success: false, error: result.error || '合成失败' }
      }
      if (service === 'embedding') {
        const { testEmbeddingConfig } = await import('../ai/embeddingService')
        return await testEmbeddingConfig(config as never)
      }
      if (service === 'rerank') {
        const { testRerankConfig } = await import('../ai/rerankService')
        return await testRerankConfig(config as never)
      }
      const { testImageGenConfig } = await import('../ai/imageGenService')
      return await testImageGenConfig(config as never)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /** 使用手机端当前表单值合成试听，不要求先保存。 */
  agentRpcHandlers.set('ai:previewTts', async (_event, payload?: unknown) => {
    try {
      const input = (payload || {}) as { config?: unknown }
      if (!input.config || typeof input.config !== 'object') {
        return { success: false, error: '缺少语音合成配置' }
      }
      const { testTtsConfig } = await import('../ai/ttsService')
      const { refreshResolvedProxyUrl } = await import('../ai/proxyFetch')
      await refreshResolvedProxyUrl()
      return await testTtsConfig(input.config as never)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /**
   * 主对话模型的默认值。
   * agent:listProviders 只读，会话里的模型切换也只是单次覆盖——
   * 这里才是把某个服务商/模型设成全局默认。
   */
  agentRpcHandlers.set('ai:setDefaultPreset', async (_event, payload?: unknown) => {
    try {
      const input = (payload || {}) as { presetId?: unknown; model?: unknown }
      const presetId = String(input.presetId || '').trim()
      const preset = (configService.get('aiConfigPresets') || []).find((item) => item.id === presetId)
      if (!preset) return { success: false, error: '配置预设不存在，请先在电脑端添加' }

      const model = String(input.model || '').trim() || preset.model
      const providerConfig = {
        apiKey: preset.apiKey,
        model,
        baseURL: preset.baseURL,
        protocol: preset.protocol,
      } as Parameters<ConfigService['setAIProviderConfigAndActivate']>[1]
      configService.setAIProviderConfigAndActivate(preset.provider, providerConfig)
      configService.set('aiActiveConfigPresetId', preset.id)
      return {
        success: true,
        presetId: preset.id,
        name: preset.name,
        provider: preset.provider,
        model,
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  agentRpcHandlers.set('ai:setDefaultProvider', async (_event, payload?: unknown) => {
    try {
      const input = (payload || {}) as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
      const provider = String(input.provider || '').trim()
      if (!provider) return { success: false, error: '缺少服务商' }

      const existing = configService.getAllAIProviderConfigs()?.[provider]
      if (!existing?.apiKey) {
        return { success: false, error: '该服务商还没有配置密钥，请先在电脑端添加' }
      }
      const model = String(input.model || '').trim() || existing.model
      configService.setAIProviderConfigAndActivate(provider, { ...existing, model })
      configService.set('aiActiveConfigPresetId', '')
      if (typeof input.reasoningEffort === 'string') {
        const all = configService.getAllAIProviderConfigs() || {}
        const next = { ...(all[provider] || {}), reasoningEffort: input.reasoningEffort }
        configService.set('aiProviders', { ...all, [provider]: next } as never)
      }
      return { success: true, provider, model }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
