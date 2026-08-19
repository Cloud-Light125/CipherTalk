import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFileAttachmentInfo, locateFileAttachment } from '../electron/services/fileAttachmentLocator.ts'

// ---- parseFileAttachmentInfo ----
const fileXml = '<msg><appmsg appid="" sdkver="0"><title>季度报告 &amp; 附件.pdf</title><type>6</type><appattach><totallen>12</totallen><fileext>pdf</fileext></appattach><md5>ABCDEF0123456789abcdef0123456789</md5></appmsg></msg>'
const info = parseFileAttachmentInfo(fileXml)
assert.ok(info, '应识别为文件消息')
assert.equal(info!.title, '季度报告 & 附件.pdf', 'title 应解码实体')
assert.equal(info!.md5, 'abcdef0123456789abcdef0123456789', 'md5 应小写')
assert.equal(info!.totalLen, 12)
assert.equal(parseFileAttachmentInfo('<msg><appmsg><title>链接</title><type>5</type></appmsg></msg>'), null, '非文件 appmsg 应返回 null')
assert.equal(parseFileAttachmentInfo('纯文本'), null)
assert.equal(parseFileAttachmentInfo(''), null)

// ---- locateFileAttachment：按月份目录 + 文件名 + 大小兜底（不走 hardlink） ----
const root = mkdtempSync(join(tmpdir(), 'ct-file-locator-'))
try {
  const createTime = Math.floor(new Date(2026, 7, 15, 12, 0, 0).getTime() / 1000) // 2026-08
  const monthDir = join(root, 'msg', 'file', '2026-08')
  mkdirSync(monthDir, { recursive: true })
  writeFileSync(join(monthDir, '季度报告 & 附件.pdf'), '123456789012') // 12 bytes

  const found = await locateFileAttachment(info!, createTime, root, false)
  assert.equal(found, join(monthDir, '季度报告 & 附件.pdf'), '应在当月目录按文件名命中')

  // 大小不符 → 不接受（避免同名不同文件）
  writeFileSync(join(monthDir, 'other.docx'), 'short')
  const wrongSize = await locateFileAttachment({ title: 'other.docx', totalLen: 999 }, createTime, root, false)
  assert.equal(wrongSize, null, '大小不符不应命中')
  // 未知大小 → 按文件名接受
  const unknownSize = await locateFileAttachment({ title: 'other.docx' }, createTime, root, false)
  assert.equal(unknownSize, join(monthDir, 'other.docx'))

  // 相邻月份容错（跨月发送/接收）
  const prevDir = join(root, 'msg', 'file', '2026-07')
  mkdirSync(prevDir, { recursive: true })
  writeFileSync(join(prevDir, 'late.zip'), 'zz')
  assert.equal(await locateFileAttachment({ title: 'late.zip' }, createTime, root, false), join(prevDir, 'late.zip'))

  // 路径穿越：title 含目录分隔符只取 basename
  mkdirSync(join(root, 'msg', 'file', '2026-08', 'sub'), { recursive: true })
  writeFileSync(join(root, 'secret.txt'), 'x')
  assert.equal(await locateFileAttachment({ title: '../../secret.txt' }, createTime, root, false), null, '不得穿越到上级目录')
  assert.equal(await locateFileAttachment({ title: '..' }, createTime, root, false), null)

  // 找不到
  assert.equal(await locateFileAttachment({ title: 'missing.pdf' }, createTime, root, false), null)
  assert.equal(await locateFileAttachment({ title: 'x' }, createTime, join(root, 'nope'), false), null, '账号目录不存在返回 null')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('file attachment locator tests passed')
