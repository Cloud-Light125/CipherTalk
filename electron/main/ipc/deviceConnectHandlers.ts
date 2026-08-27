import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { weixinBotService } from '../../services/deviceConnect/weixinBotService'
import {
  getRemoteControlInfo,
  hasPairingPassword,
  setPairingPassword,
  unlockPairing,
  listRemoteDevices,
  revokeRemoteDevice,
  rotatePairingId,
  setPairingOpen,
  startRemoteControl,
  stopRemoteControl,
} from '../../services/remote/remoteControl'

/**
 * 设备连接 IPC —— 微信（iLink 直连）+ 手机遥控（P2P）。
 * 连接逻辑本体在 weixinBotService / remoteControl；状态/二维码经 broadcastToWindows 推回渲染端。
 */
export function registerDeviceConnectHandlers(ctx: MainProcessContext): void {
  weixinBotService.init(ctx)

  // ========= 手机遥控（P2P） =========
  ipcMain.handle('deviceConnect:remote:getInfo', () => getRemoteControlInfo(ctx))

  ipcMain.handle('deviceConnect:remote:setEnabled', async (_event, enabled: boolean) => {
    const configService = ctx.getConfigService()
    if (!configService) return { success: false, error: '配置服务未就绪' }
    configService.set('remoteGatewayEnabled', enabled === true)
    if (!enabled) {
      await stopRemoteControl()
      return { success: true, info: await getRemoteControlInfo(ctx) }
    }
    const result = await startRemoteControl(ctx)
    if (!result.success) {
      configService.set('remoteGatewayEnabled', false)
      return result
    }
    return { success: true, info: await getRemoteControlInfo(ctx) }
  })

  ipcMain.handle('deviceConnect:remote:rotatePairing', async () => {
    return { success: true, info: await rotatePairingId(ctx) }
  })

  ipcMain.handle('deviceConnect:remote:listDevices', () => ({ success: true, devices: listRemoteDevices(ctx) }))

  ipcMain.handle('deviceConnect:remote:revokeDevice', (_event, deviceId: string) => ({
    success: true,
    devices: revokeRemoteDevice(ctx, String(deviceId || '')),
  }))

  // 配对窗口：二维码弹窗打开期间才允许新手机配对，否则被吊销的手机能立刻重新配一个
  ipcMain.handle('deviceConnect:remote:setPairingOpen', (_event, open: boolean) => {
    setPairingOpen(open === true)
    return { success: true }
  })

  ipcMain.handle('deviceConnect:remote:hasPassword', () => ({ success: true, hasPassword: hasPairingPassword(ctx) }))

  ipcMain.handle('deviceConnect:remote:setPassword', async (_event, payload: { password: string; currentPassword?: string }) => {
    const result = setPairingPassword(ctx, String(payload?.password || ''), payload?.currentPassword)
    if (!result.success) return result
    return { success: true, info: await getRemoteControlInfo(ctx) }
  })

  ipcMain.handle('deviceConnect:remote:unlock', async (_event, password: string) => {
    if (!unlockPairing(ctx, String(password || ''))) return { success: false, error: '密码不正确' }
    return { success: true, info: await getRemoteControlInfo(ctx) }
  })

  // 推送只有一条通道（信令 Worker 中转，端到端加密），没有任何要配置的东西，
  // 所以这里只剩「发送测试通知」
  ipcMain.handle('deviceConnect:remote:testPush', async () => {
    const { pushToRemoteDevices, hasPushTargets } = await import('../../services/remote/pushHandlers')
    if (!hasPushTargets()) return { success: false, error: '还没有可用的推送通道：在手机的「设置 → 通知」里打开开关（或配置 Bark 地址）' }
    await pushToRemoteDevices({ title: '密语', body: '推送已连通，这是一条测试通知。', group: '测试' })
    return { success: true }
  })

  ipcMain.handle('deviceConnect:wechat:getStatus', () => weixinBotService.getStatus())

  ipcMain.handle('deviceConnect:wechat:connect', () => weixinBotService.startConnect())

  ipcMain.handle('deviceConnect:wechat:cancel', () => {
    weixinBotService.cancelConnect()
    return { success: true }
  })

  ipcMain.handle('deviceConnect:wechat:disconnect', async () => {
    await weixinBotService.disconnect()
    return { success: true }
  })
}
