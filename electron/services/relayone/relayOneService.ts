import { net } from 'electron'
import type { ConfigService } from '../config'
import {
  RELAYONE_DEFAULT_MODEL,
  type RelayOneApiKey,
  type RelayOneCheckoutInfo,
  type RelayOneCreateKeyInput,
  type RelayOneCreatePaymentOrderInput,
  type RelayOneEnsureKeysResult,
  type RelayOneGroup,
  type RelayOneLoginInput,
  type RelayOneLoginResult,
  type RelayOnePaymentMethod,
  type RelayOnePaymentOrder,
  type RelayOnePaymentOrderStatus,
  type RelayOnePublicSettings,
  type RelayOneRegisterInput,
  type RelayOneStatus,
  type RelayOneUser
} from '../../../src/types/relayOne'
import { RelayOneSessionStore, type RelayOneSession } from './relayOneSessionStore'
import {
  RELAYONE_INFERENCE_BASE_URL,
  RELAYONE_MANAGED_GROUPS,
  getRelayOneChatKeys,
  getRelayOneImageKey,
  getRelayOneManagedState,
  listRelayOneAggregatedModels,
  relayOneManagedKeyName,
  relayOneProtocolForKind,
  type RelayOneManagedKeyEntry,
  type RelayOneManagedKeysState
} from './relayOneManagedKeys'

export const RELAYONE_CONTROL_BASE_URL = 'https://aiapi.aiqji.cn/api/v1'
export { RELAYONE_INFERENCE_BASE_URL }

type JsonRecord = Record<string, unknown>

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: JsonRecord
  authenticated?: boolean
  retryUnauthorized?: boolean
}

class RelayOneApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: number | string) {
    super(message)
    this.name = 'RelayOneApiError'
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function firstString(source: JsonRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return fallback
}

function optionalNumber(source: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const rawValue = source[key]
    if (rawValue === null || rawValue === undefined || rawValue === '') continue
    const value = Number(rawValue)
    if (Number.isFinite(value)) return value
  }
  return undefined
}

function numericGroupId(value: string | undefined, defaultValue?: number): number | undefined {
  const text = value?.trim() || ''
  if (!text) return defaultValue
  const groupId = Number(text)
  if (!Number.isSafeInteger(groupId) || groupId < 0) throw new Error('RelayOne 分组 ID 无效')
  return groupId
}

function firstBoolean(source: JsonRecord, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean') return value
    if (value === 1 || value === '1' || value === 'true') return true
    if (value === 0 || value === '0' || value === 'false') return false
  }
  return fallback
}

function localizeErrorMessage(message: string): string {
  const normalized = message.trim().toLowerCase()
  const translations: Array<[RegExp, string]> = [
    [/invalid email or password/, '邮箱或密码错误'],
    [/invalid (verification|verify) code/, '邮箱验证码错误'],
    [/invalid (two[- ]factor|2fa|totp) code/, '两步验证码错误'],
    [/email (already exists|already registered|is already in use)/, '该邮箱已注册'],
    [/user not found/, '用户不存在'],
    [/insufficient (balance|funds|quota)/, '账户余额不足'],
    [/amount (is )?out of range/, '充值数量超出站点允许范围'],
    [/order not found/, '订单不存在'],
    [/(api )?key not found/, 'API Key 不存在'],
    [/token (has )?expired/, '登录状态已过期，请重新登录']
  ]
  return translations.find(([pattern]) => pattern.test(normalized))?.[1] || message
}

function getItems(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value
  const source = asRecord(value)
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key] as unknown[]
    const mapped = asRecord(source[key])
    if (Object.keys(mapped).length > 0) {
      return Object.entries(mapped).map(([id, item]) => {
        const itemRecord = asRecord(item)
        return Object.keys(itemRecord).length > 0 ? { id, ...itemRecord } : { id, value: item }
      })
    }
  }
  return []
}

function nestedRecord(source: JsonRecord, keys: string[]): JsonRecord {
  for (const key of keys) {
    const value = asRecord(source[key])
    if (Object.keys(value).length > 0) return value
  }
  return source
}

function extractApiKey(value: unknown): { rawKey: string; entity: JsonRecord } {
  const source = asRecord(value)
  const entity = nestedRecord(source, ['api_key', 'apiKey', 'key', 'item', 'data'])
  return {
    rawKey: firstString(source, ['key', 'api_key', 'apiKey', 'token', 'value'])
      || firstString(entity, ['key', 'api_key', 'apiKey', 'token', 'value', 'secret']),
    entity
  }
}

