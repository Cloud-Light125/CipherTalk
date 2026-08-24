import type {
  RelayOneCheckoutInfo,
  RelayOneCreatePaymentOrderInput,
  RelayOneEnsureKeysResult,
  RelayOneIpcResult,
  RelayOneLoginInput,
  RelayOneLoginResult,
  RelayOnePaymentOrder,
  RelayOnePublicSettings,
  RelayOneRegisterInput,
  RelayOneStatus,
  RelayOneUser
} from '../types/relayOne'

async function unwrap<T>(request: Promise<RelayOneIpcResult<T>>): Promise<T> {
  const result = await request
  if (!result.success) throw new Error(result.error)
  return result.data
}

export const relayOneService = {
  getStatus: (): Promise<RelayOneStatus> => unwrap(window.electronAPI.relayOne.getStatus()),
  getPublicSettings: (): Promise<RelayOnePublicSettings> => unwrap(window.electronAPI.relayOne.getPublicSettings()),
  sendVerificationCode: (email: string): Promise<void> => unwrap(window.electronAPI.relayOne.sendVerificationCode(email)),
  register: (input: RelayOneRegisterInput): Promise<void> => unwrap(window.electronAPI.relayOne.register(input)),
  login: (input: RelayOneLoginInput): Promise<RelayOneLoginResult> => unwrap(window.electronAPI.relayOne.login(input)),
  verifyTwoFactor: (code: string): Promise<RelayOneLoginResult> => unwrap(window.electronAPI.relayOne.verifyTwoFactor(code)),
  logout: (): Promise<void> => unwrap(window.electronAPI.relayOne.logout()),
  getCurrentUser: (): Promise<RelayOneUser> => unwrap(window.electronAPI.relayOne.getCurrentUser()),
  ensureManagedKeys: (force?: boolean): Promise<RelayOneEnsureKeysResult> => unwrap(window.electronAPI.relayOne.ensureManagedKeys(force)),
  getCheckoutInfo: (): Promise<RelayOneCheckoutInfo> => unwrap(window.electronAPI.relayOne.getCheckoutInfo()),
  createPaymentOrder: (input: RelayOneCreatePaymentOrderInput): Promise<RelayOnePaymentOrder> => unwrap(window.electronAPI.relayOne.createPaymentOrder(input)),
  getPaymentOrder: (orderId: string): Promise<RelayOnePaymentOrder> => unwrap(window.electronAPI.relayOne.getPaymentOrder(orderId)),
  cancelPaymentOrder: (orderId: string): Promise<RelayOnePaymentOrder> => unwrap(window.electronAPI.relayOne.cancelPaymentOrder(orderId)),
  openPaymentWindow: (url: string): Promise<void> => unwrap(window.electronAPI.relayOne.openPaymentWindow(url)),
  closePaymentWindow: (): Promise<void> => unwrap(window.electronAPI.relayOne.closePaymentWindow()),
  onStatusChanged: (callback: (status: RelayOneStatus) => void): (() => void) => window.electronAPI.relayOne.onStatusChanged(callback),
  onProviderApplied: (callback: () => void): (() => void) => window.electronAPI.relayOne.onProviderApplied(callback)
}
