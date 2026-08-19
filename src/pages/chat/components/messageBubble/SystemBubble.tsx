import { useEffect, useState } from 'react'
import type { Message } from '../../../../types/models'
import MessageContent from '../../../../components/MessageContent'

const PLACEHOLDER_RE = /\$([A-Za-z0-9_@.-]+)\$/g
const nameCache = new Map<string, Promise<string>>()

function resolveName(username: string): Promise<string> {
  let hit = nameCache.get(username)
  if (!hit) {
    hit = (window.electronAPI?.chat?.getContactAvatar?.(username) ?? Promise.resolve(null))
      .then((info) => info?.displayName || username)
      .catch(() => username)
    nameCache.set(username, hit)
  }
  return hit
}

/** 系统消息里的 `$wxid$` 占位（如"你领取了$wxid_xxx$的红包"）替换为昵称 */
function useResolvedSystemText(text: string): string {
  const [resolved, setResolved] = useState(text)
  useEffect(() => {
    const usernames = [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))]
    if (usernames.length === 0) {
      setResolved(text)
      return
    }
    let cancelled = false
    Promise.all(usernames.map((u) => resolveName(u).then((name) => [u, name] as const))).then((pairs) => {
      if (cancelled) return
      const map = new Map(pairs)
      setResolved(text.replace(PLACEHOLDER_RE, (_, u: string) => map.get(u) || u))
    })
    return () => { cancelled = true }
  }, [text])
  return resolved
}

interface SystemBubbleProps {
  message: Message
}

/**
 * 系统消息气泡（localType === 10000，以及拍一拍 appmsg type=62）
 * 渲染为独立的系统消息行，无头像和常规气泡样式
 */
function SystemBubble({ message }: SystemBubbleProps) {
  const isPatAppMsg = (() => {
    const content = message.rawContent || message.parsedContent || ''
    if (!content) return false
    return /<appmsg[\s\S]*?>[\s\S]*?<type>\s*62\s*<\/type>/i.test(content) || /<patinfo[\s\S]*?>/i.test(content)
  })()

  let systemText = message.parsedContent || '[系统消息]'
  if (isPatAppMsg) {
    try {
      const content = message.rawContent || message.parsedContent || ''
      const xmlContent = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
      const parser = new DOMParser()
      const doc = parser.parseFromString(xmlContent, 'text/xml')
      systemText = (doc.querySelector('title')?.textContent || systemText || '[拍一拍]').trim()
    } catch {
      // ignore
    }
  }

  const displayText = useResolvedSystemText(systemText)

  return (
    <div className="message-bubble system">
      <div className="bubble-content"><MessageContent content={displayText} /></div>
    </div>
  )
}

export default SystemBubble