function isUsableApiKey(value: string): boolean {
  return Boolean(value && !/[*•…]|\.\.\./.test(value))
}

const NON_CHAT_MODEL_PATTERNS = ['embedding', 'rerank', 'whisper', 'tts', 'transcribe', 'speech', 'moderation', 'dall-e', 'image', 'stable-diffusion']

/** 聊天分组滤掉明显的非聊天模型；生图分组原样保留 */
function filterManagedGroupModels(kind: RelayOneManagedKeyEntry['kind'], models: string[]): string[] {
  if (kind === 'image') return models
  const chatModels = models.filter((model) => {
    const lower = model.toLowerCase()
    return !NON_CHAT_MODEL_PATTERNS.some((pattern) => lower.includes(pattern))
  })
  return chatModels.length > 0 ? chatModels : models
}

const MASKED_SECRET_SEGMENT = '****************'

function maskSecret(value: string): string {
  const text = value.trim()
  if (!text) return ''
  if (text.length <= 8) return `${text.slice(0, 2)}${MASKED_SECRET_SEGMENT}`
  return `${text.slice(0, 4)}${MASKED_SECRET_SEGMENT}${text.slice(-4)}`
}

function normalizeSecretPreview(value: string): string {
  const text = value.trim()
  if (!text) return ''
  if (isUsableApiKey(text)) return maskSecret(text)
  return text.replace(/(?:[*•…]+|\.\.\.)+/g, MASKED_SECRET_SEGMENT)
}

function normalizeUser(value: unknown): RelayOneUser {
  const source = asRecord(value)
  return {
    id: firstString(source, ['id', 'user_id', 'userId']),
    email: firstString(source, ['email']),
    name: firstString(source, ['name', 'username', 'nickname', 'display_name'], firstString(source, ['email'])),
    avatarUrl: firstString(source, ['avatar_url', 'avatarUrl', 'avatar']) || undefined,
    balance: optionalNumber(source, ['balance', 'credit_balance', 'credits', 'quota_remaining', 'remain_quota']),
    quota: optionalNumber(source, ['quota', 'total_quota', 'credit_limit']),
    usedQuota: optionalNumber(source, ['used_quota', 'quota_used', 'used_credits']),
    groupId: firstString(source, ['group_id', 'groupId']) || undefined,
    groupName: firstString(source, ['group_name', 'groupName', 'group']) || undefined,
    createdAt: firstString(source, ['created_at', 'createdAt']) || undefined
  }
}

function normalizeApiKey(value: unknown): RelayOneApiKey {
  const source = asRecord(value)
  const rawKey = firstString(source, ['key', 'api_key', 'apiKey', 'token', 'value'])
  const keyPreview = firstString(source, ['key_preview', 'keyPreview', 'masked_key'], rawKey)
  return {
    id: firstString(source, ['id', 'key_id', 'keyId']),
    name: firstString(source, ['name', 'key_name', 'keyName'], '未命名 Key'),
    keyPreview: normalizeSecretPreview(keyPreview),
    groupId: firstString(source, ['group_id', 'groupId']) || undefined,
    groupName: firstString(source, ['group_name', 'groupName', 'group']) || undefined,
    enabled: firstBoolean(source, ['enabled', 'is_enabled', 'active'], true),
    isApplied: false,
    createdAt: firstString(source, ['created_at', 'createdAt']) || undefined,
    expiresAt: firstString(source, ['expires_at', 'expiresAt']) || undefined,
    lastUsedAt: firstString(source, ['last_used_at', 'lastUsedAt']) || undefined
  }
}

function normalizeGroup(value: unknown): RelayOneGroup {
  const source = asRecord(value)
  return {
    id: firstString(source, ['id', 'group_id', 'groupId', 'name']),
    name: firstString(source, ['name', 'group_name', 'groupName', 'id']),
    description: firstString(source, ['description', 'desc']) || undefined,
    enabled: firstBoolean(source, ['enabled', 'is_enabled', 'active'], true),
    rateMultiplier: optionalNumber(source, ['rate_multiplier', 'rateMultiplier', 'rate']) || 1
  }
}

