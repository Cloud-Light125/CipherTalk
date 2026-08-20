/**
 * 手机断开后跑完的运行：把回复重建出来落库，再推一条通知。
 *
 * 为什么需要这一步：agent:run / clone:chat 本身不落库，回复是由调用方（桌面渲染层
 * 或手机）攒好后调 agent:saveConversationMessages 保存的。手机断了就没人攒了——
 * 早先 gateway 干脆把任务中止掉，理由是「避免空跑」。但活儿本来就在电脑上跑，
 * 该补的是这边的落库，而不是把任务砍了。
 */
import { readUIMessageStream } from 'ai'
import type { UIMessage } from 'ai'
import type { DetachedRun } from './gateway'
import { hasPushTargets, pushToRemoteDevices } from './pushHandlers'

type DetachedLogger = {
  info(category: string, message: string, data?: any): void
  warn(category: string, message: string, data?: any): void
} | null

/** 通知正文里最多带多少字，太长了系统也会截 */
const PREVIEW_LIMIT = 80

function textOf(message: UIMessage | null): string {
  if (!message) return ''
  return (Array.isArray(message.parts) ? message.parts : [])
    .filter((part) => part?.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => (part as { text: string }).text)
    .join('')
    .trim()
}

/** 把整段 chunk 流喂给 AI SDK，拿最后一版就是完整的助手消息 */
async function rebuildAssistantMessage(chunks: unknown[]): Promise<UIMessage | null> {
  const valid = chunks.filter((chunk): chunk is Record<string, unknown> => Boolean(chunk) && typeof chunk === 'object')
  if (valid.length === 0) return null
  const stream = new ReadableStream<any>({
    start(controller) {
      for (const chunk of valid) controller.enqueue(chunk)
      controller.close()
    },
  })
  let last: UIMessage | null = null
  try {
    for await (const message of readUIMessageStream({ stream, onError: () => undefined })) {
      last = message as UIMessage
    }
  } catch {
    return last
  }
  return last
}

/**
 * 定位这次运行该写进哪个会话。
 * agent:run 手机会把 conversationId 直接带上；clone:chat 没有这个字段，
 * 但手机在发起前一定先建好了 persona scope 的会话，取最近一条即可。
 */
async function resolveConversationId(run: DetachedRun): Promise<number | null> {
  const input = (run.params[0] ?? {}) as Record<string, unknown>
  if (run.method === 'agent:run') {
    const id = Number(input.conversationId)
    return Number.isFinite(id) && id > 0 ? id : null
  }
  const sessionId = String(input.sessionId || '')
  if (!sessionId) return null
  const { agentConversationStore } = await import('../agent/conversationStore')
  const last = agentConversationStore.getLast({ kind: 'persona', sessionId })
  return last?.id ?? null
}

export async function persistDetachedRun(run: DetachedRun, logger: DetachedLogger): Promise<void> {
  const assistant = await rebuildAssistantMessage(run.chunks)
  const text = textOf(assistant)
  if (!assistant || !text) {
    logger?.warn('RemoteRun', '后台运行没有产出可保存的内容', { method: run.method })
    return
  }

  const conversationId = await resolveConversationId(run)
  if (!conversationId) {
    logger?.warn('RemoteRun', '后台运行完成但找不到对应会话，结果没能保存', { method: run.method })
    return
  }

  const input = (run.params[0] ?? {}) as Record<string, unknown>
  const requestMessages = Array.isArray(input.messages) ? input.messages as UIMessage[] : []
  const lastUser = [...requestMessages].reverse().find((message) => message?.role === 'user') || null
  // 手机在发起时就生成了助手消息 id 并一起传过来，这里沿用它：
  // 否则手机回来后再保存自己那条半截的消息，两条 id 不同会双双留下，界面上重影
  const assistantId = String(input.assistantMessageId || '') || assistant.id

  try {
    const { agentConversationStore } = await import('../agent/conversationStore')
    const loaded = agentConversationStore.load(conversationId)
    if (!loaded) {
      logger?.warn('RemoteRun', '后台运行完成但会话已被删除', { conversationId })
      return
    }
    const existing = new Set(loaded.messages.map((message) => message.id))
    const pending = [
      ...(lastUser && !existing.has(lastUser.id) ? [lastUser] : []),
      ...(existing.has(assistantId) ? [] : [{ ...assistant, id: assistantId }]),
    ]
    if (pending.length === 0) return
    agentConversationStore.append(conversationId, pending)
    logger?.warn('RemoteRun', '后台运行结果已保存', { conversationId, method: run.method })
  } catch (error) {
    logger?.warn('RemoteRun', '保存后台运行结果失败', { conversationId, error: String(error) })
    return
  }

  if (!hasPushTargets()) return
  const body = text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text
  if (run.method === 'clone:chat') {
    // 克隆好友的回复：标题用好友名字（会话标题形如「XX的分身」，去掉后缀），
    // 跳转回克隆会话页而不是 AI 对话页
    const sessionId = String(input.sessionId || '')
    const { agentConversationStore } = await import('../agent/conversationStore')
    const meta = agentConversationStore.loadMeta(conversationId, false)
    const displayName = String(meta?.title || '').replace(/的分身$/, '').trim() || '克隆好友'
    await pushToRemoteDevices({
      title: displayName,
      body,
      route: `/clone/${encodeURIComponent(sessionId)}?displayName=${encodeURIComponent(displayName)}`,
      group: '克隆好友',
    })
    return
  }
  await pushToRemoteDevices({
    title: 'AI 助手已完成',
    body,
    route: `/chat/${conversationId}`,
    group: 'AI 助手',
  })
}
