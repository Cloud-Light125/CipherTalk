import assert from 'node:assert/strict'
import { injectOpenAICompatiblePromptCacheKey, isNvidiaInferenceBaseURL } from '../electron/services/agent/promptCacheCompat.ts'

// ---- isNvidiaInferenceBaseURL ----
assert.equal(isNvidiaInferenceBaseURL('https://integrate.api.nvidia.com/v1'), true, 'integrate.api.nvidia.com/v1 应判为英伟达')
assert.equal(isNvidiaInferenceBaseURL('https://api.nvidia.com/v1'), true, 'api.nvidia.com/v1 应判为英伟达')
assert.equal(isNvidiaInferenceBaseURL('https://integrate.api.nvidia.com'), true, '无路径的 integrate.api.nvidia.com 也应判为英伟达')
assert.equal(isNvidiaInferenceBaseURL('https://api.openai.com/v1'), false, 'OpenAI 不应判为英伟达')
assert.equal(isNvidiaInferenceBaseURL('https://api.deepseek.com'), false, 'DeepSeek 不应判为英伟达')
assert.equal(isNvidiaInferenceBaseURL('https://ark.cn/v1'), false, '火山方舟不应被误判为英伟达（方舟需保留 prompt_cache_key）')
assert.equal(isNvidiaInferenceBaseURL(undefined), false, '无 baseURL 不应判为英伟达')

// ---- injectOpenAICompatiblePromptCacheKey：NVIDIA 必须跳过，其它端点保留 ----
const baseArgs = { model: 'x', messages: [] }

const nvidiaResult = injectOpenAICompatiblePromptCacheKey(baseArgs, 'cache-key', 'https://integrate.api.nvidia.com/v1')
assert.equal('prompt_cache_key' in nvidiaResult, false, 'NVIDIA 请求体不得含 prompt_cache_key')
assert.equal(nvidiaResult, baseArgs, 'NVIDIA 命中 skip 分支时应原样返回（不新增字段、不复制）')

const openaiResult = injectOpenAICompatiblePromptCacheKey(baseArgs, 'cache-key', 'https://api.openai.com/v1')
assert.equal(openaiResult.prompt_cache_key, 'cache-key', 'OpenAI 应保留 prompt_cache_key')

const deepseekResult = injectOpenAICompatiblePromptCacheKey(baseArgs, 'cache-key', 'https://api.deepseek.com')
assert.equal(deepseekResult.prompt_cache_key, 'cache-key', 'DeepSeek 应保留 prompt_cache_key')

const arkResult = injectOpenAICompatiblePromptCacheKey(baseArgs, 'cache-key', 'https://ark.cn/v1')
assert.equal(arkResult.prompt_cache_key, 'cache-key', '火山方舟应保留 prompt_cache_key（context 缓存依赖它）')

// 未提供 key 时原样返回（不新增字段）
assert.equal(injectOpenAICompatiblePromptCacheKey(baseArgs, undefined, 'https://integrate.api.nvidia.com/v1'), baseArgs, '无 key 时原样返回')
assert.equal(injectOpenAICompatiblePromptCacheKey(baseArgs, undefined, 'https://api.openai.com/v1'), baseArgs, '无 key 时原样返回')

console.log('nvidia prompt_cache_key compat tests passed')
