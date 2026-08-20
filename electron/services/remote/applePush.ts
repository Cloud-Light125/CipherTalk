/**
 * APNs 直连客户端：本机拿 .p8 私钥自己签 JWT，HTTP/2 直接打苹果推送网关。
 *
 * 不走 Expo / FCM 之类的中转，是为了跟整个手机遥控的原则一致——信令服务器只交换
 * 地址、不碰业务数据，通知内容当然也不该过第三方的服务器。代价是这里要自己实现
 * ES256 JWT 和 HTTP/2 请求，好在 Node 内置的 crypto/http2 都够用，不引依赖。
 *
 * 本模块不 import electron，保持和 remote/ 下其他文件一致，可脱离 Electron 测试。
 */
import { connect, constants, type ClientHttp2Session } from 'http2'
import { createPrivateKey, sign } from 'crypto'

const PRODUCTION_HOST = 'https://api.push.apple.com'
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com'
/** 苹果要求鉴权 JWT 至少 20 分钟才能换一次、最多 60 分钟必须换，取中间值 */
const TOKEN_TTL_MS = 45 * 60 * 1000

export type ApnsCredentials = {
  /** .p8 文件的完整内容（含 BEGIN PRIVATE KEY 那两行） */
  keyP8: string
  keyId: string
  teamId: string
}

export type ApnsMessage = {
  /** 十六进制 device token */
  token: string
  /** apns-topic，就是手机 App 的 bundle id */
  bundleId: string
  title: string
  body: string
  /** 点通知后手机要跳转到哪，形如 /chat/12 */
  route?: string
  /** 通知分组，进 aps thread-id；同组折叠到一起 */
  group?: string
}

export type ApnsResult =
  | { ok: true }
  /** 令牌已失效（换设备、卸载重装），调用方应该把它从配置里删掉 */
  | { ok: false; gone: true; reason: string }
  | { ok: false; gone: false; reason: string }

/**
 * 同一个 device token 只在一个环境（开发证书=sandbox / 发布证书=production）有效，
 * 而手机端拿不到自己被签成了哪种。所以第一次两个都试，试通了记下来，之后直连。
 * 这比让用户在设置里手动选环境靠谱——选错的表现是「令牌有效但收不到」，最难查。
 */
const hostByToken = new Map<string, string>()
const sessions = new Map<string, ClientHttp2Session>()
let cachedJwt = { value: '', keyId: '', issuedAt: 0 }

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function buildJwt(credentials: ApnsCredentials): string {
  const now = Date.now()
  if (cachedJwt.value && cachedJwt.keyId === credentials.keyId && now - cachedJwt.issuedAt < TOKEN_TTL_MS) {
    return cachedJwt.value
  }
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }))
  const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(now / 1000) }))
  const input = `${header}.${claims}`
  // ES256 要的是 JOSE 的 r||s 定长格式，不是 OpenSSL 默认的 DER；
  // dsaEncoding 不写的话签出来苹果一律回 403 InvalidProviderToken
  const signature = sign('sha256', Buffer.from(input), {
    key: createPrivateKey(credentials.keyP8),
    dsaEncoding: 'ieee-p1363',
  })
  cachedJwt = { value: `${input}.${base64url(signature)}`, keyId: credentials.keyId, issuedAt: now }
  return cachedJwt.value
}

function getSession(host: string): ClientHttp2Session {
  const existing = sessions.get(host)
  if (existing && !existing.closed && !existing.destroyed) return existing
  const session = connect(host)
  // 不加这两个的话，苹果单方面 GOAWAY 时会抛出未捕获异常直接崩主进程
  session.on('error', () => sessions.delete(host))
  session.on('close', () => sessions.delete(host))
  sessions.set(host, session)
  return session
}

function post(host: string, message: ApnsMessage, jwt: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let stream: ReturnType<ClientHttp2Session['request']>
    try {
      stream = getSession(host).request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${message.token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': message.bundleId,
        'apns-push-type': 'alert',
        // 10 = 立刻送达。任务完成/新消息本来就是要马上看到的，没必要省电
        'apns-priority': '10',
      })
    } catch (error) {
      reject(error)
      return
    }

    let status = 0
    let body = ''
    stream.setEncoding('utf8')
    stream.on('response', (headers) => { status = Number(headers[constants.HTTP2_HEADER_STATUS]) || 0 })
    stream.on('data', (chunk) => { body += chunk })
    stream.on('end', () => resolve({ status, body }))
    stream.on('error', reject)
    stream.setTimeout(10_000, () => {
      stream.close()
      reject(new Error('APNs 请求超时'))
    })

    stream.end(JSON.stringify({
      aps: {
        alert: { title: message.title, body: message.body },
        sound: 'default',
        ...(message.group ? { 'thread-id': message.group } : {}),
      },
      ...(message.route ? { route: message.route } : {}),
    }))
  })
}

function reasonOf(body: string): string {
  try {
    return String((JSON.parse(body) as { reason?: string }).reason || '')
  } catch {
    return ''
  }
}

/** 令牌本身作废了，留着也没用，反过来还会一直报错 */
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'])

export async function sendApnsMessage(
  credentials: ApnsCredentials,
  message: ApnsMessage
): Promise<ApnsResult> {
  if (!credentials.keyP8 || !credentials.keyId || !credentials.teamId) {
    return { ok: false, gone: false, reason: '未配置 APNs 推送密钥' }
  }
  if (!message.token || !message.bundleId) {
    return { ok: false, gone: false, reason: '缺少推送令牌或 bundle id' }
  }

  let jwt = ''
  try {
    jwt = buildJwt(credentials)
  } catch (error) {
    return { ok: false, gone: false, reason: `推送密钥无效：${error instanceof Error ? error.message : String(error)}` }
  }

  const known = hostByToken.get(message.token)
  const hosts = known ? [known] : [PRODUCTION_HOST, SANDBOX_HOST]
  let lastReason = ''

  for (const host of hosts) {
    let response: { status: number; body: string }
    try {
      response = await post(host, message, jwt)
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
      continue
    }

    if (response.status === 200) {
      hostByToken.set(message.token, host)
      return { ok: true }
    }

    const reason = reasonOf(response.body) || `HTTP ${response.status}`
    lastReason = reason
    // BadDeviceToken 在这里往往不是「令牌坏了」，而是「打错了环境」——
    // 所以只有两个环境都试完才认定它真的失效
    if (reason === 'BadDeviceToken' && !known && host !== hosts[hosts.length - 1]) continue
    if (GONE_REASONS.has(reason)) {
      hostByToken.delete(message.token)
      return { ok: false, gone: true, reason }
    }
    // 密钥/权限类错误换个环境也一样，不用重试
    if (response.status === 403) return { ok: false, gone: false, reason }
  }

  return { ok: false, gone: false, reason: lastReason || '推送失败' }
}

/** App 退出时收干净，别留着半开的 HTTP/2 连接 */
export function closeApnsSessions(): void {
  for (const session of sessions.values()) {
    try { session.close() } catch { /* ignore */ }
  }
  sessions.clear()
}
