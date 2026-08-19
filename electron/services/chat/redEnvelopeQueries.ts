import { dbAdapter } from '../dbAdapter'
import { findDbByName } from '../dbStoragePaths'

/**
 * 红包本地状态：微信桌面端在 general.db 的 redEnvelopeTable 里按 send_id 记录每个红包
 * 「我领没领 / 红包状态」。本地没有金额、也没有领取人列表（那些只在服务端红包详情页）。
 */
export interface RedEnvelopeStatus {
  sendId: string
  senderUsername: string
  /** 微信内部状态码（语义未完全确认，原样透传） */
  hbStatus: number
  hbType: number
  /** 2 = 我已领取；0 = 未领取 */
  receiveStatus: number
}

export async function getRedEnvelopeStatuses(sessionId: string): Promise<RedEnvelopeStatus[]> {
  const dbPath = findDbByName('general.db')
  if (!dbPath) return []
  try {
    const rows = await dbAdapter.all<{
      send_id?: string
      sender_user_name?: string
      hb_status?: number
      hb_type?: number
      receive_status?: number
    }>(
      'misc',
      dbPath,
      'SELECT send_id, sender_user_name, hb_status, hb_type, receive_status FROM redEnvelopeTable WHERE session_name = ?',
      [sessionId]
    )
    return (rows || [])
      .filter((row) => row.send_id)
      .map((row) => ({
        sendId: String(row.send_id),
        senderUsername: String(row.sender_user_name || ''),
        hbStatus: Number(row.hb_status) || 0,
        hbType: Number(row.hb_type) || 0,
        receiveStatus: Number(row.receive_status) || 0
      }))
  } catch {
    // 老版本微信没有这张表 / 库未就绪：当作没有状态
    return []
  }
}
