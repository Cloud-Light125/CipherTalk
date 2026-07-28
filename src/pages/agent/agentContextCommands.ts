const CLEAR_CONTEXT_COMMANDS = new Set([
  '清除上下文',
  '清空上下文',
  '重置上下文',
  '清除上下文关系',
  '清除当前上下文',
  '清空当前上下文',
  '重置当前上下文',
  '清除当前对话上下文',
  '清空当前对话上下文',
  '重置当前对话上下文',
  '清除当前对话的上下文记录',
  '清空当前对话的上下文记录',
])

export function isClearContextCommand(value: string): boolean {
  const normalized = String(value || '')
    .trim()
    .replace(/[\s，,。.!！?？;；:：]+/g, '')
  return CLEAR_CONTEXT_COMMANDS.has(normalized)
}