function normalizeOrderStatus(value: string): RelayOnePaymentOrderStatus {
  const normalized = value.trim().toLowerCase()
  if (['pending', 'paid', 'failed', 'cancelled', 'expired'].includes(normalized)) {
    return normalized as RelayOnePaymentOrderStatus
  }
  if (['success', 'completed', 'complete'].includes(normalized)) return 'paid'
  if (['canceled', 'closed'].includes(normalized)) return 'cancelled'
  return 'unknown'
}

function normalizePaymentOrder(value: unknown): RelayOnePaymentOrder {
  const source = asRecord(value)
  return {
    id: firstString(source, ['id', 'order_id', 'orderId', 'trade_no']),
    amount: optionalNumber(source, ['amount', 'total_amount', 'price']) || 0,
    currency: firstString(source, ['currency', 'currency_code'], 'CNY'),
    status: normalizeOrderStatus(firstString(source, ['status', 'order_status', 'payment_status'])),
    paymentUrl: firstString(source, ['payment_url', 'paymentUrl', 'checkout_url', 'checkoutUrl', 'pay_url']) || undefined,
    createdAt: firstString(source, ['created_at', 'createdAt']) || undefined,
    paidAt: firstString(source, ['paid_at', 'paidAt']) || undefined
  }
}

export class RelayOneService {
  private tempToken: string | null = null
  private refreshPromise: Promise<boolean> | null = null
  private ensureKeysPromise: Promise<RelayOneEnsureKeysResult> | null = null

  constructor(
    private readonly getConfigService: () => ConfigService | null,
    private readonly sessionStore = new RelayOneSessionStore()
  ) {}

  getStatus(): RelayOneStatus {
    const session = this.sessionStore.get()
    return {
      authenticated: Boolean(session?.accessToken),
      hasRefreshToken: Boolean(session?.refreshToken),
      encryptionAvailable: this.sessionStore.isEncryptionAvailable(),
      sessionPersistent: this.sessionStore.isPersistent(),
      user: session?.user
    }
  }

  async getPublicSettings(): Promise<RelayOnePublicSettings> {
    const source = asRecord(await this.request('/settings/public'))
    return {
      siteName: firstString(source, ['site_name', 'siteName', 'name'], 'RelayOne'),
      registrationEnabled: firstBoolean(source, ['registration_enabled', 'registrationEnabled', 'enable_registration'], true),
      emailVerificationEnabled: firstBoolean(source, ['email_verify_enabled', 'email_verification_enabled', 'emailVerificationEnabled', 'enable_email_verification'], false),
      promoCodeEnabled: firstBoolean(source, ['promo_code_enabled', 'promoCodeEnabled', 'enable_promo_code'], false),
      invitationCodeEnabled: firstBoolean(source, ['invitation_code_enabled', 'invitationCodeEnabled', 'enable_invitation_code'], false),
      totpEnabled: firstBoolean(source, ['totp_enabled', 'totpEnabled', 'enable_totp'], false),
      loginAgreementEnabled: firstBoolean(source, ['login_agreement_enabled', 'loginAgreementEnabled', 'enable_login_agreement'], false),
      agreementUrl: firstString(source, ['agreement_url', 'agreementUrl', 'terms_url']) || undefined,
      privacyUrl: firstString(source, ['privacy_url', 'privacyUrl']) || undefined,
      currency: firstString(source, ['currency', 'currency_code']) || undefined,
      minimumRechargeAmount: optionalNumber(source, ['minimum_recharge_amount', 'min_recharge_amount', 'minimumAmount'])
    }
  }

  async sendVerificationCode(email: string): Promise<void> {
    const normalizedEmail = email.trim()
    if (!normalizedEmail) throw new Error('请输入邮箱地址')
    await this.request('/auth/send-verify-code', { method: 'POST', body: { email: normalizedEmail } })
  }

  async register(input: RelayOneRegisterInput): Promise<void> {
    if (!input.email.trim() || !input.password) throw new Error('请输入邮箱和密码')
    const body: JsonRecord = { email: input.email.trim(), password: input.password }
    if (input.verificationCode?.trim()) body.verify_code = input.verificationCode.trim()
    if (input.promoCode?.trim()) body.promo_code = input.promoCode.trim()
    if (input.invitationCode?.trim()) body.invitation_code = input.invitationCode.trim()
    await this.request('/auth/register', { method: 'POST', body })
  }

