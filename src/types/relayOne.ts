/** RelayOne 的默认展示模型：用户没选过模型时兜底显示它，主进程与渲染端共用 */
export const RELAYONE_DEFAULT_MODEL = 'gpt-5.6-sol'

export interface RelayOnePublicSettings {
  siteName: string
  registrationEnabled: boolean
  emailVerificationEnabled: boolean
  promoCodeEnabled: boolean
  invitationCodeEnabled: boolean
  totpEnabled: boolean
  loginAgreementEnabled: boolean
  agreementUrl?: string
  privacyUrl?: string
  currency?: string
  minimumRechargeAmount?: number
}

export interface RelayOneUser {
  id: string
  email: string
  name: string
  avatarUrl?: string
  balance?: number
  quota?: number
  usedQuota?: number
  groupId?: string
  groupName?: string
  createdAt?: string
}

export interface RelayOneStatus {
  authenticated: boolean
  hasRefreshToken: boolean
  encryptionAvailable: boolean
  sessionPersistent: boolean
  user?: RelayOneUser
}

export interface RelayOneLoginInput {
  email: string
  password: string
}

export interface RelayOneLoginResult {
  requiresTwoFactor: boolean
  status?: RelayOneStatus
}

export interface RelayOneRegisterInput {
  email: string
  password: string
  verificationCode?: string
  promoCode?: string
  invitationCode?: string
}

export interface RelayOneApiKey {
  id: string
  name: string
  keyPreview: string
  groupId?: string
  groupName?: string
  enabled: boolean
  isApplied: boolean
  createdAt?: string
  expiresAt?: string
  lastUsedAt?: string
}

export interface RelayOneCreateKeyInput {
  name: string
  groupId?: string
}

export interface RelayOneGroup {
  id: string
  name: string
  description?: string
  enabled: boolean
  rateMultiplier: number
}

/** 登录后自动创建四个固定分组密钥的执行结果 */
export interface RelayOneEnsureKeysResult {
  /** 三个聊天分组至少配好一把 Key */
  ready: boolean
  /** 本次是否写入过配置（新建/采用了 Key、刷新了模型映射） */
  updated: boolean
  /** 本次新建密钥的分组名 */
  created: string[]
  /** 站点上没找到的分组名 */
  missingGroups: string[]
  /** 生图 Key 是否已写入作图配置 */
  imageConfigured: boolean
  /** 聚合后的聊天模型数量 */
  chatModelCount: number
}

export interface RelayOnePaymentMethod {
  id: string
  name: string
  enabled: boolean
}

export interface RelayOneCheckoutInfo {
  currency: string
  minimumAmount?: number
  maximumAmount?: number
  presetAmounts: number[]
  paymentMethods: RelayOnePaymentMethod[]
}

export type RelayOnePaymentOrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'unknown'

export interface RelayOnePaymentOrder {
  id: string
  amount: number
  currency: string
  status: RelayOnePaymentOrderStatus
  paymentUrl?: string
  createdAt?: string
  paidAt?: string
}

export interface RelayOneCreatePaymentOrderInput {
  amount: number
  paymentType: string
}

export type RelayOneIpcResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string }
