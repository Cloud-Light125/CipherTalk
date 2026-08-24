import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Alert,
  Button,
  Card,
  Chip,
  CloseButton,
  InputGroup,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useOverlayState,
  type Key
} from '@heroui/react'
import { ArrowUpRight, ArrowsRotateLeft, CircleCheck, PersonNutHex, QrCode } from '@gravity-ui/icons'
import { LottieView, type DotLottie } from '@/components/LottieView'
import successLottieUrl from '@/assets/lottie/Success.lottie?url'
import MiDouIcon from './MiDouIcon'
import { relayOneService } from '../../services/relayOne'
import { MIDOU_PER_CNY, formatMiDou, formatMiDouCompact, miDouToCny } from '../../lib/miDou'
import type {
  RelayOneCheckoutInfo,
  RelayOnePaymentOrder,
  RelayOnePublicSettings,
  RelayOneStatus,
  RelayOneUser
} from '../../types/relayOne'

interface RelayOneAccountPanelProps {
  onProviderApplied: () => void | Promise<void>
  showMessage: (text: string, success: boolean) => void
  hasConfiguredApiKey: boolean
  /** 账户/余额状态条挂载到接入参数卡片内的这个容器 */
  statusHost: HTMLElement | null
}

type AuthTab = 'login' | 'register'
// 充值预设，单位密豆（1 元 = 1000 密豆）
const PRESET_MIDOU_AMOUNTS = [10_000, 20_000, 30_000, 40_000, 50_000]

