/**
 * DatabaseExportService —— 把微信原生【加密】数据库解密落地为普通 SQLite 库。
 *
 * 原生 wcdb_api 不提供字节级解密符号，故走「逻辑拷贝」：经 dbAdapter（绝对路径 + 账号密钥）
 * 逐表读出 → 用 better-sqlite3 写入新明文库。
 *
 * 忠实性：native 把 BLOB 序列化为 hex 字符串、整数为 JSON number（int64 丢精度），且 JSON 里
 * TEXT/BLOB 无法区分。为此复制时用 SQLite 的 quote() 逐列取值——返回带类型、无精度损失的
 * SQL 字面量（NULL / 12345 / 1.5 / 'text' / X'0a1b'），原样拼成 INSERT 在明文库执行，
 * BLOB / int64 / text / real / null 全部忠实还原。
 */
import Database from 'better-sqlite3'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { dbAdapter } from './dbAdapter'
import { resolveDbStoragePath } from './dbStoragePaths'

export interface DatabaseExportContext {
  dbPath: string
  wxid: string
  hasDecryptKey: boolean
}

export interface DatabaseFileInfo {
  path: string
  name: string
  relativePath: string
  folder: string
  size: number
}

export interface DatabaseScanResult {
  success: boolean
  root?: string
  databases?: DatabaseFileInfo[]
  error?: string
}

export interface DatabaseExportProgress {
  current: number
  total: number
  currentSession: string // 复用现有 export:progress 字段名，这里是库名
  detail: string // 当前表名
  phase: string
}

export interface DatabaseTableError {
  db: string
  table: string
  error: string
}

export interface DatabaseExportResult {
  success: boolean
  successCount?: number
  failCount?: number
  error?: string
  outputDir?: string
  tableErrors?: DatabaseTableError[]
}

