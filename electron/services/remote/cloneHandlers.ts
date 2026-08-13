/**
 * 远程克隆控制通道：只注册进 agentRpcHandlers（手机遥控专用），不进 ipcMain。
 * 严格白名单——绝不暴露通用 config 读写，否则配对手机能读到 API key 等全部配置。
 */
import type { ConfigService } from '../config'
import { chatService } from '../chatService'
import { agentRpcHandlers } from './agentRpcRegistry'

const DEFAULT_PAGE_SIZE = 40
const MAX_PAGE_SIZE = 100
const PAGE_CACHE_TTL_MS = 30_000

const REPLY_SUGGEST_CONFIG_KEY = 'replySuggestSessions'
const REPLY_SUGGEST_STYLES = new Set(['natural', 'short', 'formal', 'humorous', 'warm', 'likeme'])
const REPLY_SUGGEST_COUNTS = new Set([1, 2, 3, 4, 5])
/** 磁贴窗口和全自动回复都依赖桌面平台能力（Win32/CGEvent），Linux 上没有 */
const SUPPORTS_DESKTOP_ONLY = process.platform === 'win32' || process.platform === 'darwin'

/** 与渲染端 src/pages/chat/replySuggest.ts 的同名函数保持一致（那边不能跨项目 import 到主进程） */
type ReplySuggestSettings = {
  enabled: boolean
  style: string
  count: number
  deep: boolean
  tile: boolean
  autoSend: boolean
}

function normalizeReplySuggestSettings(raw: Record<string, unknown> | undefined): ReplySuggestSettings {
  const style = String(raw?.style || '')
  const count = Number(raw?.count)
  return {
    enabled: raw?.enabled === true,
    style: REPLY_SUGGEST_STYLES.has(style) ? style : 'natural',
    count: REPLY_SUGGEST_COUNTS.has(count) ? count : 3,
    deep: raw?.deep === true,
    tile: raw?.tile === true,
    autoSend: raw?.autoSend === true,
  }
}

function readSessionId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  return String((payload as Record<string, unknown>).sessionId || '').trim()
}

function readSettingsMap(configService: ConfigService): Record<string, Record<string, unknown>> {
  return (configService.get(REPLY_SUGGEST_CONFIG_KEY) ?? {}) as Record<string, Record<string, unknown>>
}

/** 只收白名单字段，手机端传什么都不会往 config 里塞野键 */
function sanitizeReplySuggestPatch(raw: unknown): Partial<ReplySuggestSettings> {
  if (!raw || typeof raw !== 'object') return {}
  const input = raw as Record<string, unknown>
  const patch: Partial<ReplySuggestSettings> = {}
  for (const key of ['enabled', 'deep', 'tile', 'autoSend'] as const) {
    if (typeof input[key] === 'boolean') patch[key] = input[key] as boolean
  }
  if (REPLY_SUGGEST_STYLES.has(String(input.style))) patch.style = String(input.style)
  if (REPLY_SUGGEST_COUNTS.has(Number(input.count))) patch.count = Number(input.count)
  return patch
}

/**
 * 桌面 ChatHeader 里的开关联动搬到这里：全自动依赖建议生成+磁贴推送，
 * 开了却不联动上游等于点了没反应。规则放主进程，两端行为一致。
 */
function applyDependencyRules(patch: Partial<ReplySuggestSettings>): Partial<ReplySuggestSettings> {
  if (patch.autoSend === true) return { ...patch, enabled: true, tile: true }
  if (patch.enabled === true) return { ...patch, tile: true }
  return patch
}

type CloneContactSummary = {
  sessionId: string
  displayName: string
  avatarUrl?: string
  updatedAt: number
  isCloned: boolean
  /** 最近联系时间，排序用（消息列表同款顺序） */
  lastContactTime: number
}

type CloneBuildProgress = {
  sessionId: string
  stage: string
  title: string
  percent: number
  detail?: string
}

type CloneBuildStatus = {
  state: 'building' | 'done' | 'error'
  progress?: CloneBuildProgress
  error?: string
  updatedAt: number
}

let pageCache: { contacts: CloneContactSummary[]; builtAt: number } | null = null
const buildInFlight = new Set<string>()
const buildStatusBySessionId = new Map<string, CloneBuildStatus>()

function normalizeInteger(value: unknown, fallback: number, max?: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const normalized = Math.max(0, Math.floor(parsed))
  return typeof max === 'number' ? Math.min(normalized, max) : normalized
}

