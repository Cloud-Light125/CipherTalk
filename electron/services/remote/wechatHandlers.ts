import sharp from 'sharp'
import type { ConfigService } from '../config'
import { chatService } from '../chatService'
import { weixinBotService } from '../deviceConnect/weixinBotService'
import { agentRpcHandlers } from './agentRpcRegistry'

type AvatarImages = {
  color: string
  gray: string
}

let cachedAvatarUrl = ''
let cachedAvatarImages: AvatarImages | null = null

async function loadAvatar(avatarUrl: string): Promise<Buffer | null> {
  try {
    if (avatarUrl.startsWith('data:')) {
      return Buffer.from(avatarUrl.slice(avatarUrl.indexOf(',') + 1), 'base64')
    }
    if (/^https?:\/\//.test(avatarUrl)) {
      const response = await fetch(avatarUrl)
      return response.ok ? Buffer.from(await response.arrayBuffer()) : null
    }
    return null
  } catch {
    return null
  }
}

async function prepareAvatarImages(avatarUrl: string): Promise<AvatarImages | null> {
  if (!avatarUrl) return null
  if (avatarUrl === cachedAvatarUrl) return cachedAvatarImages

  const source = await loadAvatar(avatarUrl)
  if (!source) return null

  try {
    const size = 72
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`
    )
    const color = await sharp(source)
      .resize(size, size, { fit: 'cover' })
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer()
    const gray = await sharp(color).grayscale().png().toBuffer()

    cachedAvatarUrl = avatarUrl
    cachedAvatarImages = {
      color: `data:image/png;base64,${color.toString('base64')}`,
      gray: `data:image/png;base64,${gray.toString('base64')}`,
    }
    return cachedAvatarImages
  } catch {
    return null
  }
}

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
      const avatarImages = await prepareAvatarImages(userInfo?.avatarUrl || '')
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
              avatarUrl: avatarImages?.color || '',
              avatarGrayUrl: avatarImages?.gray || '',
              wxid: userInfo?.wxid || activeAccount?.wxid || status.userId || '',
            }
          : null,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
