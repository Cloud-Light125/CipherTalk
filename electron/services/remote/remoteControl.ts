/**
 * 手机遥控端总控：网关启停、配对信息、二维码。
 * 启动时（startup.ts）和设置页开关（deviceConnectHandlers）都走这里，避免两份启动逻辑。
 */
import { BrowserWindow } from 'electron'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import QRCode from 'qrcode'
import type { MainProcessContext } from '../../main/context'
import { remoteGatewayService } from './gateway'
import { registerRemoteCloneHandlers } from './cloneHandlers'
import { registerRemoteWechatHandlers } from './wechatHandlers'
import { registerRemoteVoiceHandlers } from './voiceHandlers'
import { registerRemoteAiSettingsHandlers } from './aiSettingsHandlers'
import { registerRemotePushHandlers } from './pushHandlers'
import { registerRemoteTranscribeHandlers } from './transcribeHandlers'
import { persistDetachedRun } from './detachedRun'

const DEFAULT_SIGNALING_URL = 'wss://ctapp.aiqji.com'

let bridgeWindow: BrowserWindow | null = null
/**
 * 配对窗口：只有二维码弹窗打开着才允许新手机配对。
 * 没有这道闸，"吊销设备"就是假的——被吊销的手机拿着房间号能立刻重新配一个。
 */
let pairingOpen = false
/** 本次弹窗内是否已通过密码校验。关闭弹窗即失效，不做持久化 */
let pairingUnlocked = false

export type RemoteDevice = {
  id: string
  name: string
  token: string
  pairedAt: number
  lastSeenAt: number
  /** 手机端 App 版本，握手时上报，格式与桌面端一致 */
  version?: string
}

export function setPairingOpen(open: boolean): void {
  pairingOpen = open
  // 关掉弹窗就重新上锁，下次要看二维码得再输一次密码
  if (!open) pairingUnlocked = false
}

export function unlockPairing(ctx: MainProcessContext, password: string): boolean {
  pairingUnlocked = verifyPairingPassword(ctx, password)
  return pairingUnlocked
}

/** 已绑定过设备且设了密码，未解锁前不给看二维码，也不接受新配对 */
function isPairingLocked(ctx: MainProcessContext): boolean {
  if (pairingUnlocked) return false
  if (!hasPairingPassword(ctx)) return false
  return (ctx.getConfigService()?.get('remoteDevices') ?? []).length > 0
}

// ===== 查看二维码的密码 =====
// 用 scrypt 哈希而不是加密：只需要验证不需要还原，
// 加密的话解密密钥同样存在本机，等于没上锁。
const SCRYPT_KEYLEN = 64

function hashPairingPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN)
}

export function hasPairingPassword(ctx: MainProcessContext): boolean {
  return Boolean(ctx.getConfigService()?.get('remotePairingPasswordHash'))
}

export function setPairingPassword(
  ctx: MainProcessContext,
  password: string,
  currentPassword?: string
): { success: boolean; error?: string } {
  const configService = ctx.getConfigService()
  if (!configService) return { success: false, error: '配置服务未就绪' }
  const next = String(password || '')
  if (next.length < 4) return { success: false, error: '密码至少 4 位' }
  // 已设过就必须先验旧密码，否则任何人都能直接改掉这道锁
  if (hasPairingPassword(ctx) && !verifyPairingPassword(ctx, String(currentPassword || ''))) {
    return { success: false, error: '原密码不正确' }
  }
  const salt = randomBytes(16)
  const hash = hashPairingPassword(next, salt)
  configService.set('remotePairingPasswordHash', `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`)
  return { success: true }
}

