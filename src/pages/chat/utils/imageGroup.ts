import type { Message } from '../../../types/models'

export interface ImageGroupInfo {
  id: string
  type: number
  count: number
}

const groupInfoCache = new WeakMap<Message, ImageGroupInfo | null>()

function readElementText(parent: Element, tagName: string): string {
  return parent.getElementsByTagName(tagName)[0]?.textContent?.trim() || ''
}

/**
 * 解析微信图片消息中的 extcommoninfo/groupinfo。
 * 先截取 groupinfo 片段再交给 DOMParser，以兼容群聊消息可能附带的 XML 前缀。
 */
export function getImageGroupInfo(message: Message): ImageGroupInfo | undefined {
  const cached = groupInfoCache.get(message)
  if (cached !== undefined) return cached || undefined

  const rawContent = message.rawContent
  if (message.localType !== 3 || !rawContent || !rawContent.includes('<groupinfo')) {
    groupInfoCache.set(message, null)
    return undefined
  }

  const groupFragment = rawContent.match(/<groupinfo\b[^>]*>[\s\S]*?<\/groupinfo>/i)?.[0]
  if (!groupFragment) {
    groupInfoCache.set(message, null)
    return undefined
  }

  try {
    const document = new DOMParser().parseFromString(groupFragment, 'application/xml')
    if (document.querySelector('parsererror')) {
      groupInfoCache.set(message, null)
      return undefined
    }

    const groupElement = document.documentElement
    const id = readElementText(groupElement, 'id')
    const type = Number.parseInt(readElementText(groupElement, 'type'), 10)
    const count = Number.parseInt(readElementText(groupElement, 'count'), 10)

    if (!id || !Number.isFinite(type) || !Number.isFinite(count) || count < 1) {
      groupInfoCache.set(message, null)
      return undefined
    }

    const info = { id, type, count }
    groupInfoCache.set(message, info)
    return info
  } catch {
    groupInfoCache.set(message, null)
    return undefined
  }
}

export function isStackableImageGroup(info?: ImageGroupInfo): info is ImageGroupInfo {
  return Boolean(info && info.type === 1 && info.count > 1)
}
