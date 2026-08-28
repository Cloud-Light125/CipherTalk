/**
 * 手机推送：登记令牌 + 在手机断开时把通知发过去。
 *
 * 只有一条通道：信令 Worker 中转（relayPush.ts）。用户零配置——手机开一次
 * 通知开关即可；内容用手机配对时交来的密钥端到端加密，中转只见密文。
 *
 * 推送令牌挂在 remoteDevices 里对应的那台设备上，而不是单独存一张表——
 * 这样「吊销设备」自然就把推送一起吊销了，不会出现手机被踢了还在收通知。
 */
import type { ConfigService } from '../config'
import { agentRpcHandlers } from './agentRpcRegistry'
import { sendRelayMessage } from './relayPush'

type PushLogger = {
  info(category: string, message: string, data?: any): void
  warn(category: string, message: string, data?: any): void
} | null

let configRef: ConfigService | null = null
let logger: PushLogger = null

/** 把某台设备的推送令牌抹掉（令牌失效或用户关掉开关） */
function clearPushToken(match: (device: { token: string; pushToken?: string }) => boolean): void {
  const devices = configRef?.get('remoteDevices') ?? []
  let changed = false
  const next = devices.map((device) => {
    if (!match(device)) return device
    changed = true
    const { pushToken: _t, pushPlatform: _p, pushBundleId: _b, pushKey: _k, ...rest } = device
    return rest
  })
  if (changed) configRef?.set('remoteDevices', next)
}

export function registerRemotePushHandlers(configService: ConfigService, log: PushLogger): void {
  configRef = configService
  logger = log

  agentRpcHandlers.set('push:register', (_event, payload?: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const deviceToken = String(input.deviceToken || '')
    const pushToken = String(input.token || '')
    const platform = String(input.platform || '')
    const bundleId = String(input.bundleId || '')

    if (!deviceToken || !pushToken) return { success: false, error: '缺少设备令牌或推送令牌' }
    if (platform !== 'ios') {
      // Android 要走 FCM，是另一套凭据和另一套协议，目前没实现
      return { success: false, error: '电脑端目前只支持 iOS 推送' }
    }

    const devices = configService.get('remoteDevices') ?? []
    const index = devices.findIndex((device) => device.token === deviceToken)
    if (index < 0) return { success: false, error: '设备未配对或已被吊销' }

    // pushKey 是手机生成的端到端加密密钥，经 DataChannel（DTLS）送来，不过信令服务器。
    // 老版本 App 不带它——降级为通用文案推送，别把这条注册拒了
    const pushKey = String(input.pushKey || '')
    const next = [...devices]
    next[index] = { ...next[index], pushToken, pushPlatform: platform, pushBundleId: bundleId, pushKey }
    configService.set('remoteDevices', next)
    logger?.warn('RemotePush', '已登记推送令牌', { device: next[index].name, e2e: Boolean(pushKey) })
    return { success: true }
  })

  // 手机端「设置 → 通知」里的测试按钮：让本机经真实推送链路发一条回去。
  // delayMs 给用户留出锁屏时间——前台收通知走 App 内的呈现逻辑，
  // 锁屏收才是系统原生的横幅+声音路径，测试横幅必须锁屏收
  agentRpcHandlers.set('push:test', (_event, payload?: unknown) => {
    if (!hasPushTargets()) return { success: false, error: '本机还没有登记任何推送令牌，先开一次通知开关' }
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const delayMs = Math.min(Math.max(Number(input.delayMs) || 0, 0), 15000)
    setTimeout(() => {
      void pushToRemoteDevices({ title: '密语', body: '推送已连通，这是一条测试通知。', group: '测试' })
    }, delayMs)
    return { success: true }
  })

  agentRpcHandlers.set('push:unregister', (_event, payload?: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const pushToken = String(input.token || '')
    if (!pushToken) return { success: false, error: '缺少推送令牌' }
    clearPushToken((device) => device.pushToken === pushToken)
    return { success: true }
  })
}

/**
 * 给所有登记过推送的手机发一条通知。
 * 调用方负责判断「该不该发」——本函数不检查手机在不在线。
 */
export async function pushToRemoteDevices(input: {
  title: string
  body: string
  /** 点通知后手机跳到哪，形如 /chat/12 */
  route?: string
  /** 通知分组（APNs thread-id），同组折叠 */
  group?: string
}): Promise<void> {
  const devices = (configRef?.get('remoteDevices') ?? []).filter((device) => device.pushToken)
  for (const device of devices) {
    const result = await sendRelayMessage({
      token: String(device.pushToken),
      pushKey: String(device.pushKey || ''),
      title: input.title,
      body: input.body,
      route: input.route,
      group: input.group,
    })
    if (result.ok) continue
    if (result.gone) {
      logger?.warn('RemotePush', '推送令牌已失效，已移除', { device: device.name, reason: result.reason })
      clearPushToken((item) => item.pushToken === device.pushToken)
    } else {
      logger?.warn('RemotePush', '推送发送失败', { device: device.name, reason: result.reason })
    }
  }
}

/** 有没有手机等着收通知——没有的话调用方可以整段跳过，不用白算 */
export function hasPushTargets(): boolean {
  return (configRef?.get('remoteDevices') ?? []).some((device) => device.pushToken)
}
