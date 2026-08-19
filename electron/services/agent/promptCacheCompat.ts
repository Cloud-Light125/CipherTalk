/**
 * prompt cache 兼容性辅助：集中处理「哪些端点不支持 `prompt_cache_key`」。
 *
 * 背景：英伟达的 OpenAI 兼容推理接口（integrate.api.nvidia.com / api.nvidia.com）
 * 不认 OpenAI 的 `prompt_cache_key` 扩展字段，带上会直接 400
 * （Unsupported parameter(s): prompt_cache_key，见 issue #353）。
 *
 * 该字段会从两条路径进入请求体，必须同时拦截：
 *  1. provider.ts 的 transformRequestBody（直接写请求体）
 *  2. cache.ts 的 buildProviderOptions（经 providerOptions 透传）
 * 本模块是唯一真相来源，两处都 import 它，避免逻辑漂移。
 *
 * 零依赖：可被单元测试单独导入，无需安装 Electron 依赖树。
 */

/** 判断 baseURL 是否属于英伟达推理接口。 */
export function isNvidiaInferenceBaseURL(baseURL?: string): boolean {
  if (!baseURL) return false
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    return host === 'nvidia.com' || host.endsWith('.nvidia.com')
  } catch {
    return false
  }
}

/**
 * 仅对支持 prompt cache 的 OpenAI 兼容端点注入 `prompt_cache_key`；
 * 英伟达推理接口不支持该字段，命中时跳过注入，避免 400。
 * 纯函数，导出供单元测试。
 */
export function injectOpenAICompatiblePromptCacheKey(
  args: Record<string, any>,
  promptCacheKey?: string,
  baseURL?: string,
): Record<string, any> {
  if (!promptCacheKey || args.prompt_cache_key) return args
  if (isNvidiaInferenceBaseURL(baseURL)) return args
  return { ...args, prompt_cache_key: promptCacheKey }
}
