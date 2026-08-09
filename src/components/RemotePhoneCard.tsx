import { useEffect, useState } from 'react'
import { Button, Chip, Spinner, toast } from '@heroui/react'

type RemoteDeviceSummary = {
  id: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

type RemoteInfo = {
  enabled: boolean
  running: boolean
  connected: boolean
  signaling: string
  pairingId: string
  qrPayload: string
  qrImage: string
  fingerprint: string
  candidateKinds: string[]
  lanUrls: string[]
  hasPassword: boolean
  deviceCount: number
  locked: boolean
}

const PHONE_ICON_SRC = './logo.png'

/**
 * 设备连接弹窗里的「手机遥控」卡片：开关网关 + 展示配对二维码。
 * 二维码内容只有信令地址和配对码（身份），不含地址——IPv6 会变，地址每次连接经信令现取。
 */
export function RemotePhoneCard() {
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [devices, setDevices] = useState<RemoteDeviceSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [pwInput, setPwInput] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwError, setPwError] = useState('')

  // 卡片显示期间才允许新手机配对：关掉弹窗就关闸（同时后端重新上锁），
  // 被吊销的手机没法自己配回来
  useEffect(() => {
    const api = window.electronAPI.deviceConnect.remote
    void api.setPairingOpen(true).catch(() => undefined)
    return () => { void api.setPairingOpen(false).catch(() => undefined) }
  }, [])

  useEffect(() => {
    const api = window.electronAPI.deviceConnect.remote
    let mounted = true
    let latestConnected: boolean | null = null
    let latestInfo: RemoteInfo | null = null

    const refresh = () => {
      api.getInfo()
        .then((next) => {
          if (!mounted) return
          const merged = latestConnected === null ? next : { ...next, connected: latestConnected }
          latestInfo = merged
          setInfo(merged)
        })
        .catch(() => undefined)
    }

    api.listDevices()
      .then((res) => { if (mounted && res.success) setDevices(res.devices) })
      .catch(() => undefined)
    refresh()

    const offStatus = api.onStatus(({ connected }) => {
      latestConnected = connected
      if (connected) {
        setShowCode(false)
        // 刚配上的新手机要立刻出现在列表里
        api.listDevices().then((res) => { if (res.success) setDevices(res.devices) }).catch(() => undefined)
      }
      setInfo((current) => current ? { ...current, connected } : current)
    })

    // 二维码要等桥接页上报指纹、本机地址要等候选自测，都是异步的。
    // 只在打开时取一次的话，开得快就只剩一个转圈，所以补齐之前每 2 秒重取。
    const timer = setInterval(() => {
      if (!latestInfo?.running) return
      if (latestInfo.qrImage && latestInfo.candidateKinds.length > 0) return
      refresh()
    }, 2000)

    return () => { mounted = false; clearInterval(timer); offStatus() }
  }, [])

  const toggle = async () => {
    if (!info) return
    setBusy(true)
    try {
      const res = await window.electronAPI.deviceConnect.remote.setEnabled(!info.enabled)
      if (!res.success) {
        toast.danger(res.error || '操作失败')
        return
      }
      if (res.info) setInfo(res.info)
      toast.success(info.enabled ? '已关闭手机遥控' : '手机遥控已开启')
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    setBusy(true)
    try {
      const res = await window.electronAPI.deviceConnect.remote.rotatePairing()
      setInfo(res.info)
      toast.success('配对码已更换，已配对的手机需重新扫码')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string | undefined, label: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`已复制${label}`)
    } catch {
      toast.danger('复制失败')
    }
  }

  const submitPassword = async () => {
    setPwError('')
    if (pwInput.length < 4) { setPwError('密码至少 4 位'); return }
    if (pwInput !== pwConfirm) { setPwError('两次输入不一致'); return }
    setBusy(true)
    try {
      const res = await window.electronAPI.deviceConnect.remote.setPassword({ password: pwInput })
      if (!res.success) { setPwError(res.error || '设置失败'); return }
      if (res.info) setInfo(res.info)
      setPwInput(''); setPwConfirm('')
      toast.success('密码已设置')
    } finally {
      setBusy(false)
    }
  }

  const submitUnlock = async () => {
    setPwError('')
    setBusy(true)
    try {
      const res = await window.electronAPI.deviceConnect.remote.unlock(pwInput)
      if (!res.success) { setPwError(res.error || '密码不正确'); return }
      if (res.info) setInfo(res.info)
      setPwInput('')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (device: RemoteDeviceSummary) => {
    setBusy(true)
    try {
      const res = await window.electronAPI.deviceConnect.remote.revokeDevice(device.id)
      if (res.success) {
        setDevices(res.devices)
        toast.success(`已吊销「${device.name}」`)
      }
    } finally {
      setBusy(false)
    }
  }

  const running = info?.running === true
  const connected = info?.connected === true
  // 绑定关系和「当前是否在线」是两回事：手机切后台会断连，绑定还在
  const bound = (info?.deviceCount ?? 0) > 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="flex size-12 shrink-0 items-center justify-center p-1">
          <img src={PHONE_ICON_SRC} alt="手机遥控" className="h-full w-full object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold text-foreground">手机遥控</span>
            <Chip size="sm" variant="soft" color={connected ? 'success' : undefined}>
              {connected ? '已连接' : !running ? '未开启' : bound ? '已绑定' : '等待配对'}
            </Chip>
          </div>
          <p className="mt-1 text-sm text-muted">
            {connected
              ? '手机已连接，可远程使用 AI 助手和克隆功能'
              : !running
                ? '开启后可用手机远程控制 AI 助手和克隆功能'
                : bound
                  // 手机切到后台会断开，但绑定关系还在，不需要重新扫码
                  ? '手机不在线，回到 App 会自动重连'
                  : '用手机 App 扫码配对，远程使用 AI 助手'}
          </p>
        </div>
      </div>

      {running && !info?.hasPassword && (
        <div className="flex flex-col gap-2 rounded-lg bg-default-100 p-3">
          <p className="text-sm text-foreground">先设置一个查看密码</p>
          <p className="text-xs text-muted">
            之后要新增手机、查看配对二维码都需要它。密码只存哈希，忘了只能重设。
          </p>
          <input
            type="password"
            className="rounded-md border border-default-300 bg-background px-2 py-1.5 text-sm"
            placeholder="设置密码（至少 4 位）"
            value={pwInput}
            onChange={(e) => setPwInput(e.target.value)}
          />
          <input
            type="password"
            className="rounded-md border border-default-300 bg-background px-2 py-1.5 text-sm"
            placeholder="再输一次"
            value={pwConfirm}
            onChange={(e) => setPwConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitPassword() }}
          />
          {pwError ? <p className="text-xs text-danger">{pwError}</p> : null}
          <Button size="sm" isDisabled={busy} onPress={() => void submitPassword()}>保存密码</Button>
        </div>
      )}

      {running && info?.locked && (
        <div className="flex flex-col gap-2 rounded-lg bg-default-100 p-3">
          <p className="text-sm text-foreground">
            已绑定 {info.deviceCount} 台手机{connected ? '，当前在线' : '，手机不在线时也保持绑定'}
          </p>
          <p className="text-xs text-muted">要新增手机或查看二维码，请输入查看密码</p>
          <input
            type="password"
            className="rounded-md border border-default-300 bg-background px-2 py-1.5 text-sm"
            placeholder="查看密码"
            value={pwInput}
            onChange={(e) => setPwInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitUnlock() }}
          />
          {pwError ? <p className="text-xs text-danger">{pwError}</p> : null}
          <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void submitUnlock()}>
            解锁查看二维码
          </Button>
        </div>
      )}

      {running && info?.hasPassword && !info.locked && (
        <div className="flex flex-col items-center gap-3 py-1">
          <div className="relative flex size-60 items-center justify-center rounded-xl bg-white">
            {info?.qrImage
              ? <img src={info.qrImage} alt="手机配对二维码" className="size-60 rounded-xl" />
              : <Spinner />}
          </div>
          <p className="text-sm text-muted">用密语手机 App 扫描二维码完成配对</p>

          {showCode ? (
            <div className="w-full rounded-lg bg-default-100 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs text-muted">配对码</p>
                <Button size="sm" variant="ghost" onPress={() => void copy(info?.pairingId, '配对码')}>复制</Button>
              </div>
              <p className="mb-3 break-all font-mono text-xs text-foreground">{info?.pairingId}</p>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs text-muted">身份指纹（必填，防信令服务器冒充）</p>
                <Button size="sm" variant="ghost" onPress={() => void copy(info?.fingerprint, '身份指纹')}>复制</Button>
              </div>
              <p className="break-all font-mono text-xs text-foreground">{info?.fingerprint}</p>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onPress={() => setShowCode(true)}>
              没法扫码？手动输入
            </Button>
          )}
        </div>
      )}

      {running && devices.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted">已配对手机</p>
          {devices.map((device) => (
            <div key={device.id} className="flex items-center gap-2 rounded-lg bg-default-100 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{device.name}</p>
                <p className="text-xs text-muted">
                  最近连接 {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString('zh-CN') : '—'}
                </p>
              </div>
              <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void revoke(device)}>
                吊销
              </Button>
            </div>
          ))}
        </div>
      )}

      {running && info && info.candidateKinds.length > 0 && (
        <div className="rounded-lg bg-default-100 px-3 py-2">
          <p className="mb-1 text-xs text-muted">本机地址</p>
          {info.candidateKinds.map((kind) => (
            <p key={kind} className="break-all font-mono text-xs text-foreground">{kind}</p>
          ))}
          {!info.candidateKinds.some((k) => k.startsWith('IPv6')) && (
            <p className="mt-1 text-xs text-warning">
              没有 IPv6 地址，手机用流量可能连不上（本机或路由器没有公网 IPv6）
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          variant={running ? 'tertiary' : 'primary'}
          fullWidth
          isDisabled={busy || !info}
          onPress={toggle}
        >
          {running ? '关闭手机遥控' : '开启手机遥控'}
        </Button>
        {running && (
          <Button variant="tertiary" isDisabled={busy} onPress={rotate}>
            换配对码
          </Button>
        )}
      </div>
    </div>
  )
}

export default RemotePhoneCard
