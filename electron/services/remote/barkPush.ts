/**
 * Bark 推送通道：给没有付费苹果开发者账号的用户用的免费方案。
 *
 * 原理：Bark（github.com/Finb/Bark）是上架 App Store 的开源通知 App，
 * 它自带 APNs 证书。本机把通知 POST 给 Bark 服务器（官方 api.day.app 或自建
 * bark-server），Bark 负责经 APNs 送达手机。我们的 App 不需要任何推送权限。
 *
 * 隐私：配了加密密钥时，整个推送参数 JSON 用 AES-CBC 加密后只发密文，
 * Bark 服务器和苹果都解不开——密钥只在这台电脑和手机上的 Bark App 里。
 * 没配密钥则明文经 Bark 服务器中转，界面上要把这点讲清楚，让用户自己选。
 *
 * 点通知跳回密语：把 ciphertalk:// 深链放进 url 参数，Bark 点按时会打开它。
 */
import { randomBytes, createCipheriv } from 'crypto'

export type BarkConfig = {
  /** 设备推送地址，如 https://api.day.app/<device_key>，Bark App 首页可复制 */
  url: string
  /** AES 密钥，16/24/32 字符对应 AES-128/192/256-CBC；留空则明文推送 */
  key: string
}

export type BarkMessage = {
  title: string
  body: string
  /** 手机端路由，如 /chat/12；转成 ciphertalk:// 深链放进 url 参数 */
  route?: string
  /** 通知分组：同组的通知在通知中心折叠到一起，如「微信消息」「AI 助手」 */
  group?: string
}

/** 通知图标，由信令 Worker 伺服（iOS 15+ 生效）；本项目自己的域名，不引入新的第三方 */
const ICON_URL = 'https://ctapp.aiqji.com/icon.png'

function deepLink(route?: string): string | undefined {
  if (!route || !route.startsWith('/')) return undefined
  return `ciphertalk:/${route}`
}

/** Bark 要求 iv 是 16 字节字符串，随密文一起明文传（iv 本来就不是秘密） */
function randomIv(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(randomBytes(16), (byte) => alphabet[byte % alphabet.length]).join('')
}

function algorithmFor(key: string): string | null {
  if (key.length === 16) return 'aes-128-cbc'
  if (key.length === 24) return 'aes-192-cbc'
  if (key.length === 32) return 'aes-256-cbc'
  return null
}

export function isValidBarkKey(key: string): boolean {
  return key === '' || algorithmFor(key) !== null
}

export async function sendBarkMessage(
  config: BarkConfig,
  message: BarkMessage
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const base = config.url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) return { ok: false, reason: '未配置 Bark 推送地址' }

  // 这些参数要么整体加密、要么整体明文，加密时 icon/sound/group 也都在密文里
  const payload: Record<string, string> = {
    title: message.title,
    body: message.body,
    group: message.group || '密语',
    sound: 'glass',
    icon: ICON_URL,
    // timeSensitive：立即亮屏横幅提醒，并穿透专注模式和 iOS 的「定时推送摘要」。
    // 不设的话通知常被摘要攒着延后弹，看起来就是「静默进了列表、没有横幅没有声音」
    level: 'timeSensitive',
  }
  const link = deepLink(message.route)
  if (link) payload.url = link

  let body: string
  if (config.key) {
    const algorithm = algorithmFor(config.key)
    if (!algorithm) return { ok: false, reason: 'Bark 加密密钥必须是 16/24/32 个字符' }
    const iv = randomIv()
    const cipher = createCipheriv(algorithm, Buffer.from(config.key, 'utf8'), Buffer.from(iv, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64')
    body = new URLSearchParams({ ciphertext, iv }).toString()
  } else {
    body = new URLSearchParams(payload).toString()
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!response.ok) return { ok: false, reason: `Bark 服务器返回 HTTP ${response.status}` }
    const result = await response.json().catch(() => null) as { code?: number; message?: string } | null
    if (result && result.code !== 200) return { ok: false, reason: result.message || `Bark 返回 code ${result.code}` }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
