import { useState, useEffect, useCallback, useRef } from 'react'
import type { DatabaseFile } from '../types'
import type { ExportShared } from './useExportShared'

const DEFAULT_SCAN_ERROR = '无法读取当前账号的数据库目录，请检查账号配置后重试。'

function sanitizeScanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  if (!message.trim() || /[0-9a-fA-F]{64}/.test(message)) return DEFAULT_SCAN_ERROR
  return message
    .replace(/[A-Za-z]:[\\/][^"'`\r\n,}\]]+/g, '[路径]')
    .replace(/\\\\[^"'`\r\n,}\]]+/g, '[路径]')
}

export function useDatabaseExport(shared: ExportShared, active: boolean) {
  const [databases, setDatabases] = useState<DatabaseFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchKeyword, setSearchKeyword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  const loadDatabases = useCallback(async () => {
    setIsLoading(true)
    setScanError(null)
    setSelected(new Set())
    try {
      const result = await window.electronAPI.export.scanDatabases()
      if (result.success && result.databases) {
        setDatabases(result.databases)
        setScanError(null)
      } else {
        setDatabases([])
        setScanError(result.error || DEFAULT_SCAN_ERROR)
      }
    } catch (e) {
      console.error('扫描数据库失败:', e)
      setDatabases([])
      setScanError(sanitizeScanError(e))
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 切换到本 tab 时首次加载；用 ref 防止成功但为空时因 databases.length === 0 重复请求。
  const hasRequestedRef = useRef(false)
  useEffect(() => {
    if (!active) {
      hasRequestedRef.current = false
      return
    }
    if (!hasRequestedRef.current) {
      hasRequestedRef.current = true
      void loadDatabases()
    }
  }, [active, loadDatabases])

  const keyword = searchKeyword.trim().toLowerCase()
  const filteredDatabases = keyword
    ? databases.filter(
        (d) =>
          d.name.toLowerCase().includes(keyword) || d.relativePath.toLowerCase().includes(keyword)
      )
    : databases

  const toggleSelectAll = () => {
    if (selected.size === filteredDatabases.length && filteredDatabases.length > 0) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filteredDatabases.map((d) => d.path)))
    }
  }

  const startDatabaseExport = async () => {
    if (!shared.exportFolder || selected.size === 0) return

    shared.setIsExporting(true)
    shared.setExportProgress({ current: 0, total: selected.size, currentName: '', phase: '准备导出', detail: '' })
    shared.setExportResult(null)
    try {
      const result = await window.electronAPI.export.exportDatabases(
        Array.from(selected),
        shared.exportFolder
      )
      shared.setExportResult(result)
    } catch (e) {
      console.error('导出数据库失败:', e)
      shared.setExportResult({ success: false, error: String(e) })
    } finally {
      shared.setIsExporting(false)
    }
  }

  return {
    databases,
    filteredDatabases,
    selected,
    setSelected,
    searchKeyword,
    setSearchKeyword,
    isLoading,
    scanError,
    loadDatabases,
    toggleSelectAll,
    startDatabaseExport
  }
}
