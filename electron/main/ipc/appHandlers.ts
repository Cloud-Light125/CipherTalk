import { app, ipcMain } from 'electron'
import { getMcpLaunchConfig as getMcpLaunchConfigForUi } from '../../services/mcp/runtime'
import { getRuntimePlatformInfo } from '../../services/platformService'
import type { MainProcessContext } from '../context'

export function registerAppHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('app:getDownloadsPath', async () => {
    return app.getPath('downloads')
  })

  ipcMain.handle('app:getVersion', async () => {
    return app.getVersion()
  })

  ipcMain.handle('app:getPlatformInfo', async () => {
    return getRuntimePlatformInfo()
  })

  ipcMain.handle('app:getMcpLaunchConfig', async () => {
    return getMcpLaunchConfigForUi()
  })

  ipcMain.on('app:getMcpLaunchConfig:request', (event, payload: { requestId?: string } | undefined) => {
    const requestId = payload?.requestId
    if (!requestId) return
    event.sender.send(`app:getMcpLaunchConfig:response:${requestId}`, getMcpLaunchConfigForUi())
  })

  ipcMain.handle('app:getStartupDbConnected', () => {
    const connected = ctx.getStartupDbConnected()
    ctx.setStartupDbConnected(false)
    return connected
  })
}
