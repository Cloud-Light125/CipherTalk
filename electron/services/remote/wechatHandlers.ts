import type { ConfigService } from '../config'
import { chatService } from '../chatService'
import { weixinBotService } from '../deviceConnect/weixinBotService'
import { agentRpcHandlers } from './agentRpcRegistry'

export function registerRemoteWechatHandlers(configService: ConfigService): void {
  agentRpcHandlers.set('wechat:getStatus', () => ({
    success: true,
    ...weixinBotService.getStatus(),
  }))

  agentRpcHandlers.set('wechat:getAccountInfo', async () => {
    try {
      const status = weixinBotService.getStatus()
      const activeAccount = configService.getActiveAccount()
      const result = await chatService.getMyUserInfo()
      const userInfo = result.success ? result.userInfo : undefined
      const displayName = userInfo?.nickName?.trim()
        || activeAccount?.displayName?.trim()
        || userInfo?.alias?.trim()
        || activeAccount?.wechatNumber?.trim()
        || activeAccount?.wxid?.trim()
        || status.userId
        || ''

      return {
        success: true,
        status: status.status,
        profile: displayName
          ? {
              displayName,
              avatarUrl: userInfo?.avatarUrl || '',
              wxid: userInfo?.wxid || activeAccount?.wxid || status.userId || '',
            }
          : null,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