  async login(input: RelayOneLoginInput): Promise<RelayOneLoginResult> {
    if (!input.email.trim() || !input.password) throw new Error('请输入邮箱和密码')
    this.tempToken = null
    const payload = asRecord(await this.request('/auth/login', {
      method: 'POST',
      body: { email: input.email.trim(), password: input.password }
    }))

    if (firstBoolean(payload, ['requires_2fa', 'requires2fa', 'requiresTwoFactor'], false)) {
      const tempToken = firstString(payload, ['temp_token', 'tempToken'])
      if (!tempToken) throw new Error('RelayOne 要求两步验证，但未返回临时令牌')
      this.tempToken = tempToken
      return { requiresTwoFactor: true }
    }

    this.saveAuthenticatedSession(payload)
    return { requiresTwoFactor: false, status: this.getStatus() }
  }

  async verifyTwoFactor(code: string): Promise<RelayOneLoginResult> {
    if (!this.tempToken) throw new Error('两步验证会话已失效，请重新登录')
    const normalizedCode = code.trim()
    if (!normalizedCode) throw new Error('请输入两步验证码')
    const payload = asRecord(await this.request('/auth/login/2fa', {
      method: 'POST',
      body: { temp_token: this.tempToken, totp_code: normalizedCode }
    }))
    this.tempToken = null
    this.saveAuthenticatedSession(payload)
    return { requiresTwoFactor: false, status: this.getStatus() }
  }

  async logout(): Promise<void> {
    const refreshToken = this.sessionStore.get()?.refreshToken
    try {
      if (refreshToken) {
        await this.request('/auth/logout', { method: 'POST', body: { refresh_token: refreshToken } })
      }
    } finally {
      this.tempToken = null
      this.sessionStore.clear()
    }
  }

  async getCurrentUser(): Promise<RelayOneUser> {
    const payload = asRecord(await this.request('/auth/me', { authenticated: true }))
    const user = normalizeUser(nestedRecord(payload, ['user', 'profile', 'data']))
    const session = this.requireSession()
    this.sessionStore.save({ ...session, user })
    return user
  }

  private async listApiKeysRaw(): Promise<Array<{ key: RelayOneApiKey; rawKey: string }>> {
    const payload = await this.request('/keys', { authenticated: true })
    return getItems(payload, ['items', 'list', 'keys', 'data']).map((value) => {
      const { rawKey, entity } = extractApiKey(value)
      return { key: normalizeApiKey(entity), rawKey }
    })
  }

  private async createApiKeyRaw(input: RelayOneCreateKeyInput): Promise<{ key: RelayOneApiKey; rawKey: string }> {
    const name = input.name.trim()
    if (!name) throw new Error('请输入 Key 名称')
    const body: JsonRecord = { name }
    const groupId = numericGroupId(input.groupId)
    if (groupId !== undefined) body.group_id = groupId
    const payload = await this.request('/keys', { method: 'POST', body, authenticated: true })
    const { rawKey, entity } = extractApiKey(payload)
    if (!rawKey) throw new Error('RelayOne 已创建 Key，但响应中未包含可应用的密钥')
    return { key: normalizeApiKey(entity), rawKey }
  }

  private async deleteApiKey(keyId: string): Promise<void> {
    const normalizedKeyId = keyId.trim()
    if (!normalizedKeyId) throw new Error('缺少 Key ID')
    await this.request(`/keys/${encodeURIComponent(normalizedKeyId)}`, { method: 'DELETE', authenticated: true })
  }

  private async listAvailableGroups(): Promise<RelayOneGroup[]> {
    const payload = await this.request('/groups/available', { authenticated: true })
    return getItems(payload, ['items', 'list', 'groups', 'data']).map(normalizeGroup)
  }

