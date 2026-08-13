import { ipcMain, type WebContents } from 'electron'
import { createPersonaRealtimeSession, mapRealtimeConnectError, type RealtimeDialogContextItem } from '../../services/ai/personaRealtimeCall'
import type { VolcengineRealtimeSession, VolcengineRealtimeEvent } from '../../services/ai/volcengineRealtimeService'

type RealtimeStartPayload = {
  callId: string
  sessionId: string
  dialogContext?: RealtimeDialogContextItem[]
}

type ActiveRealtimeSession = {
  ownerId: number
  owner: WebContents
  onOwnerDestroyed: () => void
  session: VolcengineRealtimeSession
}

const sessions = new Map<string, ActiveRealtimeSession>()

function detachOwnerListener(active: ActiveRealtimeSession): void {
  active.owner.removeListener('destroyed', active.onOwnerDestroyed)
}

export function registerVoiceRealtimeHandlers(): void {
  ipcMain.handle('voice-realtime:start', async (event, payload: RealtimeStartPayload) => {
    const callId = String(payload?.callId || '').trim()
    const personaSessionId = String(payload?.sessionId || '').trim()
    if (!callId || !personaSessionId) return { success: false, error: '缺少实时通话标识或数字分身标识' }

    const previous = sessions.get(callId)
    if (previous) {
      detachOwnerListener(previous)
      await previous.session.close().catch(() => undefined)
      sessions.delete(callId)
    }

    const ownerId = event.sender.id
    const emit = (realtimeEvent: VolcengineRealtimeEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send('voice-realtime:event', { callId, event: realtimeEvent })
    }
    const created = createPersonaRealtimeSession({
      sessionId: personaSessionId,
      dialogContext: payload.dialogContext,
      onEvent: emit,
    })
    if (!created.success) return created
    const session = created.session
    const onOwnerDestroyed = () => {
      const active = sessions.get(callId)
      if (active?.ownerId !== ownerId) return
      sessions.delete(callId)
      void active.session.close()
    }
    const active: ActiveRealtimeSession = { ownerId, owner: event.sender, onOwnerDestroyed, session }
    sessions.set(callId, active)
    event.sender.once('destroyed', onOwnerDestroyed)

    try {
      await session.connect()
      return { success: true, callId }
    } catch (error) {
      sessions.delete(callId)
      detachOwnerListener(active)
      await session.close().catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: mapRealtimeConnectError(message) }
    }
  })

  ipcMain.on('voice-realtime:audio', (event, callIdValue: string, audio: ArrayBuffer | Uint8Array) => {
    const callId = String(callIdValue || '').trim()
    const active = sessions.get(callId)
    if (!active || active.ownerId !== event.sender.id) return
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
    try {
      active.session.sendAudio(bytes)
    } catch (error) {
      sessions.delete(callId)
      detachOwnerListener(active)
      if (!event.sender.isDestroyed()) {
        event.sender.send('voice-realtime:event', {
          callId,
          event: { type: 'error', error: error instanceof Error ? error.message : String(error) },
        })
      }
      void active.session.close()
    }
  })

  ipcMain.handle('voice-realtime:truncate', async (event, callIdValue: string, replyId: string, audioEndMs: number) => {
    const active = sessions.get(String(callIdValue || '').trim())
    if (!active || active.ownerId !== event.sender.id) return { success: false, error: '实时通话不存在' }
    active.session.truncate(replyId, audioEndMs)
    return { success: true }
  })

  ipcMain.handle('voice-realtime:stop', async (event, callIdValue: string) => {
    const callId = String(callIdValue || '').trim()
    const active = sessions.get(callId)
    if (!active || active.ownerId !== event.sender.id) return { success: true }
    sessions.delete(callId)
    detachOwnerListener(active)
    await active.session.close()
    return { success: true }
  })
}
