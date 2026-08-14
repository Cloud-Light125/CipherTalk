/**
 * 微信收藏查询导出 —— 读宿主 favorites.list（favorite.db 的 fav_db_item，SQLCipher 解密只读查询）。
 *
 * 功能：加载全部收藏 → 按类型统计卡片 + 类型/关键词筛选 → 明细表格；
 * 导出同款「统计概览 + 分年明细」的 Markdown / HTML，或 CSV（下载/剪贴板）。
 */
import { connect } from './ciphertalk-plugin-sdk.js'

const api = await connect()

const $ = (id) => document.getElementById(id)

// 收藏 type 枚举（与宿主 FAV_TYPE_NAMES 一致）
const TYPES = {
  1: { name: '文字/笔记', emoji: '📝' },
  2: { name: '图片', emoji: '🖼️' },
  3: { name: '语音', emoji: '🎤' },
  4: { name: '视频', emoji: '🎬' },
  5: { name: '文章/链接', emoji: '📄' },
  8: { name: '文件', emoji: '📦' },
  14: { name: '聊天记录/音频', emoji: '🎵' },
  18: { name: '位置/地图', emoji: '📍' },
}
const typeInfo = (t) => TYPES[t] || { name: `type=${t}`, emoji: '❓' }
const typeLabel = (t) => `${typeInfo(t).emoji} ${typeInfo(t).name}`

// ============ 基础工具 ============

