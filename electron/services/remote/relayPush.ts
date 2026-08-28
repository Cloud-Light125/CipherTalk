/**
 * 推送中转客户端：通知经信令 Worker（ctapp.aiqji.com/push）转发给 APNs。
 *
 * 用户零配置——APNs 的 .p8 私钥存在 Worker 的 Cloudflare secret 里，本机不需要
 * 任何凭据。为了守住「中转不碰业务数据」的原则，通知内容在本机用**配对时手机
 * 通过 DataChannel 交来的密钥**做 AES-256-GCM 加密，中转和苹果只见密文 + 一条
 * 「你有一条新消息」的兜底文案，真实内容由手机上的 Notification Service
 * Extension 本地解密后展示。
 *
 * 手机是旧版（没有密钥模块）时降级：只发通用文案，不发会话内容。
 *
 * enc 格式（与手机端 NotificationService.swift 约定一致）：
 *   base64(12字节IV || 密文 || 16字节GCM tag)，明文是 { title, body, route, group } 的 JSON。
 *
 * 本模块不 import electron，保持和 remote/ 下其他文件一致，可脱离 Electron 测试。
 */
import { createCipheriv, randomBytes } from 'crypto'

/**
 * 同一个 Worker 的两个门口：国内 CDN（阿里云 ESA）在前，Cloudflare 直连兜底。
 * 哪个门通就记住哪个；「通」的判据是拿到了合同内的 JSON 应答——
 * Worker 返回的业务失败（如 BadDeviceToken）也算链路通，只有网络层挂了才换门。
 */
const RELAY_URLS = [
  'https://ctapp.aiqji.cn/push',
  'https://ctapp.aiqji.com/push',
]
let preferredRelay = 0

export type RelayMessage = {
  /** 十六进制 APNs device token */
  token: string
  /** base64 的 32 字节端到端密钥；空 = 手机是旧版，降级发通用文案 */
  pushKey?: string
  title: string
  body: string
  /** 点通知后手机要跳转到哪，形如 /chat/12 */
  route?: string
  /** 通知分组（APNs thread-id），同组折叠 */
  group?: string
}

export type RelayResult =
  | { ok: true }
  /** 令牌已失效（换设备、卸载重装），调用方应该把它从配置里删掉 */
  | { ok: false; gone: true; reason: string }
  | { ok: false; gone: false; reason: string }

/** token → 上次试通的 APNs 环境；带给中转能省一次网关试探 */
const envByToken = new Map<string, string>()

const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'])

/** 手机没给密钥时的兜底：不发真实内容，避免中转看到 */
const GENERIC = { title: '密语', body: '有新消息，点开查看' }

export function encryptPushPayload(pushKeyBase64: string, payload: object): string {
  const key = Buffer.from(pushKeyBase64, 'base64')
  if (key.length !== 32) throw new Error('推送加密密钥必须是 32 字节')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')
}

export async function sendRelayMessage(message: RelayMessage): Promise<RelayResult> {
  if (!message.token) return { ok: false, gone: false, reason: '缺少推送令牌' }

  const request: Record<string, unknown> = { token: message.token }
  if (message.pushKey) {
    try {
      request.enc = encryptPushPayload(message.pushKey, {
        title: message.title,
        body: message.body,
        ...(message.route ? { route: message.route } : {}),
        ...(message.group ? { group: message.group } : {}),
      })
    } catch (error) {
      return { ok: false, gone: false, reason: error instanceof Error ? error.message : String(error) }
    }
  } else {
    Object.assign(request, GENERIC, message.group ? { group: message.group } : {})
    // route 只是个会话 id，信息量可控，留着让旧版手机点通知也能跳对地方
    if (message.route) request.route = message.route
  }
  const known = envByToken.get(message.token)
  if (known) request.apnsEnv = known

  let response: Response | null = null
  let data: { success?: boolean; env?: string; error?: string } | null = null
  let lastFailure = ''
  for (const index of [preferredRelay, 1 - preferredRelay]) {
    try {
      const attempt = await fetch(RELAY_URLS[index], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      })
      const parsed = await attempt.json().catch(() => null) as typeof data
      // CDN 自身故障（525 等）没有合同内的 JSON，换下一个门口；
      // 有 success 字段说明已经到达 Worker，无论成败都不用再试另一边
      if (!parsed || typeof parsed.success !== 'boolean') {
        lastFailure = `HTTP ${attempt.status}`
        continue
      }
      response = attempt
      data = parsed
      preferredRelay = index
      break
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
  }
  if (!response) {
    return { ok: false, gone: false, reason: `推送中转不可达：${lastFailure}` }
  }

  if (response.ok && data?.success) {
    if (data.env === 'production' || data.env === 'sandbox') envByToken.set(message.token, data.env)
    return { ok: true }
  }

  const reason = String(data?.error || `HTTP ${response.status}`)
  // 环境记忆可能过期（比如手机从 TestFlight 换到开发版），清掉让下次重新试探
  envByToken.delete(message.token)
  if (GONE_REASONS.has(reason)) return { ok: false, gone: true, reason }
  return { ok: false, gone: false, reason }
}
