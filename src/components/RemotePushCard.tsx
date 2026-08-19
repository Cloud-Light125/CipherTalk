import { useEffect, useState } from 'react'
import { Button, Chip, toast } from '@heroui/react'
import { ChevronDown, ChevronRight } from '@gravity-ui/icons'

type PushConfig = {
  configured: boolean
  keyId: string
  teamId: string
  deviceCount: number
}

/**
 * 手机推送凭据（APNs）。
 * 手机退到后台后 P2P 直连必断，只有推送能把新消息送到；通知由本机直接发往苹果，
 * 不经任何第三方推送中转，所以密钥得放在本机——这里就是填它的地方。
 */
export function RemotePushCard() {
  const [config, setConfig] = useState<PushConfig | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [keyP8, setKeyP8] = useState('')
  const [keyId, setKeyId] = useState('')
  const [teamId, setTeamId] = useState('')

  const reload = async () => {
    const result = await window.electronAPI.deviceConnect.remote.getPushConfig()
    if (!result.success) return
    setConfig({
      configured: result.configured,
      keyId: result.keyId,
      teamId: result.teamId,
      deviceCount: result.deviceCount,
    })
    setKeyId(result.keyId)
    setTeamId(result.teamId)
  }

  useEffect(() => { void reload() }, [])

  const save = async () => {
    if (!keyId.trim() || !teamId.trim()) {
      toast.danger('Key ID 和 Team ID 都要填')
      return
    }
    if (!config?.configured && !keyP8.trim()) {
      toast.danger('请粘贴 .p8 私钥内容')
      return
    }
    setBusy(true)
    // keyP8 留空表示沿用已保存的那份，不用每次都重新粘一遍
    const result = await window.electronAPI.deviceConnect.remote.setPushConfig({
      keyP8: keyP8.trim(),
      keyId: keyId.trim(),
      teamId: teamId.trim(),
    })
    setBusy(false)
    if (!result.success) {
      toast.danger(result.error || '保存失败')
      return
    }
    setKeyP8('')
    toast.success('推送密钥已保存')
    void reload()
  }

  const clear = async () => {
    setBusy(true)
    await window.electronAPI.deviceConnect.remote.clearPushConfig()
    setBusy(false)
    setKeyP8('')
    toast.success('已清除推送密钥')
    void reload()
  }

  const test = async () => {
    setBusy(true)
    const result = await window.electronAPI.deviceConnect.remote.testPush()
    setBusy(false)
    if (result.success) toast.success('已发出测试通知')
    else toast.danger(result.error || '发送失败')
  }

  return (
    <div className="rounded-xl bg-default-100 p-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown width={14} height={14} /> : <ChevronRight width={14} height={14} />}
        <span className="text-sm font-medium text-foreground">推送通知</span>
        <Chip size="sm" variant="soft" color={config?.configured ? 'success' : undefined}>
          {config?.configured
            ? config.deviceCount > 0 ? `${config.deviceCount} 台手机已登记` : '已配置，等待手机开启'
            : '未配置'}
        </Chip>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-muted">
            手机切到后台后直连会断开，新消息只能靠推送送达。通知由本机直接发往苹果推送服务，
            信令服务器和任何第三方都看不到内容。需要苹果开发者账号在后台生成一个 APNs 密钥（.p8）。
          </p>
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-default-300 bg-background px-2 py-1.5 text-sm"
              placeholder="Key ID（10 位）"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
            />
            <input
              className="min-w-0 flex-1 rounded-md border border-default-300 bg-background px-2 py-1.5 text-sm"
              placeholder="Team ID（10 位）"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            />
          </div>
          <textarea
            className="h-20 resize-none rounded-md border border-default-300 bg-background px-2 py-1.5 font-mono text-xs"
            placeholder={config?.configured
              ? '私钥已保存，留空即不修改'
              : '粘贴 .p8 文件内容，从 -----BEGIN PRIVATE KEY----- 开始'}
            value={keyP8}
            onChange={(e) => setKeyP8(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" isDisabled={busy} onPress={() => void save()}>保存</Button>
            {config?.configured && (
              <>
                <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void test()}>
                  发送测试
                </Button>
                <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void clear()}>
                  清除
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-muted">
            苹果免费开发者证书签的安装包没有推送权限，收不到通知——这种情况手机上的开关会直接说明原因。
          </p>
        </div>
      )}
    </div>
  )
}

export default RemotePushCard
