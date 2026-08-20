import { useEffect, useState } from 'react'
import { Button, Chip, Modal, toast } from '@heroui/react'

type PushConfig = {
  configured: boolean
  keyId: string
  teamId: string
  deviceCount: number
  barkUrl: string
  barkEncrypted: boolean
}

/**
 * 手机推送设置弹窗。两条通道：Bark（免费）/ APNs 密钥（需付费开发者账号）。
 * 从「密语 App」配对弹窗里的按钮打开，独立成一个对话框，别把配对界面挤成一锅粥。
 */
export function RemotePushDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [config, setConfig] = useState<PushConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [barkUrl, setBarkUrl] = useState('')
  const [barkKey, setBarkKey] = useState('')
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
      barkUrl: result.barkUrl,
      barkEncrypted: result.barkEncrypted,
    })
    setKeyId(result.keyId)
    setTeamId(result.teamId)
    setBarkUrl(result.barkUrl)
  }

  useEffect(() => {
    if (isOpen) void reload()
  }, [isOpen])

  const saveBark = async () => {
    setBusy(true)
    // 已配置加密且密钥框为空 = 保持原密钥；显式清空要先清地址
    const result = await window.electronAPI.deviceConnect.remote.setBarkConfig({
      url: barkUrl.trim(),
      key: barkKey.trim() || (config?.barkEncrypted && barkUrl.trim() ? undefined : ''),
    })
    setBusy(false)
    if (!result.success) {
      toast.danger(result.error || '保存失败')
      return
    }
    setBarkKey('')
    toast.success(barkUrl.trim() ? 'Bark 推送已保存' : '已清除 Bark 配置')
    void reload()
  }

  const saveApns = async () => {
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
    toast.success('APNs 密钥已保存')
    void reload()
  }

  const clearApns = async () => {
    setBusy(true)
    await window.electronAPI.deviceConnect.remote.clearPushConfig()
    setBusy(false)
    setKeyP8('')
    toast.success('已清除 APNs 密钥')
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
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>推送通知</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-3 pb-2">
                <p className="text-xs text-muted">
                  手机切到后台后直连会断开，新消息只能靠推送送达。两条通道任选其一，都配则同时发。
                </p>

                <div className="flex flex-col gap-2 rounded-xl bg-default-100 p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">方式一：Bark（免费，推荐）</span>
                    {config?.barkUrl && (
                      <Chip size="sm" variant="soft" color="success">
                        {config.barkEncrypted ? '已启用 · 加密' : '已启用'}
                      </Chip>
                    )}
                  </div>
                  <p className="text-xs text-muted">
                    手机装免费开源的 Bark App，把它首页的推送地址粘到下面。填了加密密钥（16/24/32 位，
                    Bark App 的「推送加密」里填同一个）后内容全程只传密文，Bark 服务器和苹果都看不到。
                  </p>
                  <input
                    className="rounded-md border border-default-300 bg-background px-2 py-1.5 text-sm"
                    placeholder="https://api.day.app/xxxxxxxx（Bark App 首页复制）"
                    value={barkUrl}
                    onChange={(e) => setBarkUrl(e.target.value)}
                  />
                  <input
                    className="rounded-md border border-default-300 bg-background px-2 py-1.5 font-mono text-sm"
                    placeholder={config?.barkEncrypted ? '加密密钥已保存，留空即不修改' : '加密密钥（可选，16/24/32 个字符）'}
                    value={barkKey}
                    onChange={(e) => setBarkKey(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" isDisabled={busy} onPress={() => void saveBark()}>保存</Button>
                    {config?.barkUrl && (
                      <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void test()}>
                        发送测试
                      </Button>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2 rounded-xl bg-default-100 p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">方式二：APNs 密钥（需付费开发者账号）</span>
                    {config?.configured && (
                      <Chip size="sm" variant="soft" color="success">
                        {config.deviceCount > 0 ? `${config.deviceCount} 台手机已登记` : '已配置，等待手机开启'}
                      </Chip>
                    )}
                  </div>
                  <p className="text-xs text-muted">
                    通知由本机直接发往苹果，链路上没有任何第三方。需要苹果开发者账号在后台生成
                    APNs 密钥（.p8），且安装包必须用该账号的证书签名——免费侧载证书不行，请用方式一。
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
                    <Button size="sm" isDisabled={busy} onPress={() => void saveApns()}>保存</Button>
                    {config?.configured && (
                      <>
                        <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void test()}>
                          发送测试
                        </Button>
                        <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void clearApns()}>
                          清除
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default RemotePushDialog