  /** 用某把托管 Key 拉推理端 /models，返回该分组可用的模型 ID 列表 */
  async listInferenceModels(apiKey: string): Promise<string[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await net.fetch(`${RELAYONE_INFERENCE_BASE_URL}/models`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = asRecord(await response.json())
      const items = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
      // 服务端 /models 返回的顺序与站点展示相反，翻转一次
      return Array.from(new Set(items
        .map((item) => firstString(asRecord(item), ['id', 'name']).replace(/^models\//, ''))
        .filter(Boolean))).reverse()
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * 登录后自动创建/校准四个固定分组的托管密钥，并写入大模型与作图配置。
   * 幂等：配置里四把 Key 都在且非强制时直接返回，不发请求。
   * activate=true（登录时）才把当前服务商切到 relayone；后台校准只更新配置，不抢用户选的服务商。
   */
  async ensureManagedKeys(force = false, activate = false): Promise<RelayOneEnsureKeysResult> {
    if (this.ensureKeysPromise) return this.ensureKeysPromise
    this.ensureKeysPromise = this.doEnsureManagedKeys(force, activate).finally(() => {
      this.ensureKeysPromise = null
    })
    return this.ensureKeysPromise
  }

  private async doEnsureManagedKeys(force: boolean, activate: boolean): Promise<RelayOneEnsureKeysResult> {
    this.requireSession()
    const configService = this.getConfigService()
    if (!configService) throw new Error('CipherTalk 配置服务尚未就绪')

    const storedState = getRelayOneManagedState(configService)
    if (!force && storedState && RELAYONE_MANAGED_GROUPS.every((target) =>
      storedState.keys.some((entry) => entry.kind === target.kind && entry.apiKey)
    )) {
      return {
        ready: getRelayOneChatKeys(storedState).length > 0,
        updated: false,
        created: [],
        missingGroups: [],
        imageConfigured: Boolean(getRelayOneImageKey(storedState)),
        chatModelCount: listRelayOneAggregatedModels(storedState).length
      }
    }

    const wxid = String(configService.get('myWxid') || '').trim()
    const [groups, serverKeys] = await Promise.all([
      this.listAvailableGroups(),
      this.listApiKeysRaw()
    ])

    const created: string[] = []
    const missingGroups: string[] = []
    const nextKeys: RelayOneManagedKeyEntry[] = []

    for (const target of RELAYONE_MANAGED_GROUPS) {
      const stored = storedState?.keys.find((entry) => entry.kind === target.kind && entry.apiKey)
      // 优先按 ID 匹配（写死的 > 本地记住的），分组改名不受影响；名字全等只作兜底
      const group = (target.groupId ? groups.find((item) => item.id === target.groupId) : undefined)
        || (stored?.groupId ? groups.find((item) => item.id === stored.groupId) : undefined)
        || groups.find((item) => item.name.trim() === target.groupName)
      if (!group) {
        missingGroups.push(target.groupName)
        // 分组临时下架时保留已有密钥，不丢配置
        if (stored) nextKeys.push(stored)
        continue
      }

      const expectedName = relayOneManagedKeyName(target.groupName, wxid)
      if (stored && serverKeys.some((item) => item.key.id === stored.keyId)) {
        nextKeys.push({ ...stored, groupId: group.id, groupName: group.name })
        continue
      }

      const existing = serverKeys.find((item) => item.key.name === expectedName)
      if (existing && isUsableApiKey(existing.rawKey)) {
        nextKeys.push({
          kind: target.kind,
          keyId: existing.key.id,
          name: expectedName,
          apiKey: existing.rawKey,
          groupId: group.id,
          groupName: group.name,
          models: []
        })
        continue
      }
      // 同名 Key 拿不到完整密钥（服务端只回掩码）就删掉重建，避免每次登录堆积重名 Key
      if (existing?.key.id) {
        await this.deleteApiKey(existing.key.id).catch(() => undefined)
      }
      const createdKey = await this.createApiKeyRaw({ name: expectedName, groupId: group.id })
      nextKeys.push({
        kind: target.kind,
        keyId: createdKey.key.id,
        name: expectedName,
        apiKey: createdKey.rawKey,
        groupId: group.id,
        groupName: group.name,
        models: []
      })
      created.push(target.groupName)
    }

    // 各分组用自己的 Key 拉一次模型列表：既是下拉聚合的数据，也是按模型路由的依据
    await Promise.all(nextKeys.map(async (entry) => {
      const previous = storedState?.keys.find((item) => item.kind === entry.kind)?.models || []
      entry.models = await this.listInferenceModels(entry.apiKey)
        .then((models) => filterManagedGroupModels(entry.kind, models))
        .catch(() => (entry.models.length > 0 ? entry.models : previous))
    }))

    const nextState: RelayOneManagedKeysState = { wxid, updatedAt: Date.now(), keys: nextKeys }
    configService.set('relayOneManagedKeys', nextState)
    this.applyManagedState(configService, nextState, activate)

    return {
      ready: getRelayOneChatKeys(nextState).length > 0,
      updated: true,
      created,
      missingGroups,
      imageConfigured: Boolean(getRelayOneImageKey(nextState)),
      chatModelCount: listRelayOneAggregatedModels(nextState).length
    }
  }

  /** 把托管密钥落进大模型（relayone 服务商）与作图配置 */
  private applyManagedState(configService: ConfigService, state: RelayOneManagedKeysState, activate: boolean): void {
    const chatKeys = getRelayOneChatKeys(state)
    if (chatKeys.length > 0) {
      const aggregated = listRelayOneAggregatedModels(state)
      const defaultEntry = chatKeys.find((entry) => entry.kind === 'plus-pool') || chatKeys[0]
      const existing = configService.getAIProviderConfig('relayone')
      // 用户自己选过的模型不动；空的兜底 gpt-5.6-sol（不在列表里才退回聚合列表第一个）
      const defaultModel = aggregated.some((model) => model.toLowerCase() === RELAYONE_DEFAULT_MODEL.toLowerCase())
        ? RELAYONE_DEFAULT_MODEL
        : (aggregated[0] || RELAYONE_DEFAULT_MODEL)
      const nextConfig = {
        apiKey: defaultEntry.apiKey,
        model: existing?.model || defaultModel,
        baseURL: RELAYONE_INFERENCE_BASE_URL,
        protocol: relayOneProtocolForKind(defaultEntry.kind)
      }
      if (activate) {
        configService.setAIProviderConfigAndActivate('relayone', nextConfig)
      } else {
        configService.setAIProviderConfig('relayone', nextConfig)
      }
    }

    const imageKey = getRelayOneImageKey(state)
    if (imageKey) {
      const current = configService.get('imageGenConfig')
      const isRelayOneImageConfig = String(current?.baseURL || '').includes('aiapi.aiqji.cn')
      // 用户配了别家的作图服务就不碰；没配过或本来就是 RelayOne 的才写入
      if (!current?.apiKey || isRelayOneImageConfig) {
        configService.set('imageGenConfig', {
          ...current,
          enabled: true,
          protocol: 'openai-compatible',
          apiKey: imageKey.apiKey,
          baseURL: RELAYONE_INFERENCE_BASE_URL,
          model: (isRelayOneImageConfig && current.model) ? current.model : (imageKey.models[0] || current?.model || '')
        })
      }
    }
  }

  async getCheckoutInfo(): Promise<RelayOneCheckoutInfo> {
    const payload = asRecord(await this.request('/payment/checkout-info', { authenticated: true }))
    const methods = getItems(payload, ['payment_types', 'paymentTypes', 'payment_methods', 'paymentMethods', 'methods']).map((value): RelayOnePaymentMethod => {
      const source = asRecord(value)
      const directValue = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
      return {
        id: firstString(source, ['payment_type', 'paymentType', 'type', 'id', 'code', 'value', 'name'], directValue),
        name: firstString(source, ['name', 'label', 'title', 'payment_type', 'paymentType', 'type', 'id'], directValue),
        enabled: firstBoolean(source, ['enabled', 'is_enabled', 'active'], true)
      }
    })
    const amounts = getItems(payload, ['preset_amounts', 'presetAmounts', 'amounts'])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0)
    return {
      currency: firstString(payload, ['currency', 'currency_code'], 'CNY'),
      minimumAmount: optionalNumber(payload, ['minimum_amount', 'min_amount', 'minimumAmount']),
      maximumAmount: optionalNumber(payload, ['maximum_amount', 'max_amount', 'maximumAmount']),
      presetAmounts: amounts,
      paymentMethods: methods
    }
  }

  async createPaymentOrder(input: RelayOneCreatePaymentOrderInput): Promise<RelayOnePaymentOrder> {
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('充值金额必须大于 0')
    const paymentType = input.paymentType?.trim()
    if (!paymentType) throw new Error('请选择支付方式')
    const body: JsonRecord = { amount, payment_type: paymentType }
    return normalizePaymentOrder(await this.request('/payment/orders', { method: 'POST', body, authenticated: true }))
  }

  async getPaymentOrder(orderId: string): Promise<RelayOnePaymentOrder> {
    const normalizedOrderId = orderId.trim()
    if (!normalizedOrderId) throw new Error('缺少订单 ID')
    return normalizePaymentOrder(await this.request(`/payment/orders/${encodeURIComponent(normalizedOrderId)}`, { authenticated: true }))
  }

  async cancelPaymentOrder(orderId: string): Promise<RelayOnePaymentOrder> {
    const normalizedOrderId = orderId.trim()
    if (!normalizedOrderId) throw new Error('缺少订单 ID')
    await this.request(`/payment/orders/${encodeURIComponent(normalizedOrderId)}/cancel`, {
      method: 'POST',
      body: {},
      authenticated: true
    })
    return this.getPaymentOrder(normalizedOrderId)
  }

  private requireSession(): RelayOneSession {
    const session = this.sessionStore.get()
    if (!session?.accessToken) throw new Error('请先登录 RelayOne 账户')
    return session
  }

  private saveAuthenticatedSession(payload: JsonRecord): void {
    const accessToken = firstString(payload, ['access_token', 'accessToken'])
    if (!accessToken) throw new Error('RelayOne 登录响应中缺少 access_token')
    const expiresIn = optionalNumber(payload, ['expires_in', 'expiresIn'])
    const userValue = payload.user
    this.sessionStore.save({
      accessToken,
      refreshToken: firstString(payload, ['refresh_token', 'refreshToken']) || undefined,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      user: userValue ? normalizeUser(userValue) : undefined
    })
  }

  private async refreshSession(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise
    const refreshToken = this.sessionStore.get()?.refreshToken
    if (!refreshToken) {
      this.sessionStore.clear()
      return false
    }

    this.refreshPromise = (async () => {
      try {
        const payload = asRecord(await this.request('/auth/refresh', {
          method: 'POST',
          body: { refresh_token: refreshToken },
          retryUnauthorized: false
        }))
        const current = this.sessionStore.get()
        const accessToken = firstString(payload, ['access_token', 'accessToken'])
        if (!accessToken) throw new Error('刷新响应中缺少 access_token')
        const expiresIn = optionalNumber(payload, ['expires_in', 'expiresIn'])
        this.sessionStore.save({
          accessToken,
          refreshToken: firstString(payload, ['refresh_token', 'refreshToken']) || refreshToken,
          expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
          user: current?.user
        })
        return true
      } catch (error) {
        this.sessionStore.clear()
        console.warn('[RelayOne] Session refresh failed:', error instanceof Error ? error.message : String(error))
        return false
      }
    })().finally(() => {
      this.refreshPromise = null
    })

    return this.refreshPromise
  }

  private async request(pathname: string, options: RequestOptions = {}): Promise<unknown> {
    const authenticated = options.authenticated === true
    const session = authenticated ? this.requireSession() : null
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.body) headers['Content-Type'] = 'application/json'
    if (session) headers.Authorization = `Bearer ${session.accessToken}`

    let response: Response
    try {
      response = await net.fetch(`${RELAYONE_CONTROL_BASE_URL}${pathname}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
      })
    } catch (error) {
      throw new RelayOneApiError(`RelayOne 网络请求失败：${error instanceof Error ? error.message : String(error)}`)
    }

    if (response.status === 401 && authenticated && options.retryUnauthorized !== false) {
      if (await this.refreshSession()) {
        return this.request(pathname, { ...options, retryUnauthorized: false })
      }
      throw new RelayOneApiError('RelayOne 登录已过期，请重新登录', 401)
    }

    const text = await response.text()
    let payload: unknown = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }
    const envelope = asRecord(payload)
    const envelopeCode = envelope.code
    const message = localizeErrorMessage(firstString(envelope, ['message', 'msg', 'error']))

    if (!response.ok) {
      throw new RelayOneApiError(message || `RelayOne 请求失败（HTTP ${response.status}）`, response.status, typeof envelopeCode === 'string' || typeof envelopeCode === 'number' ? envelopeCode : undefined)
    }
    if ((typeof envelopeCode === 'number' || typeof envelopeCode === 'string') && Number(envelopeCode) !== 0) {
      throw new RelayOneApiError(message || `RelayOne 请求失败（code=${String(envelopeCode)}）`, response.status, envelopeCode)
    }
    return Object.prototype.hasOwnProperty.call(envelope, 'data') ? envelope.data : payload
  }
}
