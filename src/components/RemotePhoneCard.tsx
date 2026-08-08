import { useEffect, useState } from 'react'
import { Button, Chip, Spinner, toast } from '@heroui/react'

type RemoteInfo = {
  enabled: boolean
  running: boolean
  signaling: string
  pairingId: string
  qrPayload: string
  qrImage: string
  lanUrls: string[]
}

const PHONE_ICON_SRC = './logo.png'

/**
 * 设备连接弹窗里的「手机遥控」卡片：开关网关 + 展示配对二维码。
 * 二维码内容只有信令地址和配对码（身份），不含地址——IPv6 会变，地址每次连接经信令现取。
 */
export function RemotePhoneCard() {
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [showCode, setShowCode] = useState(false)

  useEffect(() => {
    window.electronAPI.deviceConnect.remote.getInfo()
      .then(setInfo)
      .catch(() => undefined)
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

  const running = info?.running === true

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="flex size-12 shrink-0 items-center justify-center p-1">
          <img src={PHONE_ICON_SRC} alt="手机遥控" className="h-full w-full object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold text-foreground">手机遥控</span>
            <Chip size="sm" variant="soft" color={running ? 'success' : undefined}>
              {running ? '已开启' : '未开启'}
            </Chip>
          </div>
          <p className="mt-1 text-sm text-muted">
            {running ? '用手机 App 扫码配对，远程使用 AI 助手' : '开启后可用手机远程控制 AI 助手和克隆功能'}
          </p>
        </div>
      </div>

      {running && (
        <div className="flex flex-col items-center gap-3 py-1">
          <div className="relative flex size-60 items-center justify-center rounded-xl bg-white">
            {info?.qrImage
              ? <img src={info.qrImage} alt="手机配对二维码" className="size-60 rounded-xl" />
              : <Spinner />}
          </div>
          <p className="text-sm text-muted">用密语手机 App 扫描二维码完成配对</p>

          {showCode ? (
            <div className="w-full rounded-lg bg-default-100 p-3">
              <p className="text-xs text-muted">信令地址</p>
              <p className="mb-2 break-all font-mono text-xs text-foreground">{info?.signaling}</p>
              <p className="text-xs text-muted">配对码</p>
              <p className="break-all font-mono text-xs text-foreground">{info?.pairingId}</p>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onPress={() => setShowCode(true)}>
              没法扫码？手动输入
            </Button>
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
