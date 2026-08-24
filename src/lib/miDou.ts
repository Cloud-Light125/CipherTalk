/**
 * 密豆：RelayOne 余额在 CipherTalk 里的展示单位，1 元 = 1000 密豆。
 * 只是展示层换算——服务端计费、充值下单仍然按人民币，界面上不出现真实金额。
 */
export const MIDOU_PER_CNY = 1000

/** 元 → 密豆（向下取整，避免把余额显示得比实际多） */
export function cnyToMiDou(cny: number): number {
  return Math.floor(cny * MIDOU_PER_CNY)
}

/** 密豆 → 元（下单用） */
export function miDouToCny(miDou: number): number {
  return miDou / MIDOU_PER_CNY
}

/** 余额/金额展示："12,340 密豆"；undefined 显示 "--" */
export function formatMiDou(cny: number | undefined): string {
  if (cny === undefined || !Number.isFinite(cny)) return '--'
  return `${cnyToMiDou(cny).toLocaleString('zh-CN')} 密豆`
}

/** 紧凑展示（充值预设按钮用）：整万显示"N万"，其余按千分位 */
export function formatMiDouCompact(miDou: number): string {
  if (miDou >= 10000 && miDou % 10000 === 0) return `${miDou / 10000}万`
  return miDou.toLocaleString('zh-CN')
}
