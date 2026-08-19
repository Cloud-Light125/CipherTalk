import assert from 'node:assert/strict'
import {
  diarySourceLength,
  fitDiarySourceSections,
  isCompleteDiaryMarkdown,
} from '../electron/services/memory/diarySourceBudget.ts'

const source = {
  dayMessages: '天'.repeat(12_000),
  conversations: '对'.repeat(18_000),
  bookmarks: '签'.repeat(6_000),
  unreadMessages: '未'.repeat(12_000),
}

// 16K 窗口：扣掉 4096 输出 + 4096 提示预留后素材上限 8192 字符
const fitted = fitDiarySourceSections(source, 16_384)
assert.ok(diarySourceLength(fitted) <= 8_192, `素材应为输出和提示预留上下文，实际 ${diarySourceLength(fitted)} 字符`)
assert.ok(diarySourceLength(fitted) >= 8_100, `预算应被充分使用，实际 ${diarySourceLength(fitted)} 字符`)
assert.ok(fitted.dayMessages.length > fitted.conversations.length, '主聊天素材应获得最高预算')
assert.ok(fitted.conversations.length > fitted.bookmarks.length, 'AI 对话应比辅助素材获得更多预算')

// 未知模型按 128K 处理：普通日子（总计 48000 字）不应被截断
const unknownModelFitted = fitDiarySourceSections(source, undefined)
assert.deepEqual(unknownModelFitted, source, '未知模型默认 128K，普通规模素材不应被截断')
assert.ok(diarySourceLength(fitDiarySourceSections({
  ...source,
  dayMessages: '天'.repeat(200_000),
}, undefined)) <= 128_000 - 8_192, '未知模型超大素材应被限制在 128K 预算内')

// 自定义提示占用预算
const customPrompt = '自定义要求'.repeat(800)
const customPromptFitted = fitDiarySourceSections(source, 16_384, customPrompt)
assert.ok(diarySourceLength(customPromptFitted) <= Math.max(0, 8_192 - [...customPrompt].length))

// 极小上下文：什么都装不下
assert.deepEqual(fitDiarySourceSections(source, 4_096), {
  dayMessages: '', conversations: '', bookmarks: '', unreadMessages: '',
})

// 中英混合与 emoji：按 code point 截断，不切坏代理对
const mixedSource = {
  dayMessages: '中文 and English 🙂'.repeat(2_000),
  conversations: '',
  bookmarks: '',
  unreadMessages: '',
}
const mixedFitted = fitDiarySourceSections(mixedSource, 10_000)
assert.ok(diarySourceLength(mixedFitted) <= 1_808)
assert.equal(mixedFitted.dayMessages.includes('�'), false)
assert.equal(Buffer.from(mixedFitted.dayMessages, 'utf8').toString('utf8'), mixedFitted.dayMessages, '截断结果应为合法 UTF-8')

// 结构校验：完整
assert.equal(isCompleteDiaryMarkdown('# 2026-08-11 日记\n\n正文。\n\n## 记忆线索\n- 事项'), true)
// 容忍常见格式漂移
assert.equal(isCompleteDiaryMarkdown('```markdown\n# 2026-08-11 日记\n\n正文。\n\n## 记忆线索\n- 事项\n```'), true, '应剥离 markdown 围栏')
assert.equal(isCompleteDiaryMarkdown('以下是日记：\n\n# 2026-08-11 日记\n\n正文。\n\n## 记忆线索\n- 事项'), true, '标题前允许引语')
assert.equal(isCompleteDiaryMarkdown('# 2026-08-11 日记\n\n正文。\n\n### 记忆线索：\n* 事项'), true, '允许三级标题、冒号与 * 列表')
assert.equal(isCompleteDiaryMarkdown('# 2026-08-11 日记\n\n正文。\n\n## 记忆线索\n1. 事项'), true, '允许有序列表')
// 截断 / 缺段
assert.equal(isCompleteDiaryMarkdown('# 2026-08-11 日记\n\n正文被截断'), false)
assert.equal(isCompleteDiaryMarkdown('## 记忆线索\n- 没有标题'), false)
assert.equal(isCompleteDiaryMarkdown('# 2026-08-11 日记\n\n## 记忆线索'), false)
assert.equal(isCompleteDiaryMarkdown('## 记忆线索\n- 事项\n\n# 标题在后面'), false)

console.log('diary source budget tests passed')
