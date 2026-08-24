import { ipcMain, type BrowserWindow } from 'electron'
import type { MainProcessContext } from '../context'
import type {
  RelayOneCreatePaymentOrderInput,
  RelayOneIpcResult,
  RelayOneLoginInput,
  RelayOneRegisterInput
} from '../../../src/types/relayOne'
import { RelayOneService } from '../../services/relayone/relayOneService'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function invoke<T>(operation: () => T | Promise<T>): Promise<RelayOneIpcResult<T>> {
  try {
    return { success: true, data: await operation() }
  } catch (error) {
    console.error('[RelayOne] IPC operation failed:', errorMessage(error))
    return { success: false, error: errorMessage(error) }
  }
}

export function registerRelayOneHandlers(ctx: MainProcessContext): void {
  const service = new RelayOneService(() => ctx.getConfigService())
  const broadcastStatus = () => ctx.broadcastToWindows('relayOne:statusChanged', service.getStatus())
  // 登录成功后自动创建四个固定分组的托管密钥并写入大模型/作图配置；失败不阻断登录
  const provisionManagedKeys = async () => {
    try {
      const result = await service.ensureManagedKeys(false, true)
      if (result.updated) ctx.broadcastToWindows('relayOne:providerApplied')
    } catch (error) {
      console.warn('[RelayOne] 自动配置托管密钥失败:', errorMessage(error))
    }
  }

  ipcMain.handle('relayOne:getStatus', async () => invoke(() => service.getStatus()))
  ipcMain.handle('relayOne:getPublicSettings', async () => invoke(() => service.getPublicSettings()))
  ipcMain.handle('relayOne:sendVerificationCode', async (_event, email: string) => invoke(() => service.sendVerificationCode(String(email || ''))))
  ipcMain.handle('relayOne:register', async (_event, input: RelayOneRegisterInput) => invoke(() => service.register(input)))
  ipcMain.handle('relayOne:login', async (_event, input: RelayOneLoginInput) => {
    const result = await invoke(() => service.login(input))
    if (result.success && !result.data.requiresTwoFactor) {
      broadcastStatus()
      await provisionManagedKeys()
    }
    return result
  })
  ipcMain.handle('relayOne:verifyTwoFactor', async (_event, code: string) => {
    const result = await invoke(() => service.verifyTwoFactor(String(code || '')))
    if (result.success) {
      broadcastStatus()
      await provisionManagedKeys()
    }
    return result
  })
  ipcMain.handle('relayOne:logout', async () => {
    const result = await invoke(() => service.logout())
    broadcastStatus()
    return result
  })
  ipcMain.handle('relayOne:getCurrentUser', async () => {
    const result = await invoke(() => service.getCurrentUser())
    broadcastStatus()
    return result
  })
  ipcMain.handle('relayOne:ensureManagedKeys', async (_event, force?: boolean) => {
    const result = await invoke(() => service.ensureManagedKeys(Boolean(force)))
    if (result.success && result.data.updated) ctx.broadcastToWindows('relayOne:providerApplied')
    return result
  })
  ipcMain.handle('relayOne:getCheckoutInfo', async () => invoke(() => service.getCheckoutInfo()))
  ipcMain.handle('relayOne:createPaymentOrder', async (_event, input: RelayOneCreatePaymentOrderInput) => invoke(() => service.createPaymentOrder(input)))
  ipcMain.handle('relayOne:getPaymentOrder', async (_event, orderId: string) => invoke(() => service.getPaymentOrder(String(orderId || ''))))
  ipcMain.handle('relayOne:cancelPaymentOrder', async (_event, orderId: string) => invoke(() => service.cancelPaymentOrder(String(orderId || ''))))

  // 支付页在应用内窗口打开，订单支付成功后由渲染端调用 closePaymentWindow 关闭
  let paymentWindow: BrowserWindow | null = null
  const closePaymentWindow = () => {
    if (paymentWindow && !paymentWindow.isDestroyed()) paymentWindow.close()
    paymentWindow = null
  }

  ipcMain.handle('relayOne:openPaymentWindow', async (_event, url: string) => invoke(() => {
    const target = String(url || '').trim()
    if (!/^https?:\/\//i.test(target)) throw new Error('支付链接无效')
    closePaymentWindow()
    paymentWindow = ctx.getWindowManager().openBrowserWindow(target, 'RelayOne 充值')
    paymentWindow.on('closed', () => { paymentWindow = null })
  }))

  ipcMain.handle('relayOne:closePaymentWindow', async () => invoke(() => closePaymentWindow()))
}
