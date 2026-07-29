import assert from 'node:assert/strict'
import { parseModelsPayload } from '../electron/services/ai/codexModelsPayload.ts'

// 字段取自真实 GET /backend-api/wham/models?client_version=... 的 200 响应
const payload = {
  models: [
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', description: '均衡', default_reasoning_level: 'medium', visibility: 'list', priority: 2, context_window: 272000 },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', description: '通用', default_reasoning_level: 'medium', visibility: 'list', priority: 7, context_window: 272000 },
    { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', priority: 23, upgrade: { model: 'gpt-5.6-luna', migration_markdown: '已下线' } },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
    { display_name: '没有 slug 的脏数据', visibility: 'list', priority: 0 },
  ],
}

const models = parseModelsPayload(payload)
assert.deepEqual(
  models.map((model) => model.id),
  ['gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4-mini', 'codex-auto-review'],
  '除了没有 slug 的脏数据，服务端返回什么就原样给什么（hide / 已下线的也保留）',
)
assert.equal(models[0].isDefault, true, '第一个作为默认模型')
assert.equal(models[1].isDefault, false)
assert.equal(models[0].displayName, 'GPT-5.6-Terra')
assert.equal(models[0].contextWindow, 272000)
assert.equal(models[3].hidden, true, 'visibility=hide 只做标记，不过滤')
assert.equal(parseModelsPayload({ models: [{ slug: 'a' }] })[0].defaultReasoningEffort, 'medium', '缺字段时回落到 medium')
assert.deepEqual(parseModelsPayload([{ slug: 'a' }]).map((model) => model.id), ['a'], '裸数组响应也要能解析')
assert.deepEqual(parseModelsPayload({ error: 'nope' }), [], '非预期响应返回空列表，交给上层走兜底')

console.log('codex models payload 解析测试通过')
