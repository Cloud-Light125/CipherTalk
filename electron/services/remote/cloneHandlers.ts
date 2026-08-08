/**
 * 远程克隆控制通道：只注册进 agentRpcHandlers（手机遥控专用），不进 ipcMain。
 * 严格白名单——绝不暴露通用 config 读写，否则配对手机能读到 API key 等全部配置。
 */
import type { ConfigService } from '../config'
import { agentRpcHandlers } from './agentRpcRegistry'

export function registerRemoteCloneHandlers(configService: ConfigService): void {
  agentRpcHandlers.set('clone:getConfig', () => {
    try {
      return {
        success: true,
        replyTileEnabled: configService.get('replyTileEnabled') === true,
        sessions: configService.get('replySuggestSessions') ?? {},
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  agentRpcHandlers.set('clone:setTileEnabled', (_event, enabled: unknown) => {
    try {
      configService.set('replyTileEnabled', enabled === true)
      return { success: true, replyTileEnabled: enabled === true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
