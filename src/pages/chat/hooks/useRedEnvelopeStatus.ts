import { useEffect, useState } from 'react'

export interface RedEnvelopeStatus {
  sendId: string
  senderUsername: string
  hbStatus: number
  hbType: number
  receiveStatus: number
}

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { at: number; promise: Promise<Map<string, RedEnvelopeStatus>> }>()

function loadSession(sessionId: string): Promise<Map<string, RedEnvelopeStatus>> {
  const hit = cache.get(sessionId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise
  const promise = (window.electronAPI?.chat?.getRedEnvelopeStatuses?.(sessionId) ?? Promise.resolve([]))
    .then((rows) => new Map((rows || []).map((row) => [row.sendId, row])))
    .catch(() => new Map<string, RedEnvelopeStatus>())
  cache.set(sessionId, { at: Date.now(), promise })
  return promise
}

/** 按 sendId 取红包的本地状态；会话内一次查询、30s 内复用。 */
export function useRedEnvelopeStatus(sessionId: string | undefined, sendId: string | undefined): RedEnvelopeStatus | null {
  const [status, setStatus] = useState<RedEnvelopeStatus | null>(null)
  useEffect(() => {
    if (!sessionId || !sendId) return
    let cancelled = false
    loadSession(sessionId).then((map) => {
      if (!cancelled) setStatus(map.get(sendId) ?? null)
    })
    return () => { cancelled = true }
  }, [sessionId, sendId])
  return status
}
