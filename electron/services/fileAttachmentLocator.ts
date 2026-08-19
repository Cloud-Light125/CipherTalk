import { existsSync, statSync } from 'fs'
import { dirname, join, basename } from 'path'

/**
 * 定位聊天里的文件附件（appmsg type=6）在微信数据目录中的原始文件。
 *
 * 微信 4.x 的文件附件明文存放在 <账号目录>/msg/file/<YYYY-MM>/<文件名>，
 * hardlink.db 的 file_hardlink_info_* 表记录 md5 → 目录/文件名。
 * 优先查 hardlink（同名文件会被微信改名为 name(1).ext，只按 XML title 猜会拿错），
 * 查不到再按月份目录 + 原文件名 + 大小兜底。
 */

export interface FileAttachmentInfo {
  title: string
  md5?: string
  totalLen?: number
}

type HardlinkState = {
  fileTable?: string
  dirTable?: string
}

let hardlinkStatePromise: Promise<HardlinkState> | null = null
const dirNameCache = new Map<number, string | null>()

function extractXmlValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)
  return match ? match[1].trim() : ''
}

function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

/** 从 appmsg XML 提取文件名 / md5 / 大小；不是文件消息返回 null。 */
export function parseFileAttachmentInfo(content: string): FileAttachmentInfo | null {
  if (!content || !/<appmsg/i.test(content)) return null
  if (extractXmlValue(content, 'type') !== '6') return null
  const title = decodeEntities(extractXmlValue(content, 'title'))
  if (!title) return null
  const md5 = extractXmlValue(content, 'md5').toLowerCase() || undefined
  const totalLenRaw = Number(extractXmlValue(content, 'totallen'))
  const totalLen = Number.isFinite(totalLenRaw) && totalLenRaw > 0 ? totalLenRaw : undefined
  return { title, md5, totalLen }
}

// dbAdapter / dbStoragePaths 按需加载：纯函数部分可被 node --experimental-strip-types 的测试直接导入
async function getAccountDir(): Promise<string | null> {
  const { getDbStoragePath } = await import('./dbStoragePaths')
  const dbStorage = getDbStoragePath()
  return dbStorage ? dirname(dbStorage) : null
}

async function getDbAdapter() {
  const { dbAdapter } = await import('./dbAdapter')
  return dbAdapter
}

async function getHardlinkState(): Promise<HardlinkState> {
  if (!hardlinkStatePromise) {
    hardlinkStatePromise = (async () => {
      try {
        const dbAdapter = await getDbAdapter()
        const fileRow = await dbAdapter.get<{ name?: string }>(
          'hardlink', '',
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'file_hardlink_info%' ORDER BY name DESC LIMIT 1"
        )
        const dirRow = await dbAdapter.get<{ name?: string }>(
          'hardlink', '',
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dir2id%' LIMIT 1"
        )
        return { fileTable: fileRow?.name, dirTable: dirRow?.name }
      } catch {
        return {}
      }
    })()
  }
  return hardlinkStatePromise
}

async function resolveDirName(dirTable: string, rowid: number): Promise<string | null> {
  if (dirNameCache.has(rowid)) return dirNameCache.get(rowid) ?? null
  let name: string | null = null
  try {
    const dbAdapter = await getDbAdapter()
    const row = await dbAdapter.get<{ username?: string }>(
      'hardlink', '', `SELECT username FROM ${dirTable} WHERE rowid = ? LIMIT 1`, [rowid]
    )
    name = row?.username || null
  } catch { /* ignore */ }
  dirNameCache.set(rowid, name)
  return name
}

function fileExists(filePath: string, expectedSize?: number): boolean {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return false
    return expectedSize === undefined || stat.size === expectedSize
  } catch {
    return false
  }
}

function monthKeys(createTime: number): string[] {
  const base = new Date(createTime * 1000)
  const keys: string[] = []
  for (const offset of [0, -1, 1]) {
    const d = new Date(base.getFullYear(), base.getMonth() + offset, 1)
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return keys
}

async function locateViaHardlink(accountDir: string, md5: string, expectedSize?: number): Promise<string | null> {
  const state = await getHardlinkState()
  if (!state.fileTable) return null
  let row: { file_name?: string; dir1?: number; dir2?: number } | null | undefined
  try {
    const dbAdapter = await getDbAdapter()
    row = await dbAdapter.get<{ file_name?: string; dir1?: number; dir2?: number }>(
      'hardlink', '',
      `SELECT file_name, dir1, dir2 FROM ${state.fileTable} WHERE lower(md5) = lower(?) LIMIT 1`,
      [md5]
    )
  } catch {
    return null
  }
  if (!row?.file_name) return null
  const fileName = basename(String(row.file_name).replace(/\\/g, '/'))
  const dirNames: string[] = []
  if (state.dirTable) {
    for (const id of [row.dir1, row.dir2]) {
      if (typeof id === 'number' && id > 0) {
        const name = await resolveDirName(state.dirTable, id)
        if (name) dirNames.push(name)
      }
    }
  }
  const fileRoot = join(accountDir, 'msg', 'file')
  const candidates: string[] = []
  if (dirNames.length >= 2) candidates.push(join(fileRoot, dirNames[0], dirNames[1], fileName))
  for (const name of dirNames) candidates.push(join(fileRoot, name, fileName))
  candidates.push(join(fileRoot, fileName))
  // 大小已知时严格匹配；hardlink 给出的路径本身可信，大小不符时仍接受（微信可能改过文件）
  for (const candidate of candidates) {
    if (fileExists(candidate, expectedSize)) return candidate
  }
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate
  }
  return null
}

function locateViaGuess(accountDir: string, info: FileAttachmentInfo, createTime: number): string | null {
  const safeTitle = basename(info.title.replace(/\\/g, '/'))
  if (!safeTitle || safeTitle === '.' || safeTitle === '..') return null
  const roots = [join(accountDir, 'msg', 'file'), join(accountDir, 'FileStorage', 'File')]
  for (const root of roots) {
    for (const month of monthKeys(createTime)) {
      const candidate = join(root, month, safeTitle)
      if (fileExists(candidate, info.totalLen)) return candidate
    }
  }
  return null
}

/** 返回附件在磁盘上的绝对路径；找不到返回 null。accountDir 默认从配置解析，测试可显式传入。 */
export async function locateFileAttachment(
  info: FileAttachmentInfo,
  createTime: number,
  accountDir?: string | null,
  useHardlink = true,
): Promise<string | null> {
  if (accountDir === undefined) accountDir = await getAccountDir()
  if (!accountDir || !existsSync(accountDir)) return null
  if (useHardlink && info.md5) {
    const viaHardlink = await locateViaHardlink(accountDir, info.md5, info.totalLen)
    if (viaHardlink) return viaHardlink
  }
  return locateViaGuess(accountDir, info, createTime)
}

/** 测试/重置用：清空 hardlink 表名与目录名缓存。 */
export function resetFileAttachmentLocatorCache(): void {
  hardlinkStatePromise = null
  dirNameCache.clear()
}