// path 为绝对路径时原生会忽略 kind，这里给个占位值即可
const QUERY_KIND = 'message'
const SELECT_BATCH = 1000
const INSERT_CHUNK = 200
const DATABASE_SCAN_ERROR = '无法读取当前账号的数据库目录，请检查账号配置后重试。'
const INVALID_CONTEXT_ERROR = '数据库导出上下文缺失或无效，请检查账号配置后重试。'
const INVALID_SELECTED_PATH_ERROR = '所选数据库不属于当前账号的 db_storage 目录，已拒绝导出。'
const MISSING_DECRYPT_KEY_ERROR = '当前账号缺少有效的解密密钥，无法导出数据库。'

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`
}

function normalizeAbsolutePath(value: string): string {
  return normalize(resolve(value))
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(normalizeAbsolutePath(root), normalizeAbsolutePath(candidate))
  const comparisonPath = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath
  return (
    relativePath !== '' &&
    comparisonPath !== '..' &&
    !comparisonPath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

function isRealDirectory(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function isRegularFile(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function walkDbFiles(root: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 6) return acc
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = normalizeAbsolutePath(join(root, entry.name))
    if (!isPathInside(root, full)) continue

    let info
    try {
      info = lstatSync(full)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue

    if (info.isFile()) {
      // 只收 .db 本体；.db-wal / .db-shm / .db-journal 因不以 .db 结尾自然被排除
      if (entry.name.toLowerCase().endsWith('.db')) acc.push(full)
    } else if (info.isDirectory()) {
      walkDbFiles(full, depth + 1, acc)
    }
  }
  return acc
}

function isValidDatabaseExportContext(context: unknown): context is DatabaseExportContext {
  if (!context || typeof context !== 'object') return false
  const value = context as Partial<DatabaseExportContext>
  return (
    typeof value.dbPath === 'string' && value.dbPath.trim().length > 0 &&
    typeof value.wxid === 'string' && value.wxid.trim().length > 0 &&
    typeof value.hasDecryptKey === 'boolean'
  )
}

function resolveExportRoot(context: unknown): { root: string } | { error: string } {
  if (!isValidDatabaseExportContext(context)) return { error: INVALID_CONTEXT_ERROR }

  const root = resolveDbStoragePath(context.dbPath.trim(), context.wxid.trim())
  if (!root || !isRealDirectory(root)) return { error: DATABASE_SCAN_ERROR }
  return { root: normalizeAbsolutePath(root) }
}

function isSafePathTree(root: string, candidate: string): boolean {
  if (!isPathInside(root, candidate)) return false

  const relativePath = relative(normalizeAbsolutePath(root), normalizeAbsolutePath(candidate))
  const parts = relativePath.split(sep).filter(Boolean)
  let current = normalizeAbsolutePath(root)
  for (let index = 0; index < parts.length; index++) {
    current = normalizeAbsolutePath(join(current, parts[index]))
    let info
    try {
      info = lstatSync(current)
    } catch {
      return false
    }
    if (info.isSymbolicLink()) return false
    if (index === parts.length - 1) {
      if (!info.isFile()) return false
    } else if (!info.isDirectory()) {
      return false
    }
  }
  return parts.length > 0
}

function validateSelectedPath(root: string, selectedPath: unknown): string | null {
  if (typeof selectedPath !== 'string' || selectedPath.trim().length === 0) return null
  const candidate = normalizeAbsolutePath(selectedPath)
  if (!candidate.toLowerCase().endsWith('.db')) return null
  if (!isSafePathTree(root, candidate)) return null
  return isRegularFile(candidate) ? candidate : null
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatTimestamp(): string {
  const d = new Date()
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  )
}

export class DatabaseExportService {
  /** 扫描 db_storage 下所有 .db 文件（含体积），供前端左侧列出勾选。 */
  async scanDatabases(context: DatabaseExportContext): Promise<DatabaseScanResult> {
    try {
      const resolved = resolveExportRoot(context)
      if ('error' in resolved) return { success: false, error: resolved.error }
      const { root } = resolved

      const files = walkDbFiles(root)
      const databases: DatabaseFileInfo[] = files
        .map((p) => {
          let size = 0
          try {
            size = lstatSync(p).size
          } catch {
            /* ignore */
          }
          const rel = relative(root, p).replace(/\\/g, '/')
          const dir = dirname(rel)
          return {
            path: p,
            name: basename(p),
            relativePath: rel,
            folder: dir === '.' ? '' : dir,
            size
          }
        })
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      return { success: true, root, databases }
    } catch {
      return { success: false, error: DATABASE_SCAN_ERROR }
    }
  }

  /** 把选中的加密库逐个解密落地为明文 SQLite，每库一个同名 .db。 */
  async exportDatabases(
    selectedPaths: string[],
    outputDir: string,
    context: DatabaseExportContext,
    onProgress?: (progress: DatabaseExportProgress) => void
  ): Promise<DatabaseExportResult> {
    try {
      const resolved = resolveExportRoot(context)
      if ('error' in resolved) return { success: false, error: resolved.error }
      const { root } = resolved

      if (!isValidDatabaseExportContext(context) || !context.hasDecryptKey) {
        return { success: false, error: MISSING_DECRYPT_KEY_ERROR }
      }
      if (!Array.isArray(selectedPaths) || selectedPaths.length === 0) {
        return { success: false, error: '未选择任何数据库' }
      }

      const validatedPaths = selectedPaths.map((selectedPath) => validateSelectedPath(root, selectedPath))
      if (validatedPaths.some((path): path is null => path === null)) {
        return { success: false, error: INVALID_SELECTED_PATH_ERROR }
      }

      const subDir = join(outputDir, `数据库导出_${formatTimestamp()}`)
      mkdirSync(subDir, { recursive: true })

      const total = validatedPaths.length
      let successCount = 0
      let failCount = 0
      const tableErrors: DatabaseTableError[] = []
      const usedNames = new Set<string>()

      for (let i = 0; i < total; i++) {
        const srcPath = validatedPaths[i] as string
        const dbName = basename(srcPath)
        onProgress?.({ current: i, total, currentSession: dbName, detail: '', phase: 'exporting' })

        // 重名（如多个 message_*.db 同名场景）用父目录名前缀避免覆盖
        let outName = dbName
        if (usedNames.has(outName.toLowerCase())) {
          outName = `${basename(dirname(srcPath))}_${dbName}`
        }
        usedNames.add(outName.toLowerCase())
        const outPath = join(subDir, outName)

        try {
          const errs = await this.exportOneDatabase(srcPath, outPath, dbName, (table) => {
            onProgress?.({ current: i, total, currentSession: dbName, detail: table, phase: 'exporting' })
          })
          tableErrors.push(...errs)
          successCount++
          onProgress?.({ current: i + 1, total, currentSession: dbName, detail: '已完成当前数据库', phase: 'exporting' })
        } catch (e) {
          failCount++
          tableErrors.push({
            db: dbName,
            table: '(整库)',
            error: e instanceof Error ? e.message : String(e)
          })
          onProgress?.({
            current: i + 1,
            total,
            currentSession: dbName,
            detail: `当前数据库导出失败: ${e instanceof Error ? e.message : String(e)}`,
            phase: 'exporting'
          })
        }
      }

      onProgress?.({ current: total, total, currentSession: '', detail: '', phase: 'complete' })

      return {
        success: successCount > 0,
        successCount,
        failCount,
        outputDir: subDir,
        tableErrors: tableErrors.length ? tableErrors : undefined,
        error: successCount === 0 ? tableErrors[0]?.error || '导出失败' : undefined
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async exportOneDatabase(
    srcPath: string,
    outPath: string,
    dbName: string,
    onTable?: (table: string) => void
  ): Promise<DatabaseTableError[]> {
    const objects = await dbAdapter.all<{ type: string; name: string; sql: string }>(
      QUERY_KIND,
      srcPath,
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL"
    )

    if (existsSync(outPath)) {
      try {
        rmSync(outPath)
      } catch {
        /* ignore，下面 new Database 会再报错 */
      }
    }

    const errs: DatabaseTableError[] = []
    const out = new Database(outPath)
    try {
      out.pragma('journal_mode = OFF')
      out.pragma('synchronous = OFF')

      const tables = objects.filter((o) => o.type === 'table')
      const others = objects.filter((o) => o.type !== 'table') // index / trigger / view

      // 先建表并灌数据
      for (const t of tables) {
        onTable?.(t.name)
        try {
          out.exec(t.sql)
          await this.copyTableData(srcPath, t.name, out)
        } catch (e) {
          errs.push({ db: dbName, table: t.name, error: e instanceof Error ? e.message : String(e) })
        }
      }

      // 再建 index / trigger / view（依赖表已存在）
      for (const o of others) {
        try {
          out.exec(o.sql)
        } catch (e) {
          errs.push({ db: dbName, table: o.name, error: e instanceof Error ? e.message : String(e) })
        }
      }
    } finally {
      out.close()
    }
    return errs
  }

  /** 用 quote() 逐列读出 SQL 字面量，拼 INSERT 灌入明文库，忠实保留 BLOB / int64 / text。 */
  private async copyTableData(srcPath: string, table: string, out: Database.Database): Promise<void> {
    const cols = await dbAdapter.all<{ name: string }>(
      QUERY_KIND,
      srcPath,
      `PRAGMA table_info(${quoteIdent(table)})`
    )
    const colNames = cols.map((c) => c.name)
    if (colNames.length === 0) return

    const quotedCols = colNames.map(quoteIdent).join(', ')
    // 别名 c0/c1... 保证按顺序取值，规避对象键名/顺序不确定
    const selectExpr = colNames.map((c, i) => `quote(${quoteIdent(c)}) AS c${i}`).join(', ')
    const insertHead = `INSERT INTO ${quoteIdent(table)} (${quotedCols}) VALUES `

    let offset = 0
    for (;;) {
      const rows = await dbAdapter.all<Record<string, string>>(
        QUERY_KIND,
        srcPath,
        `SELECT ${selectExpr} FROM ${quoteIdent(table)} LIMIT ${SELECT_BATCH} OFFSET ${offset}`
      )
      if (rows.length === 0) break

      // quote() 永远返回非空字符串字面量（NULL 列返回文本 'NULL'），直接拼接即为合法 SQL
      const tuples = rows.map((row) => {
        const vals = colNames.map((_, i) => row[`c${i}`])
        return `(${vals.join(',')})`
      })

      out.exec('BEGIN')
      try {
        for (let i = 0; i < tuples.length; i += INSERT_CHUNK) {
          const chunk = tuples.slice(i, i + INSERT_CHUNK)
          out.exec(insertHead + chunk.join(',') + ';')
        }
        out.exec('COMMIT')
      } catch (e) {
        try {
          out.exec('ROLLBACK')
        } catch {
          /* ignore */
        }
        throw e
      }

      if (rows.length < SELECT_BATCH) break
      offset += SELECT_BATCH
    }
  }
}

export const databaseExportService = new DatabaseExportService()
