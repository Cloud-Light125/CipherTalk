import assert from 'node:assert/strict'
import {
  diarySourceByteLength,
  fitDiarySourceSections,
  isCompleteDiaryMarkdown,
} from '../electron/services/memory/diarySourceBudget.ts'

const source = {
  dayMessages: '天'.repeat(12_000),
  conversations: '对'.repeat(18_000),
  bookmarks: '签'.repeat(6_000),
  unreadMessages: '未'.repeat(12_000),
}

const fitted = fitDiarySourceSections(source, 16_384)
assert.ok(diarySourceByteLength(fitted) <= 8_192, `素材应为输出和提示预留上下文，实际 ${diarySourceByteLength(fitted)} bytes`)
assert.ok(fitted.dayMessages.length > fitted.conversations.length, '主聊天素材应获得最高预算')
assert.ok(fitted.conversations.length > fitted.bookmarks.length, 'AI 对话应比辅助素材获得更多预算')

const unknownModelFitted = fitDiarySourceSections(source, undefined)
assert.ok(diarySourceByteLength(unknownModelFitted) <= 24_576)
const customPrompt = '自定义要求'.repeat(800)
const customPromptFitted = fitDiarySourceSections(source, 16_384, customPrompt)
assert.ok(diarySourceByteLength(customPromptFitted) <= Math.max(0, 4_192 - Buffer.byteLength(customPrompt, 'utf8')))
assert.deepEqual(fitDiarySourceSections(source, 4_096), {
  dayMessages: '', conversations: '', bookmarks: '', unreadMessages: '',
})

const mixedSource = {
  dayMessages: '中文 and English 🙂'.repeat(2_000),
  conversations: '',
  bookmarks: '',
  unreadMessages: '',
}
assert.ok(diarySourceByteLength(fitDiarySourceSections(mixedSource, 10_000)) <= 1_808)

assert.equal(isCompleteDiaryMarkdown('# 2026-08-11 日记\n\n正文。\n\n## 记忆线索\n- 事项'), true)
assert.equal(isCompleteDiaryMarkdown('# 2026-08-11 日记\n\n正文被截断'), false)
assert.equal(isCompleteDiaryMarkdown('## 记忆线索\n- 没有标题'), false)
assert.equal(isCompleteDiaryMarkdown('# 2026-08-11 日记\n\n## 记忆线索'), false)
assert.equal(isCompleteDiaryMarkdown('前言\n# 2026-08-11 日记\n\n## 记忆线索\n- 事项'), false)

console.log('diary source budget tests passed')
