export type DiarySourceSections = {
  dayMessages: string
  conversations: string
  bookmarks: string
  unreadMessages: string
}

/** 为日记正文输出预留的 token（只用于预算计算，不作为请求的 maxOutputTokens：推理模型的思考 token 也计入输出上限）。 */
const DIARY_OUTPUT_TOKEN_RESERVE = 4_096
const DIARY_PROMPT_TOKEN_RESERVE = 4_096
/** 未知模型按 128K 处理，与 aiCompaction.ts 的 DEFAULT_CONTEXT_WINDOW 一致；默认/自定义服务商拿不到 contextWindow。 */
const UNKNOWN_MODEL_CONTEXT_WINDOW = 128_000

function codePointLength(value: string): number {
  let count = 0
  for (const _ of value) count += 1
  return count
}

function sliceCodePoints(value: string, limit: number): string {
  if (limit <= 0 || !value) return ''
  let count = 0
  let output = ''
  for (const character of value) {
    if (count >= limit) break
    output += character
    count += 1
  }
  return output
}

/**
 * 不同供应商的 tokenizer 不统一。日记素材以中文为主，按「1 个 Unicode 字符 ≈ 1 token」估算：
 * 对中文是略保守的上界，对英文则明显保守，但不会高估而撑爆上下文。
 * 分配与截断都按 code point 计数，单位一致、不会切坏代理对。
 */
export function fitDiarySourceSections(
  sections: DiarySourceSections,
  contextWindow?: number,
  additionalPrompt = '',
): DiarySourceSections {
  const safeContextWindow = Number.isFinite(contextWindow) && Number(contextWindow) > 0
    ? Math.floor(Number(contextWindow))
    : UNKNOWN_MODEL_CONTEXT_WINDOW
  const sourceBudget = Math.max(
    0,
    safeContextWindow
      - DIARY_OUTPUT_TOKEN_RESERVE
      - DIARY_PROMPT_TOKEN_RESERVE
      - codePointLength(additionalPrompt),
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
  let remaining = sourceBudget
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
      // 至少给一个字符的份额，避免小余额停滞。
      const share = Math.max(1, Math.floor((remaining * entry.weight) / totalWeight))
      const addition = sliceCodePoints(rest, Math.min(share, capacity))
      const additionLength = codePointLength(addition)
      output[entry.key] += addition
      consumed += additionLength
      if (addition.length < rest.length) nextPending.push(entry)
    }
    if (consumed === 0) break
    remaining -= consumed
    pending = nextPending
  }

  return output
}

export function diarySourceLength(sections: DiarySourceSections): number {
  return Object.values(sections).reduce((sum, value) => sum + codePointLength(value), 0)
}

/**
 * 判断模型输出是否是一篇完整的日记：有一级标题、有「记忆线索」段且段内至少一个条目。
 * 对模型常见的格式漂移保持宽容：```markdown 围栏、标题前的引语、`### 记忆线索：`、`*`/`1.` 列表。
 */
export function isCompleteDiaryMarkdown(text: string): boolean {
  const trimmed = text.trim().replace(/^```[a-zA-Z]*\s*\n/, '').replace(/\n```\s*$/, '').trim()
  const titleMatch = trimmed.match(/^#\s+\S/m)
  const clueMatch = trimmed.match(/^#{2,3}\s*记忆线索[^\n]*\n?([\s\S]*)/m)
  if (!titleMatch || !clueMatch) return false
  if ((titleMatch.index ?? 0) > (clueMatch.index ?? 0)) return false
  return /^\s*(?:[-*•]|\d+[.、)])\s*\S/m.test(clueMatch[1])
}