function fmtTime(ts) {
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/** 只放行 http(s)：收藏 XML 里的 link 是别人分享进来的，javascript: 之类不能进 href */
function safeHref(link) {
  return /^https?:\/\//i.test(String(link || '')) ? String(link) : ''
}

function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function displayTitle(item) {
  if (item.title) return item.title
  if (item.desc) return item.desc.replace(/\s+/g, ' ').slice(0, 60)
  return ({ 2: '聊天图片', 3: '语音消息', 4: '视频', 14: '聊天记录' })[item.type] || typeInfo(item.type).name
}

/** 来源展示：优先公众号/分享者显示名，其次裸 wxid */
function displaySource(item) {
  return item.sourceName || item.fromUsr || ''
}

function downloadText(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    api.ui.toast(`已开始下载 ${filename}`, { type: 'success' })
    return true
  } catch (e) {
    api.ui.toast(`下载失败：${e.message}`, { type: 'error' })
    return false
  }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ============ 加载 ============

const PAGE_SIZE = 2000  // 宿主 favorites.list 单页上限
let allItems = []       // 宿主返回的全部收藏（updateTime 降序）
let activeType = ''     // 类型筛选（''=全部）

async function loadFavorites() {
  $('btnLoad').disabled = true
  $('sumHint').textContent = '正在读取 favorite.db …'
  try {
    const caps = await api.capabilities()
    if (!caps.includes('favorites.list')) {
      throw new Error('当前宿主版本不支持 favorites.list，请升级 CipherTalk 后重试')
    }
    // 宿主按页返回（单页上限 2000），翻到 truncated=false 为止；20 页保底防死循环
    const items = []
    let last = {}
    for (let page = 0; page < 20; page++) {
      last = await api.invoke('favorites.list', { limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      items.push(...(last.items || []))
      if (!last.truncated) break
    }
    allItems = items
    buildTypeFilter()
    renderStats()
    renderTable()
    const extra = last.truncated ? '（超出上限，已截断）' : ''
    $('sumHint').textContent = `共 ${allItems.length} 条收藏${extra} · 库：${last.dbPath || ''}`
  } catch (e) {
    allItems = []
    renderStats()
    renderTable()
    const msg = String(e?.message || e)
    const locked = /lock|占用|not a database|database is/i.test(msg)
    $('sumHint').textContent = `读取失败：${msg}${locked ? '（请关闭微信后重试）' : ''}`
    api.ui.toast(`读取收藏失败${locked ? '，请先关闭微信' : ''}`, { type: 'error' })
  }
  $('btnLoad').disabled = false
}

$('btnLoad').addEventListener('click', loadFavorites)

// ============ 筛选与统计 ============

function filteredItems() {
  const kw = $('kw').value.trim().toLowerCase()
  return allItems.filter((it) => {
    if (activeType !== '' && String(it.type) !== activeType) return false
    if (!kw) return true
    return [it.title, it.desc, it.link, it.fromUsr, it.sourceName, typeInfo(it.type).name]
      .some((v) => String(v || '').toLowerCase().includes(kw))
  })
}

function buildTypeFilter() {
  const counts = new Map()
  for (const it of allItems) counts.set(it.type, (counts.get(it.type) || 0) + 1)
  const sel = $('typeFilter')
  sel.innerHTML = '<option value="">全部类型</option>' +
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<option value="${t}">${typeLabel(t)}（${n}）</option>`)
      .join('')
  sel.value = activeType
}

function renderStats() {
  const counts = new Map()
  for (const it of allItems) counts.set(it.type, (counts.get(it.type) || 0) + 1)
  const total = allItems.length || 1
  $('stats').innerHTML = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) =>
      `<button class="fv-stat${String(t) === activeType ? ' active' : ''}" data-type="${t}">
        <span>${typeLabel(t)}</span><b>${n}</b><span class="fv-dim">${(n / total * 100).toFixed(1)}%</span>
      </button>`)
    .join('')
}

$('stats').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.fv-stat')
  if (!chip) return
  const t = chip.dataset.type
  activeType = activeType === t ? '' : t
  $('typeFilter').value = activeType
  renderStats()
  renderTable()
})

$('typeFilter').addEventListener('change', () => {
  activeType = $('typeFilter').value
  renderStats()
  renderTable()
})
$('kw').addEventListener('input', renderTable)

// ============ 明细表格 ============

function renderTable() {
  const rows = filteredItems()
  const n = rows.length
  $('tbFav').innerHTML = rows.map((it, i) => {
    // 插件 iframe 的 sandbox 没有 allow-popups，target=_blank 打不开，就别装成链接；
    // 要点开去导出的 HTML 里点。不在 JS 里截断：超长交给 CSS 省略号，hover 看全文
    const linkCell = it.link
      ? `<span class="fv-link" title="${esc(it.link)}">${esc(it.link)}</span>`
      : '<span class="fv-dim">—</span>'
    const title = displayTitle(it)
    const descPart = it.desc && it.desc !== it.title
      ? `<div class="fv-dim fv-desc" title="${esc(it.desc)}">${esc(it.desc)}</div>` : ''
    return `<tr>
      <td>${n - i}</td>
      <td class="fv-type">${typeLabel(it.type)}</td>
      <td class="fv-nowrap">${fmtTime(it.updateTime)}</td>
      <td><div class="fv-title" title="${esc(title)}">${esc(title)}</div>${descPart}</td>
      <td>${linkCell}</td>
      <td class="fv-dim">${esc(displaySource(it) || '—')}</td>
    </tr>`
  }).join('') || '<tr><td colspan="6" class="ct-empty">无结果</td></tr>'

  const hasData = rows.length > 0
  $('btnMd').disabled = !hasData
  $('btnHtml').disabled = !hasData
  $('btnCsv').disabled = !hasData
  $('btnCopy').disabled = !hasData
  $('exportHint').textContent = hasData ? `导出范围：当前筛选 ${rows.length} 条` : ''
}

// ============ 导出 Markdown（同款「统计概览 + 分年明细」） ============

function buildMarkdown() {
  const rows = filteredItems() // updateTime 降序
  const n = rows.length
  const oldest = fmtTime(rows[n - 1].updateTime).slice(0, 10)
  const newest = fmtTime(rows[0].updateTime).slice(0, 10)

  const counts = new Map()
  for (const it of rows) counts.set(it.type, (counts.get(it.type) || 0) + 1)
  const statLines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `| ${typeLabel(t)} | ${c} | ${(c / n * 100).toFixed(1)}% |`)
    .join('\n')

  // 按年分节（新年在先），年内保持时间降序
  const byYear = new Map()
  rows.forEach((it, i) => {
    const year = new Date(it.updateTime * 1000).getFullYear()
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year).push({ it, no: n - i })
  })
  const sections = [...byYear.entries()].map(([year, list]) => {
    const body = list.map(({ it, no }) =>
      `| ${no} | ${typeInfo(it.type).name} | ${fmtTime(it.updateTime)} | ${mdCell(displayTitle(it)).slice(0, 80)} | ` +
      (safeHref(it.link) ? `[链接](${safeHref(it.link).replace(/\)/g, '%29')})` : '—') + ' |').join('\n')
    return `### ${year} 年\n\n| # | 类型 | 时间 | 标题 | 链接 |\n|:-:|:----:|:----:|------|:----:|\n${body}`
  }).join('\n\n')

  return `# 📁 微信收藏导出

> 导出时间：${new Date().toLocaleString('zh-CN')}  
> 共 **${n} 条**收藏，时间跨度 ${oldest} ~ ${newest}

---

## 统计概览

| 类型 | 数量 | 占比 |
|------|:----:|:----:|
${statLines}

---

## 全部收藏明细

${sections}

---

## 备注

- 由 CipherTalk「收藏查询导出」插件自 favorite.db 直接解密导出
- 链接类收藏（文章/链接）可直接点击跳转
- 图片 / 视频 / 语音 / 文件类收藏本体存于微信收藏服务器与本地缓存，此处仅导出元信息
`
}

