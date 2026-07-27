import { net } from 'electron'
import type { ConfigService } from '../config'
import type {
  RelayOneApiKey,
  RelayOneCheckoutInfo,
  RelayOneCreateKeyInput,
  RelayOneCreateKeyResult,
  RelayOneCreatePaymentOrderInput,
  RelayOneGroup,
  RelayOneGroupRate,
  RelayOneLoginInput,
  RelayOneLoginResult,
  RelayOnePaymentMethod,
  RelayOnePaymentOrder,
  RelayOnePaymentOrderStatus,
  RelayOnePublicSettings,
  RelayOneRegisterInput,
  RelayOneStatus,
  RelayOneUser
} from '../../../src/types/relayOne'
import { RelayOneSessionStore, type RelayOneSession } from './relayOneSessionStore'

export const RELAYONE_CONTROL_BASE_URL = 'https://aiapi.aiqji.cn/api/v1'
export const RELAYONE_INFERENCE_BASE_URL = 'https://aiapi.aiqji.cn/v1'

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
  private readonly apiKeySecrets = new Map<string, string>()

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
      this.apiKeySecrets.clear()
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

  async listApiKeys(): Promise<RelayOneApiKey[]> {
    const payload = await this.request('/keys', { authenticated: true })
    const currentApiKey = this.getConfigService()?.getAIProviderConfig('relayone')?.apiKey || ''
    this.apiKeySecrets.clear()
    return getItems(payload, ['items', 'list', 'keys', 'data']).map((value) => {
      const { rawKey, entity } = extractApiKey(value)
      const normalized = normalizeApiKey(entity)
      if (normalized.id && isUsableApiKey(rawKey)) this.apiKeySecrets.set(normalized.id, rawKey)
      return { ...normalized, isApplied: Boolean(currentApiKey && rawKey === currentApiKey) }
    })
  }

  async createApiKey(input: RelayOneCreateKeyInput): Promise<RelayOneCreateKeyResult> {
    const name = input.name.trim()
    if (!name) throw new Error('请输入 Key 名称')
    const body: JsonRecord = { name }
    const groupId = numericGroupId(input.groupId)
    if (groupId !== undefined) body.group_id = groupId
    const payload = await this.request('/keys', { method: 'POST', body, authenticated: true })
    const { rawKey, entity } = extractApiKey(payload)
    if (!rawKey) throw new Error('RelayOne 已创建 Key，但响应中未包含可应用的密钥')

    this.applyApiKeyToAI(rawKey)
    const normalized = normalizeApiKey(entity)
    if (normalized.id) this.apiKeySecrets.set(normalized.id, rawKey)
    return {
      apiKey: { ...normalized, keyPreview: normalized.keyPreview || maskSecret(rawKey), isApplied: true },
      appliedToAI: true
    }
  }

  async applyApiKey(keyId: string): Promise<void> {
    const normalizedKeyId = keyId.trim()
    if (!normalizedKeyId) throw new Error('缺少 Key ID')
    let apiKey = this.apiKeySecrets.get(normalizedKeyId)
    if (!apiKey) {
      await this.listApiKeys()
      apiKey = this.apiKeySecrets.get(normalizedKeyId)
    }
    if (!apiKey) {
      throw new Error('RelayOne 未返回该 Key 的完整密钥，无法直接应用；请新建一个 Key')
    }
    this.applyApiKeyToAI(apiKey)
  }

  async updateApiKeyGroup(keyId: string, groupId: string): Promise<RelayOneApiKey> {
    const normalizedKeyId = keyId.trim()
    if (!normalizedKeyId) throw new Error('缺少 Key ID')
    const payload = await this.request(`/keys/${encodeURIComponent(normalizedKeyId)}`, {
      method: 'PUT',
      body: { group_id: numericGroupId(groupId, 0) },
      authenticated: true
    })
    return normalizeApiKey(payload)
  }

  async deleteApiKey(keyId: string): Promise<void> {
    const normalizedKeyId = keyId.trim()
    if (!normalizedKeyId) throw new Error('缺少 Key ID')
    await this.request(`/keys/${encodeURIComponent(normalizedKeyId)}`, { method: 'DELETE', authenticated: true })
    this.apiKeySecrets.delete(normalizedKeyId)
  }

  async listAvailableGroups(): Promise<RelayOneGroup[]> {
    const payload = await this.request('/groups/available', { authenticated: true })
    return getItems(payload, ['items', 'list', 'groups', 'data']).map(normalizeGroup)
  }

  async listGroupRates(): Promise<RelayOneGroupRate[]> {
    const payload = await this.request('/groups/rates', { authenticated: true })
    const source = asRecord(payload)
    const nestedItems = getItems(payload, ['items', 'list', 'rates', 'groups', 'data'])
    const items = nestedItems.length > 0
      ? nestedItems
      : Object.entries(source).map(([id, value]) => ({ id, value }))
    return items.flatMap((value): RelayOneGroupRate[] => {
      const source = asRecord(value)
      const rate = optionalNumber(source, ['rate', 'ratio', 'multiplier', 'value'])
      if (rate === undefined) return []
      return [{
        groupId: firstString(source, ['group_id', 'groupId', 'id', 'name']),
        groupName: firstString(source, ['group_name', 'groupName', 'name', 'id']),
        rate
      }]
    })
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

  private applyApiKeyToAI(apiKey: string): void {
    const configService = this.getConfigService()
    if (!configService) throw new Error('CipherTalk 配置服务尚未就绪')
    const existing = configService.getAIProviderConfig('relayone')
    configService.setAIProviderConfigAndActivate('relayone', {
      apiKey,
      model: existing?.model || '',
      baseURL: RELAYONE_INFERENCE_BASE_URL,
      protocol: 'openai-responses'
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
