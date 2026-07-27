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

export interface RelayOneCreateKeyResult {
  apiKey: RelayOneApiKey
  appliedToAI: boolean
}

export interface RelayOneGroup {
  id: string
  name: string
  description?: string
  enabled: boolean
  rateMultiplier: number
}

export interface RelayOneGroupRate {
  groupId: string
  groupName: string
  rate: number
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
