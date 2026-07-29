/**
 * AI 摘要独立窗口（/chat-summary?sessionId&displayName&range）
 * 打开即用专用提示词跑一轮摘要，跑完可以就着结果继续追问。
 * 不经 AI 助手页：agent:run 的流式 chunk 回给调用方窗口，本窗口自己发起即可。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useChat } from '@ai-sdk/react'
import { Button } from '@heroui/react'
import { ArrowsRotateLeft } from '@gravity-ui/icons'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Loader } from '@/components/ai-elements/loader'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
import { IpcChatTransport, type AgentProgressEvent, type AgentScope } from '@/features/aiagent/transport/ipcChatTransport'
import { GlassWindowControls } from '@/components/GlassWindowControls'
import './ChatSummaryWindow.css'

/** 摘要专用提示词，独立于 AI 助手的预设/人格 */
function buildSummaryPrompt(displayName: string, isGroup: boolean, range: string): string {
  const target = isGroup ? `群聊「${displayName}」` : `我和「${displayName}」`
  return `请总结${target}${range}的聊天记录。

要求：
1. 按主题归纳主要讨论内容和关键结论。
2. 标出重要事项、待办、承诺和情绪变化。
3. 引用关键原话或聊天片段作为依据，不要凭空推断。
4. 如果该时间段没有聊天记录，请直接说明。
5. 用 Markdown 小标题分段，不要写开场白和结束语。`
}

function textOf(parts: { type: string; text?: string }[]): string {
  return parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('')
}

export default function ChatSummaryWindow() {
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('sessionId') || ''
  const displayName = searchParams.get('displayName') || sessionId
  const range = searchParams.get('range') || '今天'
  const isGroup = sessionId.endsWith('@chatroom')

  const [progressText, setProgressText] = useState('')
  const scope = useMemo<AgentScope>(() => ({ kind: 'session', sessionId, displayName }), [sessionId, displayName])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const transport = useMemo(
    () => new IpcChatTransport(
      () => scopeRef.current,
      () => null, // 模型走设置里当前选中的 provider/model
      () => null, // 摘要不落 Agent 对话记录
      (progress: AgentProgressEvent) => setProgressText(progress.visible === false ? '' : progress.title || ''),
    ),
    []
  )
  const { messages, sendMessage, setMessages, status, stop, error } = useChat({ transport, experimental_throttle: 50 })
  const busy = status === 'submitted' || status === 'streaming'

  const startSummary = () => {
    setMessages([])
    setProgressText('')
    void sendMessage({ parts: [{ type: 'text', text: buildSummaryPrompt(displayName, isGroup, range) }] })
  }

  // 挂载即跑首轮；StrictMode 下 effect 会跑两次，用 ref 挡住
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current || !sessionId) return
    startedRef.current = true
    startSummary()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时跑一次
  }, [sessionId])

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim()
    if (!text || busy) return
    void sendMessage({ parts: [{ type: 'text', text }] })
  }

  if (!sessionId) {
    return <div className="chat-summary-empty">缺少会话参数</div>
  }

  return (
    <div className="chat-summary-window">
      <div className="chat-summary-titlebar">
        <div className="chat-summary-title">
          <strong>{displayName}</strong>
          <span className="chat-summary-range">{range}的聊天摘要</span>
        </div>
        <GlassWindowControls />
      </div>

      <Conversation className="chat-summary-body">
        <ConversationContent className="chat-summary-messages">
          {messages.map((message) => {
            // 首条 user 消息是内置提示词，不展示给用户
            const isFirstPrompt = message.role === 'user' && message.id === messages[0]?.id
            if (isFirstPrompt) return null
            const text = textOf(message.parts as { type: string; text?: string }[])
            if (!text) return null
            return (
              <Message key={message.id} from={message.role}>
                <MessageContent>
                  {message.role === 'assistant'
                    ? <MessageResponse isStreaming={busy}>{text}</MessageResponse>
                    : text}
                </MessageContent>
              </Message>
            )
          })}
          {busy && (
            <div className="chat-summary-progress">
              <Loader size={14} />
              <span>{progressText || '正在读取聊天记录…'}</span>
            </div>
          )}
          {error && <div className="chat-summary-error">{error.message}</div>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="chat-summary-footer">
        <Button
          size="sm"
          variant="ghost"
          isDisabled={busy}
          onPress={startSummary}
          className="chat-summary-regen"
        >
          <ArrowsRotateLeft width={15} height={15} />
          重新生成
        </Button>
        <PromptInput className="chat-summary-input" onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="就这份摘要继续追问…" />
          </PromptInputBody>
          <PromptInputFooter>
            <span />
            <PromptInputSubmit status={status} onClick={busy ? () => void stop() : undefined} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}