const EMPTY_STATUS: RelayOneStatus = {
  authenticated: false,
  hasRefreshToken: false,
  encryptionAvailable: true,
  sessionPersistent: true
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusLabel(status: RelayOnePaymentOrder['status']): string {
  const labels: Record<RelayOnePaymentOrder['status'], string> = {
    pending: '待支付',
    paid: '已支付',
    failed: '支付失败',
    cancelled: '已取消',
    expired: '已过期',
    unknown: '状态未知'
  }
  return labels[status]
}

export default function RelayOneAccountPanel({ onProviderApplied, showMessage, hasConfiguredApiKey, statusHost }: RelayOneAccountPanelProps) {
  const [status, setStatus] = useState<RelayOneStatus>(EMPTY_STATUS)
  const [publicSettings, setPublicSettings] = useState<RelayOnePublicSettings | null>(null)
  const [user, setUser] = useState<RelayOneUser | null>(null)
  const [checkoutInfo, setCheckoutInfo] = useState<RelayOneCheckoutInfo | null>(null)
  const [order, setOrder] = useState<RelayOnePaymentOrder | null>(null)
  const [authTab, setAuthTab] = useState<AuthTab>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [verificationCountdown, setVerificationCountdown] = useState(0)
  const [promoCode, setPromoCode] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [requiresTwoFactor, setRequiresTwoFactor] = useState(false)
  const [rechargeAmount, setRechargeAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState('')
  const [error, setError] = useState('')
  const [accountModalOpen, setAccountModalOpen] = useState(false)
  const accountModalState = useOverlayState({
    isOpen: accountModalOpen,
    onOpenChange: setAccountModalOpen
  })
  // 充值到账的庆祝动画：播完一遍 → 缩小淡出退场 → 移除（同数字分身克隆完成）
  const [celebration, setCelebration] = useState<'hidden' | 'playing' | 'leaving'>('hidden')
  const handleSuccessLottieRef = useCallback((instance: DotLottie | null) => {
    instance?.addEventListener('complete', () => setCelebration('leaving'))
  }, [])
  useEffect(() => {
    if (celebration !== 'leaving') return
    const timer = window.setTimeout(() => setCelebration('hidden'), 350)
    return () => window.clearTimeout(timer)
  }, [celebration])

  const activePaymentMethods = useMemo(
    () => checkoutInfo?.paymentMethods.filter((method) => method.enabled) || [],
    [checkoutInfo]
  )

  const loadAccountData = useCallback(async () => {
    const results = await Promise.allSettled([
      relayOneService.getCurrentUser(),
      relayOneService.getCheckoutInfo()
    ])

    if (results[0].status === 'fulfilled') setUser(results[0].value)
    if (results[1].status === 'fulfilled') {
      const checkout = results[1].value
      setCheckoutInfo(checkout)
      setRechargeAmount((current) => current || '20000')
      setPaymentMethod((current) => current || checkout.paymentMethods.find((method) => method.enabled)?.id || '')
    }

    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected) setError(errorMessage(rejected.reason))
  }, [])

  // 密钥全托管：确保四个固定分组的 Key 都在，缺了就补建并写入大模型/作图配置
  const syncManagedKeys = useCallback(async () => {
    try {
      const result = await relayOneService.ensureManagedKeys()
      if (result.updated) await onProviderApplied()
      if (result.missingGroups.length > 0) {
        showMessage(`RelayOne 缺少分组：${result.missingGroups.join('、')}`, false)
      }
    } catch (nextError) {
      setError(errorMessage(nextError))
    }
  }, [onProviderApplied, showMessage])

  const initialize = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextStatus, settings] = await Promise.all([
        relayOneService.getStatus(),
        relayOneService.getPublicSettings().catch(() => null)
      ])
      setStatus(nextStatus)
      if (settings) setPublicSettings(settings)
      if (nextStatus.authenticated) await loadAccountData()
    } catch (nextError) {
      setError(errorMessage(nextError))
    } finally {
      setLoading(false)
    }
  }, [loadAccountData])

  // 已登录状态下补一次托管密钥校准（覆盖旧版本升级上来、之前登录过的用户）；ref 防止回调身份变化导致重复执行
  const managedKeysSyncedRef = useRef(false)
  useEffect(() => {
    if (!status.authenticated) {
      managedKeysSyncedRef.current = false
      return
    }
    if (managedKeysSyncedRef.current) return
    managedKeysSyncedRef.current = true
    void syncManagedKeys()
  }, [status.authenticated, syncManagedKeys])

  useEffect(() => {
    void initialize()
    return relayOneService.onStatusChanged((nextStatus) => {
      setStatus(nextStatus)
      setUser(nextStatus.user || null)
    })
  }, [initialize])

  useEffect(() => {
    if (!order || order.status !== 'pending') return
    const timer = window.setInterval(() => {
      void relayOneService.getPaymentOrder(order.id)
        .then((nextOrder) => {
          setOrder(nextOrder)
          if (nextOrder.status !== 'pending') void relayOneService.closePaymentWindow()
          if (nextOrder.status === 'paid') {
            showMessage('充值已到账', true)
            setCelebration('playing')
            void loadAccountData()
          }
        })
        .catch((nextError) => setError(errorMessage(nextError)))
    }, 3000)
    return () => window.clearInterval(timer)
  }, [loadAccountData, order, showMessage])

  useEffect(() => {
    if (verificationCountdown <= 0) return
    const timer = window.setTimeout(() => {
      setVerificationCountdown((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [verificationCountdown])

  const runAction = async (name: string, operation: () => Promise<void>) => {
    setAction(name)
    setError('')
    try {
      await operation()
    } catch (nextError) {
      const message = errorMessage(nextError)
      setError(message)
      showMessage(message, false)
    } finally {
      setAction('')
    }
  }

  const handleLogin = () => runAction('login', async () => {
    const result = await relayOneService.login({ email, password })
    if (result.requiresTwoFactor) {
      setRequiresTwoFactor(true)
      setPassword('')
      return
    }
    setStatus(result.status || await relayOneService.getStatus())
    setPassword('')
    await loadAccountData()
    // 登录时主进程已自动创建各分组密钥并写入配置，这里刷新设置页展示
    await onProviderApplied()
    showMessage('RelayOne 登录成功，密钥已自动配置', true)
  })

  const handleVerifyTwoFactor = () => runAction('2fa', async () => {
    const result = await relayOneService.verifyTwoFactor(twoFactorCode)
    setStatus(result.status || await relayOneService.getStatus())
    setRequiresTwoFactor(false)
    setTwoFactorCode('')
    await loadAccountData()
    await onProviderApplied()
    showMessage('两步验证成功，密钥已自动配置', true)
  })

  const handleRegister = () => runAction('register', async () => {
    if (!confirmPassword) throw new Error('请再次输入密码')
    if (password !== confirmPassword) throw new Error('两次输入的密码不一致')
    await relayOneService.register({
      email,
      password,
      verificationCode: verificationCode || undefined,
      promoCode: promoCode || undefined,
      invitationCode: invitationCode || undefined
    })
    setAuthTab('login')
    setConfirmPassword('')
    setVerificationCode('')
    showMessage('注册成功，请登录', true)
  })

  const handleSendCode = () => runAction('send-code', async () => {
    await relayOneService.sendVerificationCode(email)
    setVerificationCountdown(60)
    showMessage('验证码已发送', true)
  })

  const handleLogout = () => runAction('logout', async () => {
    await relayOneService.logout()
    setStatus(await relayOneService.getStatus())
    setUser(null)
    setOrder(null)
    showMessage('已退出 RelayOne 账户', true)
  })

  const handleCreateOrder = () => runAction('create-order', async () => {
    const miDou = Number(rechargeAmount)
    if (!Number.isFinite(miDou) || miDou <= 0) throw new Error('请输入充值的密豆数量')
    // 10 密豆 = 1 分钱，支付金额最小到分；同时不能低于站点的最低充值额
    if (!Number.isInteger(miDou) || miDou % 10 !== 0) throw new Error('充值数量需为 10 密豆的整数倍')
    const minMiDou = Math.ceil((checkoutInfo?.minimumAmount ?? 0.01) * MIDOU_PER_CNY)
    if (miDou < minMiDou) throw new Error(`单次最少充值 ${minMiDou.toLocaleString('zh-CN')} 密豆`)
    const maxMiDou = checkoutInfo?.maximumAmount ? Math.floor(checkoutInfo.maximumAmount * MIDOU_PER_CNY) : undefined
    if (maxMiDou && miDou > maxMiDou) throw new Error(`单次最多充值 ${maxMiDou.toLocaleString('zh-CN')} 密豆`)
    const nextOrder = await relayOneService.createPaymentOrder({
      // 界面单位是密豆，下单换算回元
      amount: miDouToCny(miDou),
      paymentType: paymentMethod
    })
    setOrder(nextOrder)
    if (nextOrder.paymentUrl) {
      await relayOneService.openPaymentWindow(nextOrder.paymentUrl)
    } else {
      showMessage('订单已创建，但服务端未返回支付页面', false)
    }
  })

  const handleCancelOrder = () => {
    if (!order || order.status !== 'pending') return
    if (!window.confirm('确认取消这个待支付订单？')) return
    void runAction('cancel-order', async () => {
      setOrder(await relayOneService.cancelPaymentOrder(order.id))
      await relayOneService.closePaymentWindow()
      showMessage('订单已取消', true)
    })
  }

  if (loading) {
    const loadingBar = <div className="flex min-h-12 items-center gap-2 border-y border-divider px-1 text-sm text-muted-foreground"><Spinner size="sm" />正在读取 RelayOne 账户...</div>
    return statusHost ? createPortal(loadingBar, statusHost) : null
  }

  const rechargeSection = (
    <div className="space-y-3">
      <div className="flex items-center gap-2"><MiDouIcon width={16} height={16} /><Typography.Heading level={4} className="text-sm">密豆充值</Typography.Heading></div>
      <TextField fullWidth value={rechargeAmount} onChange={setRechargeAmount}>
        <Label>充值数量</Label>
        <InputGroup variant="secondary" fullWidth><InputGroup.Input type="number" min={Math.ceil((checkoutInfo?.minimumAmount || 0.01) * MIDOU_PER_CNY)} max={checkoutInfo?.maximumAmount ? checkoutInfo.maximumAmount * MIDOU_PER_CNY : undefined} step="100" /><InputGroup.Suffix>密豆</InputGroup.Suffix></InputGroup>
      </TextField>
      <div className="grid grid-cols-5 gap-1.5">
        {PRESET_MIDOU_AMOUNTS.map((amount) => (
          <Tooltip key={amount} delay={0}>
            <Button type="button" variant={Number(rechargeAmount) === amount ? 'primary' : 'outline'} size="sm" className="w-full min-w-0 px-1" onPress={() => setRechargeAmount(String(amount))}>
              {formatMiDouCompact(amount)}豆
            </Button>
            <Tooltip.Content>实际支付 ¥{miDouToCny(amount)}</Tooltip.Content>
          </Tooltip>
        ))}
      </div>
      {activePaymentMethods.length > 0 && (
        <Select selectedKey={paymentMethod || null} onSelectionChange={(key: Key | null) => setPaymentMethod(key == null ? '' : String(key))} placeholder="支付方式" variant="secondary" fullWidth>
          <Label>支付方式</Label>
          <Select.Trigger><Select.Value>{({ defaultChildren }) => activePaymentMethods.find((method) => method.id === paymentMethod)?.name || defaultChildren}</Select.Value><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox>{activePaymentMethods.map((method) => <ListBox.Item key={method.id} id={method.id} textValue={method.name}>{method.name}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
        </Select>
      )}
      {order && (
        <Alert status={order.status === 'paid' ? 'success' : order.status === 'pending' ? 'warning' : 'default'}>
          <Alert.Indicator>{order.status === 'paid' ? <CircleCheck width={18} height={18} /> : <MiDouIcon width={18} height={18} />}</Alert.Indicator>
          <Alert.Content><Alert.Title>订单 {statusLabel(order.status)}</Alert.Title><Alert.Description>{formatMiDou(order.amount)}{order.status === 'pending' ? '，正在每 3 秒查询状态' : ''}</Alert.Description></Alert.Content>
          {order.paymentUrl && order.status === 'pending' && <Button type="button" variant="outline" size="sm" onPress={() => void relayOneService.openPaymentWindow(order.paymentUrl!)}><ArrowUpRight width={16} height={16} />打开支付页</Button>}
          {order.status === 'pending' && <Button type="button" variant="danger-soft" size="sm" onPress={handleCancelOrder} isDisabled={Boolean(action)}>{action === 'cancel-order' && <Spinner size="sm" />}取消订单</Button>}
        </Alert>
      )}
    </div>
  )

  const accountContent = (
    <div className="space-y-5">
      {!status.encryptionAvailable && (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Title>系统凭据加密不可用</Alert.Title>
            <Alert.Description>本次登录令牌只保存在内存中，退出 CipherTalk 后需要重新登录。</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {error && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>RelayOne 操作失败</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {!status.authenticated ? (
        <div className="mx-auto w-full max-w-md py-2">
          {requiresTwoFactor ? (
            <div className="space-y-4">
              <TextField fullWidth value={twoFactorCode} onChange={setTwoFactorCode}>
                <Label>两步验证码</Label>
                <InputGroup variant="secondary" fullWidth><InputGroup.Input inputMode="numeric" autoComplete="one-time-code" placeholder="请输入验证码" /></InputGroup>
              </TextField>
              <Button type="button" variant="primary" className="w-full" onPress={handleVerifyTwoFactor} isDisabled={Boolean(action)}>
                {action === '2fa' && <Spinner size="sm" />}验证并登录
              </Button>
              <Button type="button" variant="tertiary" className="w-full" onPress={() => { setRequiresTwoFactor(false); setTwoFactorCode('') }}>返回登录</Button>
            </div>
          ) : (
            <Tabs selectedKey={authTab} onSelectionChange={(key) => setAuthTab(String(key) as AuthTab)} className="w-full">
              <Tabs.ListContainer>
                <Tabs.List aria-label="RelayOne 账户操作" className="w-full *:flex-1">
                  <Tabs.Tab id="login">登录<Tabs.Indicator /></Tabs.Tab>
                  {publicSettings?.registrationEnabled !== false && <Tabs.Tab id="register">注册<Tabs.Indicator /></Tabs.Tab>}
                </Tabs.List>
              </Tabs.ListContainer>
              <Tabs.Panel id="login" className="pt-5">
                <div className="space-y-4">
                  <TextField fullWidth value={email} onChange={setEmail}>
                    <Label>邮箱</Label>
                    <InputGroup variant="secondary" fullWidth><InputGroup.Input type="email" autoComplete="email" placeholder="name@example.com" /></InputGroup>
                  </TextField>
                  <TextField fullWidth value={password} onChange={setPassword}>
                    <Label>密码</Label>
                    <InputGroup variant="secondary" fullWidth><InputGroup.Input type="password" autoComplete="current-password" placeholder="请输入密码" /></InputGroup>
                  </TextField>
                  <Button type="button" variant="primary" className="w-full" onPress={handleLogin} isDisabled={Boolean(action)}>
                    {action === 'login' && <Spinner size="sm" />}登录 RelayOne
                  </Button>
                </div>
              </Tabs.Panel>
              <Tabs.Panel id="register" className="pt-5">
                <div className="space-y-4">
                  <TextField fullWidth value={email} onChange={setEmail}>
                    <Label>邮箱</Label>
                    <InputGroup variant="secondary" fullWidth><InputGroup.Input type="email" autoComplete="email" placeholder="name@example.com" /></InputGroup>
                  </TextField>
                  <TextField fullWidth value={password} onChange={setPassword}>
                    <Label>密码</Label>
                    <InputGroup variant="secondary" fullWidth><InputGroup.Input type="password" autoComplete="new-password" placeholder="设置登录密码" /></InputGroup>
                  </TextField>
                  <TextField fullWidth value={confirmPassword} onChange={setConfirmPassword}>
                    <Label>确认密码</Label>
                    <InputGroup variant="secondary" fullWidth><InputGroup.Input type="password" autoComplete="new-password" placeholder="再次输入密码" /></InputGroup>
                  </TextField>
                  {publicSettings?.emailVerificationEnabled && (
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                      <TextField fullWidth value={verificationCode} onChange={setVerificationCode}>
                        <Label>邮箱验证码</Label>
                        <InputGroup variant="secondary" fullWidth><InputGroup.Input autoComplete="one-time-code" placeholder="验证码" /></InputGroup>
                      </TextField>
                      <Button type="button" variant="outline" className="min-w-28" onPress={handleSendCode} isDisabled={Boolean(action) || verificationCountdown > 0 || !email.trim()}>
                        {action === 'send-code' ? <Spinner size="sm" /> : verificationCountdown > 0 ? `${verificationCountdown} 秒` : '发送验证码'}
                      </Button>
                    </div>
                  )}
                  {publicSettings?.promoCodeEnabled && (
                    <TextField fullWidth value={promoCode} onChange={setPromoCode}>
                      <Label>优惠码</Label>
                      <InputGroup variant="secondary" fullWidth><InputGroup.Input placeholder="选填" /></InputGroup>
                    </TextField>
                  )}
                  {publicSettings?.invitationCodeEnabled && (
                    <TextField fullWidth value={invitationCode} onChange={setInvitationCode}>
                      <Label>邀请码</Label>
                      <InputGroup variant="secondary" fullWidth><InputGroup.Input placeholder="请输入邀请码" /></InputGroup>
                    </TextField>
                  )}
                  <Button type="button" variant="primary" className="w-full" onPress={handleRegister} isDisabled={Boolean(action)}>
                    {action === 'register' && <Spinner size="sm" />}创建账户
                  </Button>
                  {(publicSettings?.agreementUrl || publicSettings?.privacyUrl) && (
                    <div className="flex justify-center gap-4 text-xs">
                      {publicSettings.agreementUrl && <button type="button" className="text-accent hover:underline" onClick={() => void window.electronAPI.shell.openExternal(publicSettings.agreementUrl!)}>用户协议</button>}
                      {publicSettings.privacyUrl && <button type="button" className="text-accent hover:underline" onClick={() => void window.electronAPI.shell.openExternal(publicSettings.privacyUrl!)}>隐私政策</button>}
                    </div>
                  )}
                </div>
              </Tabs.Panel>
            </Tabs>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <section className="grid gap-3 border-y border-divider py-4 sm:grid-cols-3">
            <div><div className="text-xs text-muted-foreground">账户</div><div className="mt-1 truncate text-sm font-medium">{user?.name || user?.email || status.user?.email || 'RelayOne 用户'}</div></div>
            <div><div className="text-xs text-muted-foreground">邮箱</div><div className="mt-1 truncate text-sm font-medium">{user?.email || status.user?.email || '--'}</div></div>
            <div><div className="text-xs text-muted-foreground">密豆</div><div className="mt-1 text-sm font-semibold text-success">{formatMiDou(user?.balance)}</div></div>
          </section>

          <Alert status="success">
            <Alert.Indicator><CircleCheck width={18} height={18} /></Alert.Indicator>
            <Alert.Content>
              <Alert.Title>密钥自动托管</Alert.Title>
              <Alert.Description>登录后已自动创建各分组密钥并配置到大模型与作图，充值后即可直接使用。</Alert.Description>
            </Alert.Content>
          </Alert>
        </div>
      )}
    </div>
  )

  const accountModal = (
    <Modal state={accountModalState}>
      <Modal.Backdrop variant="blur" className="z-2000">
        <Modal.Container
          size="lg"
          scroll="inside"
          placement="center"
          className="w-full! max-w-156! max-h-[calc(100vh-32px)]! p-4!"
        >
          <Modal.Dialog aria-label="RelayOne 账户管理" className="max-w-none!">
            <Modal.Header className="gap-2 border-b border-divider pb-3">
              <div className="flex justify-end">
                <CloseButton aria-label="关闭 RelayOne 账户管理" onPress={() => setAccountModalOpen(false)} />
              </div>
              <div className="flex items-center gap-2">
                <Modal.Heading className="min-w-0 text-base font-semibold text-foreground">RelayOne 账户管理</Modal.Heading>
                {status.authenticated && (
                  <Button type="button" variant="outline" size="sm" isIconOnly aria-label="刷新 RelayOne 账户" onPress={() => void initialize()} isDisabled={Boolean(action)}>
                    <ArrowsRotateLeft width={16} height={16} />
                  </Button>
                )}
              </div>
            </Modal.Header>
            <Modal.Body className="mt-0! px-5 pb-5 pt-0">
              {accountContent}
            </Modal.Body>
            {status.authenticated && (
              <Modal.Footer className="justify-end border-t border-divider pt-4">
                <Button type="button" variant="danger" size="sm" onPress={handleLogout} isDisabled={Boolean(action)}>
                  {action === 'logout' && <Spinner size="sm" />}退出
                </Button>
              </Modal.Footer>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )

  const statusBar = (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-y border-divider py-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-foreground">
        <MiDouIcon width={17} height={17} />
      </div>
      <div className="min-w-32 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-sm font-medium text-foreground">RelayOne 账户</span>
          <Chip size="sm" variant="soft" color={status.authenticated ? 'success' : 'default'}>
            <Chip.Label>{status.authenticated ? '已登录' : '未登录'}</Chip.Label>
          </Chip>
        </div>
        <div className={`mt-0.5 truncate text-xs ${error ? 'text-danger' : 'text-muted-foreground'}`}>
          {error || (status.authenticated ? (user?.email || status.user?.email || 'RelayOne 用户') : '尚未登录')}
        </div>
      </div>
      {status.authenticated && (
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm font-semibold text-success">{formatMiDou(user?.balance)}</span>
          <Chip size="sm" variant="soft" color={hasConfiguredApiKey ? 'accent' : 'warning'}>
            <Chip.Label>{hasConfiguredApiKey ? 'Key 已应用' : '未应用 Key'}</Chip.Label>
          </Chip>
        </div>
      )}
      {!status.encryptionAvailable && <span className="shrink-0 text-xs text-warning">仅本次会话</span>}
    </div>
  )

  return (
    <>
      {statusHost && createPortal(statusBar, statusHost)}
      <Card>
        <Card.Content>
          {status.authenticated ? rechargeSection : (
            <div className="text-sm text-muted-foreground">登录 RelayOne 账户后自动配置密钥，充值即可使用。</div>
          )}
        </Card.Content>

        <Card.Footer className="gap-2 *:min-w-0 *:flex-1">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="bg-amber-700! text-white! hover:bg-amber-800!"
            onPress={() => setAccountModalOpen(true)}
          >
            <PersonNutHex width={16} height={16} />
            {status.authenticated ? '账户管理' : '登录 / 注册'}
          </Button>
          {status.authenticated && (
            <Button type="button" variant="primary" size="sm" onPress={handleCreateOrder} isDisabled={Boolean(action) || !paymentMethod}>
              {action === 'create-order' ? <Spinner size="sm" /> : <QrCode width={16} height={16} />}充值
            </Button>
          )}
        </Card.Footer>
      </Card>
      {createPortal(accountModal, document.body)}
      {celebration !== 'hidden' && createPortal(
        <div
          className={`pointer-events-none fixed inset-0 flex items-center justify-center transition-all duration-300 ease-in ${
            celebration === 'leaving' ? 'scale-75 opacity-0' : 'scale-100 opacity-100'
          }`}
          style={{ zIndex: 3000 }}
        >
          <LottieView
            autoplay
            className="size-[min(60vh,60vw)]"
            dotLottieRefCallback={handleSuccessLottieRef}
            src={successLottieUrl}
          />
        </div>,
        document.body
      )}
    </>
  )
}
