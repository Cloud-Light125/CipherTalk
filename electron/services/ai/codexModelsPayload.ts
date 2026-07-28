export type CodexSubscriptionModel = {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  hidden: boolean
  defaultReasoningEffort?: string
  contextWindow?: number
}

export const GPT_56_CONTEXT_WINDOW = 1_000_000

/**
 * 解析 ChatGPT /backend-api/wham/models 的响应。
 * 不做任何过滤：服务端返回什么就给什么，顺序也按响应原样（服务端已按 priority 排好）。
 */
export function parseModelsPayload(payload: unknown): CodexSubscriptionModel[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { models?: unknown })?.models)
      ? (payload as { models: unknown[] }).models
      : []
  return list
    .map((item) => item as Record<string, unknown>)
    .filter((item) => typeof item?.slug === 'string' && item.slug)
    .map((item, index) => {
      const id = item.slug as string
      return {
        id,
        displayName: typeof item.display_name === 'string' ? item.display_name : id,
        description: typeof item.description === 'string' ? item.description : '',
        isDefault: index === 0,
        hidden: item.visibility === 'hide',
        defaultReasoningEffort: typeof item.default_reasoning_level === 'string' ? item.default_reasoning_level : 'medium',
        contextWindow: /^gpt-5\.6(?:-|$)/.test(id)
          ? GPT_56_CONTEXT_WINDOW
          : (typeof item.context_window === 'number' ? item.context_window : undefined),
      }
    })
}
