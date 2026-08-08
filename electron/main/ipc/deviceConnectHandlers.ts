import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { weixinBotService } from '../../services/deviceConnect/weixinBotService'
import {
  getRemoteControlInfo,
  rotatePairingId,
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