export function registerRemoteCloneHandlers(configService: ConfigService): void {
  agentRpcHandlers.set('clone:listPersonas', async (_event, options?: unknown) => {
    try {
      const pageOptions = options && typeof options === 'object'
        ? options as Record<string, unknown>
        : null
      const offset = pageOptions ? normalizeInteger(pageOptions.offset, 0) : 0
      const limit = pageOptions
        ? Math.max(1, normalizeInteger(pageOptions.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE))
        : Number.MAX_SAFE_INTEGER
      const cacheExpired = !pageCache || Date.now() - pageCache.builtAt >= PAGE_CACHE_TTL_MS

      if (offset === 0 || cacheExpired) {
        const { personaStore } = await import('../agent/persona/personaStore')
        const personaBySessionId = new Map(personaStore.list()
          .filter((persona) => !persona.sessionId.startsWith('self:'))
          .map((persona) => [persona.sessionId, persona] as const))
        const result = await chatService.getContacts()
        if (!result.success || !Array.isArray(result.contacts)) {
          return { success: false, error: result.error || '读取联系人失败' }
        }
        pageCache = {
          contacts: result.contacts
            .filter((contact) => contact.type === 'friend')
            .map((contact) => {
              const persona = personaBySessionId.get(contact.username)
              const displayName = contact.remark?.trim()
                || contact.displayName.trim()
                || persona?.displayName?.trim()
                || contact.username
              return {
                sessionId: contact.username,
                displayName,
                avatarUrl: contact.avatarUrl,
                updatedAt: persona?.updatedAt || 0,
                isCloned: Boolean(persona),
                lastContactTime: contact.lastContactTime || 0,
              }
            })
            // 已克隆的排前面，组内按最近联系时间倒序（和消息列表一个顺序）
            .sort((a, b) =>
              Number(b.isCloned) - Number(a.isCloned)
              || b.lastContactTime - a.lastContactTime),
          builtAt: Date.now(),
        }
      }

      // 关键词过滤在缓存上做：手机端搜索传 query，避免把全量联系人拉过 DataChannel
      const query = pageOptions && typeof pageOptions.query === 'string'
        ? pageOptions.query.trim().toLowerCase()
        : ''
      const allPersonas = pageCache?.contacts ?? []
      const matched = query
        ? allPersonas.filter((persona) =>
          persona.displayName.toLowerCase().includes(query)
          || persona.sessionId.toLowerCase().includes(query))
        : allPersonas
      const personas = matched.slice(offset, offset + limit)
      const nextOffset = offset + personas.length

      return {
        success: true,
        personas,
        total: matched.length,
        nextOffset,
        hasMore: nextOffset < matched.length,
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  agentRpcHandlers.set('clone:build', async (event, payload?: unknown) => {
    const input = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : {}
    const sessionId = String(input.sessionId || '').trim()
    const displayName = String(input.displayName || '').trim() || sessionId
    if (!sessionId) return { success: false, error: '缺少联系人 ID' }
    if (buildInFlight.has(sessionId)) {
      return {
        success: false,
        inProgress: true,
        error: '该联系人正在克隆',
        progress: buildStatusBySessionId.get(sessionId)?.progress,
      }
    }

    const { personaStore } = await import('../agent/persona/personaStore')
    // force = 重新克隆：跳过已克隆短路，按最新聊天记录重建画像（personaStore 保存时覆盖）
    if (!input.force && personaStore.get(sessionId)) return { success: true, alreadyCloned: true }

    buildInFlight.add(sessionId)
    buildStatusBySessionId.set(sessionId, {
      state: 'building',
      progress: { sessionId, stage: 'indexing', title: '准备开始克隆', percent: 0 },
      updatedAt: Date.now(),
    })
    try {
      const { buildPersonaFromSession } = await import('../agent/persona/personaBuildService')
      const result = await buildPersonaFromSession({
        sessionId,
        displayName,
        onProgress: (progress) => {
          buildStatusBySessionId.set(sessionId, {
            state: progress.stage === 'error' ? 'error' : 'building',
            progress,
            error: progress.stage === 'error' ? progress.detail || progress.title : undefined,
            updatedAt: Date.now(),
          })
          if (!event.sender.isDestroyed()) event.sender.send('persona:buildProgress', progress)
        },
      })
      if (result.success) {
        pageCache = null
        buildStatusBySessionId.set(sessionId, {
          state: 'done',
          progress: { sessionId, stage: 'done', title: '克隆完成', percent: 100 },
          updatedAt: Date.now(),
        })
      } else {
        buildStatusBySessionId.set(sessionId, {
          state: 'error',
          progress: buildStatusBySessionId.get(sessionId)?.progress,
          error: result.error || '克隆失败',
          updatedAt: Date.now(),
        })
      }
      return result.success
        ? { success: true }
        : { success: false, error: result.error || '克隆失败' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      buildStatusBySessionId.set(sessionId, {
        state: 'error',
        progress: buildStatusBySessionId.get(sessionId)?.progress,
        error: message,
        updatedAt: Date.now(),
      })
      return { success: false, error: message }
    } finally {
      buildInFlight.delete(sessionId)
    }
  })

  agentRpcHandlers.set('clone:getBuildStatus', async (_event, payload?: unknown) => {
    const input = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : {}
    const sessionId = String(input.sessionId || '').trim()
    if (!sessionId) return { success: false, error: '缺少联系人 ID' }

    const current = buildStatusBySessionId.get(sessionId)
    if (current?.state === 'building' || buildInFlight.has(sessionId)) {
      return { success: true, state: 'building', progress: current?.progress }
    }

    const { personaStore } = await import('../agent/persona/personaStore')
    if (personaStore.get(sessionId)) {
      return { success: true, state: 'done', progress: current?.progress }
    }
    if (current?.state === 'error') {
      return { success: true, state: 'error', progress: current.progress, error: current.error }
    }
    return { success: true, state: 'idle' }
  })

  agentRpcHandlers.set('clone:getConfig', () => {
    try {
      return {
        success: true,
        replyTileEnabled: configService.get('replyTileEnabled') === true,
        sessions: configService.get('replySuggestSessions') ?? {},
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  agentRpcHandlers.set('clone:setTileEnabled', (_event, enabled: unknown) => {
    try {
      configService.set('replyTileEnabled', enabled === true)
      return { success: true, replyTileEnabled: enabled === true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ===== 会话级回复建议设置（手机端「克隆好友设置」页，对应桌面 ChatHeader 的灯泡菜单）=====
  agentRpcHandlers.set('clone:getSessionSettings', (_event, payload?: unknown) => {
    try {
      const sessionId = readSessionId(payload)
      if (!sessionId) return { success: false, error: '缺少联系人 ID' }
      const map = readSettingsMap(configService)
      return {
        success: true,
        settings: normalizeReplySuggestSettings(map[sessionId]),
        // 磁贴/全自动依赖桌面平台能力，手机端据此隐藏开关而不是给个点了没用的
        supportsTile: SUPPORTS_DESKTOP_ONLY,
        supportsAutoSend: SUPPORTS_DESKTOP_ONLY,
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  agentRpcHandlers.set('clone:setSessionSettings', (_event, payload?: unknown) => {
    try {
      const sessionId = readSessionId(payload)
      if (!sessionId) return { success: false, error: '缺少联系人 ID' }
      const input = payload as Record<string, unknown>
      const patch = sanitizeReplySuggestPatch(input.patch)
      if (!Object.keys(patch).length) return { success: false, error: '没有可更新的设置' }

      const map = readSettingsMap(configService)
      const next = normalizeReplySuggestSettings({
        ...normalizeReplySuggestSettings(map[sessionId]),
        ...applyDependencyRules(patch),
      })
      configService.set(REPLY_SUGGEST_CONFIG_KEY, { ...map, [sessionId]: next })
      return { success: true, settings: next }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ===== 文本/图片向量索引（对应桌面 ChatHeader 的向量化菜单）=====
  agentRpcHandlers.set('clone:getVectorStatus', async (_event, payload?: unknown) => {
    try {
      const sessionId = readSessionId(payload)
      if (!sessionId) return { success: false, error: '缺少联系人 ID' }
      const { getEmbeddingConfig } = await import('../ai/embeddingService')
      const { messageVectorService } = await import('../search/messageVectorService')
      const config = getEmbeddingConfig()
      const store = messageVectorService.getSessionVectorStoreInfo(sessionId)
      return {
        success: true,
        enabled: messageVectorService.isReady(config),
        mediaEnabled: messageVectorService.isMediaReady(config),
        count: store.count || 0,
        mediaCount: store.mediaCount || 0,
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  agentRpcHandlers.set('clone:buildVectors', async (event, payload?: unknown) => {
    try {
      const sessionId = readSessionId(payload)
      if (!sessionId) return { success: false, error: '缺少联系人 ID' }
      const rawTarget = String((payload as Record<string, unknown>).target || 'all')
      const target = rawTarget === 'text' || rawTarget === 'image' ? rawTarget : 'all'

      const { getEmbeddingConfig } = await import('../ai/embeddingService')
      const { messageVectorService } = await import('../search/messageVectorService')
      const { refreshResolvedProxyUrl } = await import('../ai/proxyFetch')
      const config = getEmbeddingConfig()
      if (!messageVectorService.isReady(config)) {
        return { success: false, error: '桌面端未启用嵌入模型（设置 → 嵌入）' }
      }
      if (target === 'image' && !messageVectorService.isMediaReady(config)) {
        return { success: false, error: '桌面端未开启图片向量化（设置 → 嵌入）' }
      }

      await refreshResolvedProxyUrl()
      const onProgress = (progress: unknown) => {
        if (!event.sender.isDestroyed()) event.sender.send('embedding:buildProgress', progress)
      }
      if (target === 'all' || target === 'text') {
        await messageVectorService.ensureSessionVectors(sessionId, config, undefined, onProgress)
      }
      if (target === 'image' || (target === 'all' && messageVectorService.isMediaReady(config))) {
        await messageVectorService.ensureSessionMediaVectors(sessionId, config, undefined, onProgress)
      }
      const store = messageVectorService.getSessionVectorStoreInfo(sessionId)
      return { success: true, count: store.count || 0, mediaCount: store.mediaCount || 0 }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
