/**
 * 手机推送：登记令牌 + 在手机断开时把通知发过去。
 *
 * 推送令牌挂在 remoteDevices 里对应的那台设备上，而不是单独存一张表——
 * 这样「吊销设备」自然就把推送一起吊销了，不会出现手机被踢了还在收通知。
 */
import type { ConfigService } from '../config'
import { agentRpcHandlers } from './agentRpcRegistry'
import { sendApnsMessage, type ApnsCredentials } from './applePush'
import { sendBarkMessage, type BarkConfig } from './barkPush'

type PushLogger = {
  info(category: string, message: string, data?: any): void
  warn(category: string, message: string, data?: any): void
} | null

let configRef: ConfigService | null = null
let logger: PushLogger = null

function credentials(): ApnsCredentials {
  return {
    keyP8: String(configRef?.get('remoteApnsKeyP8') || ''),
    keyId: String(configRef?.get('remoteApnsKeyId') || ''),
    teamId: String(configRef?.get('remoteApnsTeamId') || ''),
  }
}

export function isApnsConfigured(): boolean {
  const { keyP8, keyId, teamId } = credentials()
  return Boolean(keyP8 && keyId && teamId)
}

function barkConfig(): BarkConfig {
  return {
    url: String(configRef?.get('remoteBarkUrl') || ''),
    key: String(configRef?.get('remoteBarkKey') || ''),
  }
}

export function isBarkConfigured(): boolean {
  return Boolean(barkConfig().url)
}

/** 把某台设备的推送令牌抹掉（令牌失效或用户关掉开关） */
function clearPushToken(match: (device: { token: string; pushToken?: string }) => boolean): void {
  const devices = configRef?.get('remoteDevices') ?? []
  let changed = false
  const next = devices.map((device) => {
    if (!match(device)) return device
    changed = true
    const { pushToken: _t, pushPlatform: _p, pushBundleId: _b, ...rest } = device
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
    if (!isApnsConfigured()) {
      return {
        success: false,
        error: isBarkConfigured()
          ? '电脑端使用 Bark 推送，通知会发到手机上的 Bark App，无需开启此开关'
          : '电脑端还没配置推送（设置 → 连接手机 → 推送通知，可用免费的 Bark 或 APNs 密钥）',
      }
    }

    const devices = configService.get('remoteDevices') ?? []
    const index = devices.findIndex((device) => device.token === deviceToken)
    if (index < 0) return { success: false, error: '设备未配对或已被吊销' }

    const next = [...devices]
    next[index] = { ...next[index], pushToken, pushPlatform: platform, pushBundleId: bundleId }
    configService.set('remoteDevices', next)
    logger?.warn('RemotePush', '已登记推送令牌', { device: next[index].name })
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
  /** 通知分组：Bark 的 group / APNs 的 thread-id，同组折叠 */
  group?: string
}): Promise<void> {
  // Bark 通道：一台电脑对一个 Bark 地址，与设备表无关（Bark 自己就是那台手机）
  if (isBarkConfigured()) {
    const result = await sendBarkMessage(barkConfig(), input)
    if (result.ok) logger?.warn('RemotePush', 'Bark 推送已发出', { title: input.title, group: input.group || '' })
    else logger?.warn('RemotePush', 'Bark 推送失败', { reason: result.reason })
  }

  const devices = (configRef?.get('remoteDevices') ?? []).filter((device) => device.pushToken)
  if (devices.length === 0 || !isApnsConfigured()) return

  const creds = credentials()
  for (const device of devices) {
    const result = await sendApnsMessage(creds, {
      token: String(device.pushToken),
      bundleId: String(device.pushBundleId || ''),
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
  if (isBarkConfigured()) return true
  return isApnsConfigured() && (configRef?.get('remoteDevices') ?? []).some((device) => device.pushToken)
}