export function verifyPairingPassword(ctx: MainProcessContext, password: string): boolean {
  const stored = String(ctx.getConfigService()?.get('remotePairingPasswordHash') || '')
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = hashPairingPassword(String(password || ''), Buffer.from(saltHex, 'hex'))
  // 长度不等时 timingSafeEqual 会抛，先挡掉
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

export function listRemoteDevices(ctx: MainProcessContext): Array<Omit<RemoteDevice, 'token'>> {
  const devices = ctx.getConfigService()?.get('remoteDevices') ?? []
  // token 不出主进程，UI 不需要也不该拿到
  return devices.map(({ token: _token, ...rest }) => rest)
}

export function revokeRemoteDevice(ctx: MainProcessContext, deviceId: string): Array<Omit<RemoteDevice, 'token'>> {
  const configService = ctx.getConfigService()
  const devices = configService?.get('remoteDevices') ?? []
  configService?.set('remoteDevices', devices.filter((d) => d.id !== deviceId))
  return listRemoteDevices(ctx)
}

/** 手机连上 DataChannel 后的第一道关：验令牌，或在配对窗口内发新令牌 */
function authorizeDevice(ctx: MainProcessContext, input: { token?: string; name?: string; version?: string }) {
  const configService = ctx.getConfigService()
  if (!configService) return { ok: false, reason: 'unavailable' }
  const devices = [...(configService.get('remoteDevices') ?? [])]
  const token = String(input.token || '')

  if (token) {
    const index = devices.findIndex((d) => d.token === token)
    if (index < 0) return { ok: false, reason: 'revoked' }
    // 同时更新名字：手机上改了名要能同步过来，否则列表里永远是首次配对时的旧名
    const incomingName = String(input.name || '').trim().slice(0, 40)
    const incomingVersion = String(input.version || '').trim().slice(0, 32)
    devices[index] = {
      ...devices[index],
      name: incomingName || devices[index].name,
      version: incomingVersion || devices[index].version,
      lastSeenAt: Date.now(),
    }
    configService.set('remoteDevices', devices)
    return { ok: true, deviceToken: token, deviceName: devices[index].name }
  }

  if (!pairingOpen || isPairingLocked(ctx)) return { ok: false, reason: 'pairing-closed' }

  const device: RemoteDevice = {
    id: randomBytes(8).toString('hex'),
    name: String(input.name || '').trim().slice(0, 40) || '手机',
    token: randomBytes(24).toString('hex'),
    version: String(input.version || '').trim().slice(0, 32) || undefined,
    pairedAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  devices.push(device)
  configService.set('remoteDevices', devices)
  return { ok: true, deviceToken: device.token, deviceName: device.name }
}

export type RemoteControlInfo = {
  enabled: boolean
  running: boolean
  connected: boolean
  signaling: string
  pairingId: string
  /** 手机扫的二维码内容，同时也是 App 手动输入的依据 */
  qrPayload: string
  /** 二维码图片 data URL；未启用时为空 */
  qrImage: string
  /** 桌面端 DTLS 指纹，手动配对时手机也要填 */
  fingerprint: string
  /** 桥接页实际收集到的候选类型，诊断「流量连不上」用 */
  candidateKinds: string[]
  /** 局域网直连地址（浏览器兜底用，不走 P2P） */
  lanUrls: string[]
  /** 是否已设置查看密码 */
  hasPassword: boolean
  /** 已绑定设备数 */
  deviceCount: number
  /** 已绑定 + 设了密码 + 未解锁：此时二维码相关字段一律为空 */
  locked: boolean
}

function buildQrPayload(signaling: string, pairingId: string, fingerprint: string): string {
  return JSON.stringify({ v: 1, signaling, room: pairingId, fingerprint })
}

export async function getRemoteControlInfo(ctx: MainProcessContext): Promise<RemoteControlInfo> {
  const configService = ctx.getConfigService()
  const enabled = configService?.get('remoteGatewayEnabled') === true
  const signaling = String(configService?.get('remoteSignalingUrl') || DEFAULT_SIGNALING_URL)
  const pairingId = String(configService?.get('remotePairingId') || '')
  const running = remoteGatewayService.isRunning()
  const connected = remoteGatewayService.isRemoteConnected()
  // 指纹由桥接页启动后上报，没拿到就先不出二维码——否则手机会存下空指纹，等于没有钉扎
  const fingerprint = remoteGatewayService.getDtlsFingerprint()
  const deviceCount = (configService?.get('remoteDevices') ?? []).length
  const locked = isPairingLocked(ctx)
  // 上锁时连载荷都不下发：只在渲染层隐藏等于没锁
  const qrPayload = !locked && pairingId && running && fingerprint
    ? buildQrPayload(signaling, pairingId, fingerprint)
    : ''
  return {
    enabled,
    running,
    connected,
    signaling,
    pairingId,
    qrPayload,
    qrImage: qrPayload
      ? await QRCode.toDataURL(qrPayload, { width: 480, margin: 1 }).catch(() => '')
      : '',
    fingerprint: locked ? '' : fingerprint,
    candidateKinds: remoteGatewayService.getCandidateKinds(),
    lanUrls: running ? remoteGatewayService.getLanUrls() : [],
    hasPassword: hasPairingPassword(ctx),
    deviceCount,
    locked,
  }
}

/** 启动网关（+ 有信令地址时开桥接窗口）。已在运行则直接返回成功。 */
export async function startRemoteControl(ctx: MainProcessContext): Promise<{ success: boolean; error?: string }> {
  const configService = ctx.getConfigService()
  if (!configService) return { success: false, error: '配置服务未就绪' }

  let token = String(configService.get('remoteGatewayToken') || '')
  if (!token) {
    token = randomBytes(16).toString('hex')
    configService.set('remoteGatewayToken', token)
  }
  let pairingId = String(configService.get('remotePairingId') || '')
  if (!pairingId) {
    pairingId = randomBytes(16).toString('hex')
    configService.set('remotePairingId', pairingId)
  }

  registerRemoteCloneHandlers(configService, {
    setReplyTileEnabled: (enabled) => ctx.getWindowManager().setReplyTileEnabled(enabled),
    broadcastConfigChange: (key, value) => ctx.broadcastToWindows('config:changed', { key, value }),
  })
  registerRemoteWechatHandlers(configService)
  registerRemoteVoiceHandlers()
  registerRemoteAiSettingsHandlers(configService)
  registerRemotePushHandlers(configService, ctx.getLogService())
  registerRemoteTranscribeHandlers()
  remoteGatewayService.setLogger(ctx.getLogService())
  remoteGatewayService.setConnectionListener((connected) => {
    ctx.broadcastToWindows('deviceConnect:remote:status', { connected })
  })
  remoteGatewayService.setDeviceAuthorizer((input) => authorizeDevice(ctx, input))
  // 手机断开后任务继续跑，跑完在这里落库 + 推送
  remoteGatewayService.setDetachedRunHandler((run) => {
    void persistDetachedRun(run, ctx.getLogService())
  })
  remoteGatewayService.applySettings({
    port: Number(configService.get('remoteGatewayPort')) || 5033,
    token,
  })

  const result = await remoteGatewayService.start()
  if (!result.success) {
    ctx.getLogService()?.error('RemoteGateway', '远程网关启动失败', { error: result.error })
    return result
  }

  const signaling = String(
    process.env.CIPHERTALK_REMOTE_SIGNALING || configService.get('remoteSignalingUrl') || DEFAULT_SIGNALING_URL
  )
  const port = Number(configService.get('remoteGatewayPort')) || 5033
  openBridgeWindow(
    `http://127.0.0.1:${port}/bridge`
    + `?token=${encodeURIComponent(token)}`
    + `&signaling=${encodeURIComponent(signaling)}`
    + `&room=${encodeURIComponent(pairingId)}`
  )
  return { success: true }
}

export async function stopRemoteControl(): Promise<void> {
  closeBridgeWindow()
  await remoteGatewayService.stop()
}

/** 换配对码：旧手机立刻失效，需重新扫码 */
export async function rotatePairingId(ctx: MainProcessContext): Promise<RemoteControlInfo> {
  const configService = ctx.getConfigService()
  configService?.set('remotePairingId', randomBytes(16).toString('hex'))
  if (remoteGatewayService.isRunning()) {
    await stopRemoteControl()
    await startRemoteControl(ctx)
  }
  return await getRemoteControlInfo(ctx)
}

/** 桥接窗口：隐藏窗口跑 /bridge 页做 WebRTC answerer（纯 Web API，无 node 能力） */
function openBridgeWindow(url: string): void {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) {
    remoteGatewayService.setRemoteConnected(false)
    void bridgeWindow.loadURL(url)
    return
  }
  bridgeWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏窗口的定时器不能被节流，信令断线重连靠它
      backgroundThrottling: false,
    },
  })
  // 关掉 mDNS 混淆。默认策略下 Chromium 把 host 候选换成 xxx.local：
  // 局域网靠 mDNS 能解析所以连得上，手机换流量就解析不了，
  // 而真实的公网 IPv6 从来没被通告出去，只剩 IPv4 srflx 硬打运营商 CGNAT，必然失败。
  // 代价是把内网 IP 告诉对端——对端是用户自己已配对的手机，可以接受。
  bridgeWindow.webContents.setWebRTCIPHandlingPolicy('default_public_and_private_interfaces')
  bridgeWindow.on('closed', () => {
    bridgeWindow = null
    remoteGatewayService.setRemoteConnected(false)
  })
  bridgeWindow.webContents.on('render-process-gone', () => {
    remoteGatewayService.setRemoteConnected(false)
  })
  void bridgeWindow.loadURL(url)
}

export function closeBridgeWindow(): void {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) bridgeWindow.destroy()
  bridgeWindow = null
  remoteGatewayService.setRemoteConnected(false)
}
