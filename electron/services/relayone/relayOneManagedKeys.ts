/**
 * RelayOne 托管密钥：登录后按固定分组自动创建的四把 Key。
 * 三把聊天分组的模型聚合进「大模型」下拉，按模型反查该用哪把 Key / 哪种协议；
 * 生图分组的 Key 自动写入作图配置。纯逻辑模块，不依赖 electron。
 */
import type { ConfigService } from '../config'

export const RELAYONE_INFERENCE_BASE_URL = 'https://aiapi.aiqji.cn/v1'

export type RelayOneManagedKind = 'cc-max' | 'plus-pool' | 'grok' | 'image'
export type RelayOneManagedProtocol = 'anthropic' | 'openai-responses' | 'openai-compatible'

export interface RelayOneManagedKeyEntry {
  kind: RelayOneManagedKind
  keyId: string
  name: string
  apiKey: string
  groupId: string
  groupName: string
  models: string[]
}

export interface RelayOneManagedKeysState {
  wxid: string
  updatedAt: number
  keys: RelayOneManagedKeyEntry[]
}

export interface RelayOneManagedGroupTarget {
  kind: RelayOneManagedKind
  /** 站点上的分组 ID，配置了就优先按 ID 匹配（分组改名也不受影响）；名字只作兜底和 Key 命名 */
  groupId?: string
  groupName: string
  protocol: RelayOneManagedProtocol
}

// 聊天分组的声明顺序即模型聚合展示与路由的优先级：同名模型归属先命中的分组。
// 匹配优先级：这里写死的 groupId → 本地配置里记住的 groupId → groupName 全等。
// groupId 取自站点 /groups/available（2026-08-25），分组改名不影响匹配。
export const RELAYONE_MANAGED_GROUPS: RelayOneManagedGroupTarget[] = [
  { kind: 'plus-pool', groupId: '3', groupName: '特惠Plus号池', protocol: 'openai-responses' },
  { kind: 'cc-max', groupId: '8', groupName: 'CC Max 满血反代', protocol: 'anthropic' },
  { kind: 'grok', groupId: '11', groupName: 'Grok', protocol: 'openai-compatible' },
  { kind: 'image', groupId: '35', groupName: 'image2生图分组', protocol: 'openai-compatible' }
]

export const RELAYONE_CHAT_KINDS: RelayOneManagedKind[] = ['plus-pool', 'cc-max', 'grok']

export function relayOneManagedKeyName(groupName: string, wxid: string): string {
  return wxid ? `CipherTalk-${groupName}-${wxid}` : `CipherTalk-${groupName}`
}

export function relayOneProtocolForKind(kind: RelayOneManagedKind): RelayOneManagedProtocol {
  return RELAYONE_MANAGED_GROUPS.find((group) => group.kind === kind)?.protocol || 'openai-compatible'
}

export function getRelayOneManagedState(configService: ConfigService): RelayOneManagedKeysState | null {
  const state = configService.get('relayOneManagedKeys')
  if (!state || !Array.isArray(state.keys) || state.keys.length === 0) return null
  return state
}

/** 三把聊天 Key，按路由优先级排序，只含已拿到密钥的 */
export function getRelayOneChatKeys(state: RelayOneManagedKeysState): RelayOneManagedKeyEntry[] {
  return RELAYONE_CHAT_KINDS
    .map((kind) => state.keys.find((entry) => entry.kind === kind))
    .filter((entry): entry is RelayOneManagedKeyEntry => Boolean(entry?.apiKey))
}

export function getRelayOneImageKey(state: RelayOneManagedKeysState): RelayOneManagedKeyEntry | undefined {
  const entry = state.keys.find((item) => item.kind === 'image')
  return entry?.apiKey ? entry : undefined
}

/** 三个聊天分组的模型聚合列表（按优先级去重，保持各分组内原始顺序） */
export function listRelayOneAggregatedModels(state: RelayOneManagedKeysState): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of getRelayOneChatKeys(state)) {
    for (const model of entry.models) {
      const identity = model.trim().toLowerCase()
      if (!identity || seen.has(identity)) continue
      seen.add(identity)
      result.push(model.trim())
    }
  }
  return result
}

/** 按模型反查该走哪把托管 Key；模型不在任何聊天分组时返回 null（走默认配置） */
export function resolveRelayOneModelRoute(
  configService: ConfigService,
  model: string
): { apiKey: string; protocol: RelayOneManagedProtocol; baseURL: string } | null {
  const identity = String(model || '').trim().toLowerCase()
  if (!identity) return null
  const state = getRelayOneManagedState(configService)
  if (!state) return null
  for (const entry of getRelayOneChatKeys(state)) {
    if (entry.models.some((item) => item.trim().toLowerCase() === identity)) {
      return {
        apiKey: entry.apiKey,
        protocol: relayOneProtocolForKind(entry.kind),
        baseURL: RELAYONE_INFERENCE_BASE_URL
      }
    }
  }
  return null
}
