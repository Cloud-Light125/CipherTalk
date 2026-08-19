export type DiarySourceSections = {
  dayMessages: string
  conversations: string
  bookmarks: string
  unreadMessages: string
}

export const DIARY_MAX_OUTPUT_TOKENS = 4_096
const DIARY_PROMPT_TOKEN_RESERVE = 4_096
const UNKNOWN_MODEL_CONTEXT_WINDOW = 32_768

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function sliceUtf8Bytes(value: string, byteLimit: number): string {
  if (byteLimit <= 0 || !value) return ''
  if (utf8ByteLength(value) <= byteLimit) return value

  let bytes = 0
  let output = ''
  for (const character of value) {
    const characterBytes = utf8ByteLength(character)
    if (bytes + characterBytes > byteLimit) break
    output += character
    bytes += characterBytes
  }
  return output
}

/**
 * 不同供应商的 tokenizer 不统一，因此不猜测“中文字符/token”比例。
 * UTF-8 字节数作为 token 数的保守上界来分配素材；截断也按字节执行，单位始终一致。
 */
export function fitDiarySourceSections(
  sections: DiarySourceSections,
  contextWindow?: number,
  additionalPrompt = '',
): DiarySourceSections {
  const safeContextWindow = Number.isFinite(contextWindow) && Number(contextWindow) > 0
    ? Math.floor(Number(contextWindow))
    : UNKNOWN_MODEL_CONTEXT_WINDOW
  const sourceBudgetBytes = Math.max(
    0,
    safeContextWindow
      - DIARY_MAX_OUTPUT_TOKENS
      - DIARY_PROMPT_TOKEN_RESERVE
      - utf8ByteLength(additionalPrompt),
  )
  const entries = [
    { key: 'dayMessages' as const, weight: 5 },
    { key: 'conversations' as const, weight: 3 },
    { key: 'bookmarks' as const, weight: 1 },
    { key: 'unreadMessages' as const, weight: 1 },
  ]
  const output: DiarySourceSections = {
    dayMessages: '',
    conversations: '',
    bookmarks: '',
    unreadMessages: '',
  }
  let remaining = sourceBudgetBytes
  let pending = entries.filter(({ key }) => sections[key].length > 0)

  while (remaining > 0 && pending.length > 0) {
    const totalWeight = pending.reduce((sum, entry) => sum + entry.weight, 0)
    let consumed = 0
    const nextPending: typeof pending = []
    for (const entry of pending) {
      const value = sections[entry.key]
      const alreadyUsed = output[entry.key].length
      const rest = value.slice(alreadyUsed)
      const capacity = remaining - consumed
      if (capacity <= 0) {
        nextPending.push(entry)
        continue
      }
      // UTF-8 单个 Unicode 字符最多 4 字节；至少给一个字符可落下的份额，避免小余额停滞。
      const share = Math.max(4, Math.floor((remaining * entry.weight) / totalWeight))
      const addition = sliceUtf8Bytes(rest, Math.min(share, capacity))
      const additionBytes = utf8ByteLength(addition)
      output[entry.key] += addition
      consumed += additionBytes
      if (addition.length < rest.length) nextPending.push(entry)
    }
    if (consumed === 0) break
    remaining -= consumed
    pending = nextPending
  }

  return output
}

export function diarySourceByteLength(sections: DiarySourceSections): number {
  return Object.values(sections).reduce((sum, value) => sum + utf8ByteLength(value), 0)
}

export function isCompleteDiaryMarkdown(text: string): boolean {
  const trimmed = text.trim()
  const clueSection = trimmed.match(/^##\s+记忆线索\s*$([\s\S]*)/m)?.[1] || ''
  return /^#\s+.+/.test(trimmed) && /^\s*-\s+\S+/m.test(clueSection)
}
