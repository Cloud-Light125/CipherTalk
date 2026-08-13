/**
 * 远程实时通话通道（手机遥控端）：只注册进 agentRpcHandlers，不进 ipcMain。
 * voice:start 是流式方法，SSE 一直撑到通话结束；手机麦克风由桥接页转成
 * 16k PCM 走 voice:sendAudio 喂进来，TTS 音频事件由桥接页拦下播回手机的音频轨道。
 * 电子依赖全走动态 import，保持本模块可脱离 Electron 被冒烟测试加载。
 */
import { agentRpcHandlers } from './agentRpcRegistry'
import type { VolcengineRealtimeSession } from '../ai/volcengineRealtimeService'

type ActiveRemoteCall = {
  session: VolcengineRealtimeSession
}

const calls = new Map<string, ActiveRemoteCall>()

/** 手机端没有本地会话记录：通话上下文由桌面端从分身对话历史里取（factory 内再做配对清洗） */
async function buildDialogContextFromHistory(sessionId: string): Promise<Array<{ role: string; text: string }>> {
  try {
    const { agentConversationStore } = await import('../agent/conversationStore')
    const [latest] = agentConversationStore.list({ scope: { kind: 'persona', sessionId }, limit: 1 })
    if (!latest) return []
    const loaded = agentConversationStore.load(latest.id)
    if (!loaded) return []
    return loaded.messages.map((message) => ({
      role: String(message.role || ''),
      text: (Array.isArray(message.parts) ? message.parts : [])
        .filter((part) => part?.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
        .map((part) => (part as { text: string }).text)
        .join('\n'),
    }))
  } catch {
    return []
  }
}

export function registerRemoteVoiceHandlers(): void {
  agentRpcHandlers.set('voice:start', async (event, payload?: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const callId = String(input.callId || '').trim()
    const sessionId = String(input.sessionId || '').trim()
    if (!callId || !sessionId) return { success: false, error: '缺少实时通话标识或数字分身标识' }

    const previous = calls.get(callId)
    if (previous) {
      calls.delete(callId)
      await previous.session.close().catch(() => undefined)
    }

    const { createPersonaRealtimeSession, mapRealtimeConnectError } = await import('../ai/personaRealtimeCall')

    let finish: (result: { success: boolean; error?: string }) => void = () => undefined
    const endPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
      let done = false
      finish = (result) => {
        if (done) return
        done = true
        calls.delete(callId)
        resolve(result)
      }
    })

    const created = createPersonaRealtimeSession({
      sessionId,
      dialogContext: await buildDialogContextFromHistory(sessionId),
      onEvent: (realtimeEvent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('voice-realtime:event', { callId, event: realtimeEvent })
        }
        // ended/error 都意味着会话到头了，把撑着的 SSE 放掉
        if (realtimeEvent.type === 'ended') finish({ success: true })
        if (realtimeEvent.type === 'error') finish({ success: false, error: realtimeEvent.error })
      },
    })
    if (!created.success) return created

    const session = created.session
    calls.set(callId, { session })
    try {
      await session.connect()
    } catch (error) {
      calls.delete(callId)
      await session.close().catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: mapRealtimeConnectError(message) }
    }
    return endPromise
  })

  agentRpcHandlers.set('voice:sendAudio', (_event, payload?: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const active = calls.get(String(input.callId || '').trim())
    if (!active) return { success: false, error: '实时通话不存在' }
    try {
      active.session.sendAudio(Buffer.from(String(input.audioBase64 || ''), 'base64'))
      return { success: true }
    } catch (error) {
      // connect() 完成前桥接页就会开始送音频，此时 ws 未打开会抛——丢掉这包就行；
      // 真正的连接死亡由会话自身的 close/error 事件收尾，这里绝不能反手 close 会话
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  agentRpcHandlers.set('voice:truncate', (_event, payload?: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const active = calls.get(String(input.callId || '').trim())
    if (!active) return { success: false, error: '实时通话不存在' }
    active.session.truncate(String(input.replyId || ''), Number(input.audioEndMs) || 0)
    return { success: true }
  })

  agentRpcHandlers.set('voice:stop', async (_event, payload?: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const active = calls.get(String(input.callId || '').trim())
    if (!active) return { success: true }
    // close 会触发 ended 事件，voice:start 的流式响应随之结束
    await active.session.close()
    return { success: true }
  })
}
