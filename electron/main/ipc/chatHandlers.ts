import { isAbsolute, join, relative } from 'node:path'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { ipcMain } from 'electron'
import { chatService } from '../../services/chatService'
import { pickRandomPrivateIncomingMoment } from '../../services/randomMomentService'
import { agentRpcHandlers } from '../../services/remote/agentRpcRegistry'
import type { MainProcessContext } from '../context'

/** 按文件头识别表情图片类型（表情包多为 gif/png/webp）。 */
function sniffImageMediaType(buffer: Buffer): string {
  if (buffer.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return 'image/png'
}

const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_REMOTE_LIVE_VIDEO_BYTES = 40 * 1024 * 1024

function imageBufferToDataUrl(buffer: Buffer): string {
  return `data:${sniffImageMediaType(buffer)};base64,${buffer.toString('base64')}`
}

/**
 * 聊天 IPC 与增量消息事件。
 * chat:new-messages 由 service 事件广播到所有未销毁窗口。
 */
export function registerChatHandlers(ctx: MainProcessContext): void {

  // 监听增量消息推送
  chatService.on('new-messages', (data) => {
    ctx.broadcastToWindows('chat:new-messages', data)
  })

  ipcMain.handle('chat:getMessage', async (_, sessionId: string, localId: number) => {
    return chatService.getMessageByLocalId(sessionId, localId)
  })

  /** 「回忆一刻」：直接扫消息库 + 完整解析校验，不依赖 message_index */
  ipcMain.handle('chat:pickRandomMomentFromIndex', async () => {
    try {
      return await pickRandomPrivateIncomingMoment()
    } catch (e) {
      const err = String(e)
      ctx.getLogService()?.warn('Chat', 'pickRandomMomentFromIndex 失败', { error: err })
      return { success: false, error: err, hint: `随机回忆失败：${err}` }
    }
  })
  ipcMain.handle('chat:connect', async () => {
    ctx.getLogService()?.info('Chat', '尝试连接聊天服务')
    const result = await chatService.connect()
    if (result.success) {
      ctx.getLogService()?.info('Chat', '聊天服务连接成功')
    } else {
      // 聊天连接失败可能是数据库未准备好，使用WARN级别
      ctx.getLogService()?.warn('Chat', '聊天服务连接失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getSessions', async (_, offset?: number, limit?: number) => {
    const result = await chatService.getSessions(offset, limit)
    if (!result.success) {
      // 获取会话失败可能是数据库未连接，使用WARN级别
      ctx.getLogService()?.warn('Chat', '获取会话列表失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:searchSessions', async (_, keyword: string) => {
    const result = await chatService.searchSessions(keyword)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '搜索会话失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMentionTargets', async (_, offset?: number, limit?: number, keyword?: string) => {
    const startedAt = Date.now()
    const logData = {
      offset,
      limit,
      keywordLength: String(keyword || '').trim().length,
      hasKeyword: !!String(keyword || '').trim(),
    }
    ctx.getLogService()?.warn('Chat', '[AgentMention] 获取 Agent @ 列表请求', logData)
    const result = await chatService.getMentionTargets(offset, limit, keyword)
    ctx.getLogService()?.warn('Chat', '[AgentMention] 获取 Agent @ 列表返回', {
      ...logData,
      success: result.success,
      sessions: Array.isArray(result.sessions) ? result.sessions.length : null,
      hasMore: result.hasMore,
      error: result.error,
      elapsedMs: Date.now() - startedAt,
    })
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取 Agent @ 列表失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getContacts', async () => {
    const result = await chatService.getContacts()
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取通讯录失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMessages', async (_, sessionId: string, offset?: number, limit?: number) => {
    const result = await chatService.getMessages(sessionId, offset, limit)
    if (!result.success) {
      // 获取消息失败可能是数据库未连接，使用WARN级别
      ctx.getLogService()?.warn('Chat', '获取消息失败', { sessionId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMessagesBefore', async (
    _,
    sessionId: string,
    cursorSortSeq: number,
    limit?: number,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ) => {
    const result = await chatService.getMessagesBefore(sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '按游标获取更早消息失败', {
        sessionId,
        cursorSortSeq,
        cursorCreateTime,
        cursorLocalId,
        error: result.error
      })
    }
    return result
  })

  ipcMain.handle('chat:getMessagesAfter', async (
    _,
    sessionId: string,
    cursorSortSeq: number,
    limit?: number,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ) => {
    const result = await chatService.getMessagesAfter(sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '按游标获取更新消息失败', {
        sessionId,
        cursorSortSeq,
        cursorCreateTime,
        cursorLocalId,
        error: result.error
      })
    }
    return result
  })

  ipcMain.handle('chat:getNewMessages', async (_, sessionId: string, minTime: number, limit?: number) => {
    const result = await chatService.getNewMessages(sessionId, minTime, limit)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取新增消息失败', { sessionId, minTime, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getAllVoiceMessages', async (_, sessionId: string) => {
    const result = await chatService.getAllVoiceMessages(sessionId)

    // 确保 messages 是数组
    if (result.success && result.messages) {
      // 简化消息对象，只保留必要字段
      const simplifiedMessages = result.messages.map(msg => ({
        localId: msg.localId,
        serverId: msg.serverId,
        localType: msg.localType,
        createTime: msg.createTime,
        sortSeq: msg.sortSeq,
        isSend: msg.isSend,
        senderUsername: msg.senderUsername,
        parsedContent: msg.parsedContent || '',
        rawContent: msg.rawContent || '',
        voiceDuration: msg.voiceDuration
      }))

      return {
        success: true,
        messages: simplifiedMessages
      }
    }

    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取所有语音消息失败', { sessionId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getAllImageMessages', async (_, sessionId: string) => {
    return chatService.getAllImageMessages(sessionId)
  })

  ipcMain.handle('chat:getImageData', async (_, sessionId: string, msgId: string, createTime?: number) => {
    return chatService.getImageData(sessionId, msgId, createTime)
  })

  ipcMain.handle('chat:getContact', async (_, username: string) => {
    return chatService.getContact(username)
  })

  ipcMain.handle('chat:getContactAvatar', async (_, username: string) => {
    return chatService.getContactAvatar(username)
  })

  ipcMain.handle('chat:resolveTransferDisplayNames', async (_, chatroomId: string, payerUsername: string, receiverUsername: string) => {
    return chatService.resolveTransferDisplayNames(chatroomId, payerUsername, receiverUsername)
  })

  ipcMain.handle('chat:getMyAvatarUrl', async () => {
    const result = chatService.getMyAvatarUrl()
    // 首页会调用这个接口，失败是正常的，不记录错误日志
    return result
  })

  ipcMain.handle('chat:getMyUserInfo', async () => {
    const result = chatService.getMyUserInfo()
    // 首页会调用这个接口，失败是正常的，不记录错误日志
    return result
  })

  // 手机遥控端用：下载/解密表情包后直接回传 base64 数据（localPath 是桌面本地路径，手机加载不了）
  agentRpcHandlers.set('agent:downloadEmojiData', async (_event, payload: {
    cdnUrl?: string
    md5?: string
    productId?: string
    encryptUrl?: string
    aesKey?: string
  }) => {
    try {
      const result = await chatService.downloadEmoji(
        payload?.cdnUrl || '', payload?.md5, payload?.productId, undefined, payload?.encryptUrl, payload?.aesKey,
      )
      if (!result.success || !result.localPath) return { success: false, error: result.error || '表情下载失败' }
      if (result.localPath.startsWith('data:image/')) {
        return { success: true, dataUrl: result.localPath }
      }
      const buffer = readFileSync(result.cachePath || result.localPath)
      return { success: true, dataUrl: imageBufferToDataUrl(buffer) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Agent 图片工具输出的 filePath 是电脑本地路径，手机端需通过已鉴权 RPC 读取。
  // 只允许 Agent 图片工具使用的缓存目录，防止该通道变成任意文件读取。
  agentRpcHandlers.set('agent:readAgentImageData', async (_event, payload: {
    filePath?: string
    livePhotoVideoPath?: string
  }) => {
    try {
      const requestedPath = String(payload?.filePath || '').trim()
      const cacheBasePath = ctx.getConfigService()?.getCacheBasePath()
      if (!requestedPath || !cacheBasePath) return { success: false, error: '图片路径无效' }

      const allowedRoots = ['ai-images', 'sns_cache']
        .map((directory) => {
          try { return realpathSync(join(cacheBasePath, directory)) } catch { return '' }
        })
        .filter(Boolean)
      const resolveAllowedFile = (requestedFilePath: string): string | null => {
        if (!requestedFilePath) return null
        try {
          const actualPath = realpathSync(requestedFilePath)
          const isAllowed = allowedRoots.some((root) => {
            const relativePath = relative(root, actualPath)
            return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath)
          })
          return isAllowed ? actualPath : null
        } catch {
          return null
        }
      }

      const actualPath = resolveAllowedFile(requestedPath)
      if (!actualPath) {
        return { success: false, error: '图片不在允许的缓存目录中' }
      }

      const stat = statSync(actualPath)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REMOTE_IMAGE_BYTES) {
        return { success: false, error: '图片文件无效或超过 20MB' }
      }
      const buffer = readFileSync(actualPath)

      const requestedVideoPath = String(payload?.livePhotoVideoPath || '').trim()
      if (!requestedVideoPath) {
        return { success: true, dataUrl: imageBufferToDataUrl(buffer) }
      }
      const actualVideoPath = resolveAllowedFile(requestedVideoPath)
      if (!actualVideoPath) {
        return { success: true, dataUrl: imageBufferToDataUrl(buffer) }
      }
      const videoStat = statSync(actualVideoPath)
      if (!videoStat.isFile() || videoStat.size <= 0 || videoStat.size > MAX_REMOTE_LIVE_VIDEO_BYTES) {
        return { success: true, dataUrl: imageBufferToDataUrl(buffer) }
      }
      const videoExtension = (actualVideoPath.match(/\.[a-z0-9]+$/i)?.[0] || '.mov').toLowerCase()
      return {
        success: true,
        dataUrl: imageBufferToDataUrl(buffer),
        photoExtension: (actualPath.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg').toLowerCase(),
        pairedVideoData: readFileSync(actualVideoPath).toString('base64'),
        pairedVideoExtension: videoExtension,
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('chat:downloadEmoji', async (_, cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => {
    const result = await chatService.downloadEmoji(cdnUrl, md5, productId, createTime, encryptUrl, aesKey)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '下载表情失败', { cdnUrl, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:resolveEmojiPath', async (_, md5?: string, cdnUrl?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => {
    const result = await chatService.downloadEmoji(cdnUrl || '', md5, productId, createTime, encryptUrl, aesKey)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '解析表情缓存路径失败', { md5, cdnUrl, error: result.error })
      return result
    }
    return {
      success: true,
      cachePath: result.cachePath,
      localPath: result.localPath
    }
  })

  ipcMain.handle('chat:close', async () => {
    ctx.getLogService()?.info('Chat', '关闭聊天服务')
    chatService.close()
    return true
  })

  ipcMain.handle('chat:refreshCache', async () => {
    ctx.getLogService()?.info('Chat', '刷新消息缓存')
    chatService.refreshMessageDbCache()
    return true
  })

  ipcMain.handle('chat:setCurrentSession', async (_, sessionId: string | null) => {
    chatService.setCurrentSession(sessionId)
    return true
  })

  ipcMain.handle('chat:getSessionDetail', async (_, sessionId: string) => {
    const result = await chatService.getSessionDetail(sessionId)
    if (!result.success) {
      // 获取会话详情失败可能是数据库未连接，使用WARN级别
      ctx.getLogService()?.warn('Chat', '获取会话详情失败', { sessionId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getVoiceData', async (_, sessionId: string, msgId: string, createTime?: number, serverId?: number) => {
    const result = await chatService.getVoiceData(sessionId, msgId, createTime, serverId)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取语音数据失败', { sessionId, msgId, createTime, serverId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMessagesByDate', async (_, sessionId: string, targetTimestamp: number, limit?: number) => {
    const result = await chatService.getMessagesByDate(sessionId, targetTimestamp, limit)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '按日期获取消息失败', { sessionId, targetTimestamp, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getDatesWithMessages', async (_, sessionId: string, year: number, month: number) => {
    const result = await chatService.getDatesWithMessages(sessionId, year, month)
    if (!result.success) {
      ctx.getLogService()?.warn('Chat', '获取有消息日期失败', { sessionId, year, month, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getRedEnvelopeStatuses', async (_, sessionId: string) => {
    return chatService.getRedEnvelopeStatuses(sessionId)
  })

  // 朋友圈相关

}
