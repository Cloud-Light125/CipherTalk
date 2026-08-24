import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chip, Tooltip } from '@heroui/react'
import { relayOneService } from '../../services/relayOne'
import MiDouIcon from './MiDouIcon'
import { formatMiDou } from '../../lib/miDou'

// 低余额阈值，单位仍是服务端的元（1 元 = 1000 密豆）
const LOW_BALANCE_THRESHOLD = 1

/** Agent 页顶栏的 RelayOne 密豆余额胶囊：仅在已登录 RelayOne 时显示，点击直达设置页充值。 */
export default function RelayOneBalanceChip() {
  const navigate = useNavigate()
  const [balance, setBalance] = useState<number | null>(null)

  useEffect(() => {
    let disposed = false
    const refresh = () => {
      void relayOneService.getStatus()
        .then((status) => (status.authenticated ? relayOneService.getCurrentUser() : null))
        .then((user) => {
          if (!disposed) setBalance(typeof user?.balance === 'number' ? user.balance : null)
        })
        .catch(() => { if (!disposed) setBalance(null) })
    }
    refresh()
    // ponytail: 60s 轮询保余额不陈旧；若嫌费请求可改成对话结束后刷新
    const timer = window.setInterval(refresh, 60_000)
    const unsubscribe = relayOneService.onStatusChanged((status) => {
      if (!status.authenticated) setBalance(null)
      else if (typeof status.user?.balance === 'number') setBalance(status.user.balance)
    })
    return () => {
      disposed = true
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [])

  if (balance === null) return null

  const low = balance < LOW_BALANCE_THRESHOLD
  return (
    <Tooltip delay={0}>
      <button
        type="button"
        className="cursor-pointer"
        aria-label="RelayOne 密豆余额，点击前往充值"
        onClick={() => navigate('/settings?tab=ai')}
      >
        <Chip size="sm" variant="soft" color={low ? 'warning' : 'accent'}>
          <MiDouIcon width={13} height={13} />
          <Chip.Label className="font-medium tabular-nums">{formatMiDou(balance)}</Chip.Label>
        </Chip>
      </button>
      <Tooltip.Content placement="bottom">
        {low ? '密豆即将用完，点击充值' : 'RelayOne 密豆余额，点击管理'}
      </Tooltip.Content>
    </Tooltip>
  )
}
