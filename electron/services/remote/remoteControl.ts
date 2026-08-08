/**
 * 手机遥控端总控：网关启停、配对信息、二维码。
 * 启动时（startup.ts）和设置页开关（deviceConnectHandlers）都走这里，避免两份启动逻辑。
 */
import { BrowserWindow } from 'electron'
import { randomBytes } from 'crypto'
import QRCode from 'qrcode'
import type { MainProcessContext } from '../../main/context'
import { remoteGatewayService } from './gateway'
import { registerRemoteCloneHandlers } from './cloneHandlers'

const DEFAULT_SIGNALING_URL = 'wss://ctapp.aiqji.com'

let bridgeWindow: BrowserWindow | null = null

export type RemoteControlInfo = {
  enabled: boolean
  running: boolean
  signaling: string
  pairingId: string
  /** 手机扫的二维码内容，同时也是 App 手动输入的依据 */
  qrPayload: string
  /** 二维码图片 data URL；未启用时为空 */
  qrImage: string
  /** 局域网直连地址（浏览器兜底用，不走 P2P） */
  lanUrls: string[]
}

function buildQrPayload(signaling: string, pairingId: string): string {
  return JSON.stringify({ v: 1, signaling, room: pairingId })
}

export async function getRemoteControlInfo(ctx: MainProcessContext): Promise<RemoteControlInfo> {
  const configService = ctx.getConfigService()
  const enabled = configService?.get('remoteGatewayEnabled') === true
  const signaling = String(configService?.get('remoteSignalingUrl') || DEFAULT_SIGNALING_URL)
  const pairingId = String(configService?.get('remotePairingId') || '')
  const running = remoteGatewayService.isRunning()
  const qrPayload = pairingId && running ? buildQrPayload(signaling, pairingId) : ''
  return {
    enabled,
    running,
    signaling,
    pairingId,
    qrPayload,
    qrImage: qrPayload
      ? await QRCode.toDataURL(qrPayload, { width: 480, margin: 1 }).catch(() => '')
      : '',
    lanUrls: running ? remoteGatewayService.getLanUrls() : [],
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

  registerRemoteCloneHandlers(configService)
  remoteGatewayService.setLogger(ctx.getLogService())
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
  bridgeWindow.on('closed', () => { bridgeWindow = null })
  void bridgeWindow.loadURL(url)
}

export function closeBridgeWindow(): void {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) bridgeWindow.destroy()
  bridgeWindow = null
}