// ============ 导出 HTML ============

function buildHtml() {
  const rows = filteredItems()
  const n = rows.length
  const counts = new Map()
  for (const it of rows) counts.set(it.type, (counts.get(it.type) || 0) + 1)
  const cards = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `<div class="card"><div class="num">${c}</div><div class="name">${typeLabel(t)}</div></div>`)
    .join('')
  const trs = rows.map((it, i) => `<tr>
    <td>${n - i}</td>
    <td class="type">${typeLabel(it.type)}</td>
    <td>${fmtTime(it.updateTime)}</td>
    <td>${esc(displayTitle(it))}${it.desc && it.desc !== it.title ? `<div class="dim">${esc(it.desc.slice(0, 160))}</div>` : ''}</td>
    <td>${safeHref(it.link) ? `<a href="${esc(safeHref(it.link))}" target="_blank" rel="noopener">链接</a>` : '—'}</td>
    <td class="dim">${esc(displaySource(it) || '—')}</td>
  </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>微信收藏导出（${n} 条）</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 32px; color: #1f2329; }
  h1 { font-size: 22px; } .meta { color: #646a73; font-size: 13px; margin-bottom: 16px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 24px; }
  .card { border: 1px solid #e5e6eb; border-radius: 10px; padding: 10px 18px; text-align: center; }
  .card .num { font-size: 22px; font-weight: 700; color: #07c160; }
  .card .name { font-size: 12px; color: #646a73; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #e5e6eb; padding: 6px 10px; text-align: left; vertical-align: top; word-break: break-all; }
  th { background: #f7f8fa; }
  .type { white-space: nowrap; color: #07c160; font-weight: 600; }
  .dim { color: #8f959e; } a { color: #3370ff; }
</style>
</head>
<body>
<h1>📁 微信收藏导出</h1>
<div class="meta">导出时间：${new Date().toLocaleString('zh-CN')} · 共 ${n} 条收藏</div>
<div class="cards">${cards}</div>
<table>
<thead><tr><th>#</th><th>类型</th><th>时间</th><th>标题 / 摘要</th><th>链接</th><th>来源</th></tr></thead>
<tbody>${trs}</tbody>
</table>
</body>
</html>
`
}

// ============ 导出 CSV ============

function toCsv() {
  const rows = filteredItems()
  const n = rows.length
  const cell = (v) => {
    const s = String(v ?? '').replace(/\r?\n/g, ' ')
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const headers = ['序号', '类型', '时间', '标题', '摘要', '链接', '来源', 'localId']
  const lines = rows.map((it, i) => [
    n - i, typeInfo(it.type).name, fmtTime(it.updateTime), displayTitle(it),
    it.desc, it.link, displaySource(it), it.localId,
  ].map(cell).join(','))
  return '\uFEFF' + [headers.join(','), ...lines].join('\r\n')
}

// ============ 导出按钮 ============

$('btnMd').addEventListener('click', () => {
  downloadText(`微信收藏导出_${stamp()}.md`, buildMarkdown(), 'text/markdown')
})
$('btnHtml').addEventListener('click', () => {
  downloadText(`微信收藏导出_${stamp()}.html`, buildHtml(), 'text/html')
})
$('btnCsv').addEventListener('click', () => {
  downloadText(`微信收藏导出_${stamp()}.csv`, toCsv(), 'text/csv')
})
$('btnCopy').addEventListener('click', async () => {
  try {
    await api.clipboard.write(toCsv())
    api.ui.toast(`已复制 ${filteredItems().length} 条收藏到剪贴板（CSV）`, { type: 'success' })
  } catch (e) {
    api.ui.toast(`复制失败：${e.message}`, { type: 'error' })
  }
})

// ============ 启动：能力探测 + 自动加载 ============

loadFavorites()
