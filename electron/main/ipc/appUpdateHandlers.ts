import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, ipcMain, shell } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { appUpdateService } from '../../services/appUpdateService'
import type { MainProcessContext } from '../context'

/**
 * 应用更新下载与安装 IPC。
 * 这里维护“是否正在安装”的共享状态，并把下载进度继续广播给所有窗口。
  */
export function registerAppUpdateHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('app:downloadAndInstall', async () => {
    if (ctx.getIsInstallingUpdate()) {
      ctx.getLogService()?.warn('AppUpdate', '下载更新请求被忽略，当前已有下载任务进行中', {
        targetVersion: appUpdateService.getCachedUpdateInfo()?.version
      })
      return
    }

    ctx.setIsInstallingUpdate(true)
    const cachedUpdateInfo = appUpdateService.getCachedUpdateInfo()
    const targetVersion = cachedUpdateInfo?.version

    appUpdateService.updateDiagnostics({
      phase: 'downloading',
      targetVersion,
      lastError: undefined,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: undefined,
      lastEvent: targetVersion ? `开始下载更新 ${targetVersion}` : '开始下载更新'
    })
    ctx.getLogService()?.info('AppUpdate', '开始下载更新', { targetVersion, differentialEnabled: !autoUpdater.disableDifferentialDownload })

    // 开发模式：模拟下载进度，便于本地测试更新进度 UI（不真实下载、不触发安装）
    if (process.env.VITE_DEV_SERVER_URL) {
      await simulateDownloadProgress(ctx, targetVersion)
      ctx.setIsInstallingUpdate(false)
      return
    }

    if (process.platform === 'darwin') {
      try {
        await downloadAndOpenMacDmg(ctx, targetVersion)
      } catch (error) {
        ctx.setIsInstallingUpdate(false)
        appUpdateService.updateDiagnostics({
          phase: 'failed',
          lastError: String(error),
          lastEvent: '下载或打开 macOS 更新包失败'
        })
        ctx.getLogService()?.error('AppUpdate', '下载或打开 macOS 更新包失败', {
          targetVersion,
          error: String(error)
        })
        throw error
      }
      return
    }

    const onDownloadProgress = (progress: ProgressInfo) => {
      const payload = {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      }
      ctx.broadcastToWindows('app:downloadProgress', payload)
      appUpdateService.updateDiagnostics({
        phase: 'downloading',
        progressPercent: progress.percent,
        downloadedBytes: progress.transferred,
        totalBytes: progress.total,
        lastEvent: `下载中 ${progress.percent.toFixed(1)}%`
      })
    }

    const onUpdateDownloaded = () => {
      appUpdateService.updateDiagnostics({
        phase: 'downloaded',
        progressPercent: 100,
        lastEvent: '更新包下载完成，准备安装'
      })
      ctx.getLogService()?.info('AppUpdate', '更新包下载完成，准备安装', {
        targetVersion,
        fallbackToFull: appUpdateService.getCachedUpdateInfo()?.diagnostics?.fallbackToFull || false
      })
      ctx.appWithQuitFlag.isQuitting = true
      appUpdateService.updateDiagnostics({
        phase: 'installing',
        lastEvent: '开始调用安装器'
      })
      autoUpdater.quitAndInstall(false, true)
    }

    const onUpdaterError = (error: Error) => {
      ctx.setIsInstallingUpdate(false)
      appUpdateService.updateDiagnostics({
        phase: 'failed',
        lastError: String(error),
        lastEvent: '下载或安装更新失败'
      })
      ctx.getLogService()?.error('AppUpdate', '下载或安装更新失败', {
        targetVersion,
        error: String(error),
        fallbackToFull: appUpdateService.getCachedUpdateInfo()?.diagnostics?.fallbackToFull || false
      })
    }

    autoUpdater.on('download-progress', onDownloadProgress)
    autoUpdater.once('update-downloaded', onUpdateDownloaded)
    autoUpdater.once('error', onUpdaterError)

    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      ctx.setIsInstallingUpdate(false)
      onUpdaterError(error as Error)
      throw error
    } finally {
      autoUpdater.removeListener('download-progress', onDownloadProgress)
      autoUpdater.removeListener('update-downloaded', onUpdateDownloaded)
      autoUpdater.removeListener('error', onUpdaterError)
    }
  })

}

async function downloadAndOpenMacDmg(ctx: MainProcessContext, targetVersion?: string): Promise<void> {
  const updateInfo = appUpdateService.getCachedUpdateInfo()
  if (!updateInfo?.downloadUrl || !updateInfo.sha512) {
    throw new Error('缺少 macOS DMG 更新地址或校验信息，请重新检查更新')
  }

  const downloadUrl = new URL(updateInfo.downloadUrl)
  if (downloadUrl.protocol !== 'https:' || !downloadUrl.pathname.toLowerCase().endsWith('.dmg')) {
    throw new Error('macOS 更新包地址无效')
  }

  const safeVersion = (targetVersion || 'latest').replace(/[^0-9A-Za-z._-]/g, '_')
  const downloadDir = path.join(app.getPath('temp'), 'ciphertalk-updates')
  const finalPath = path.join(downloadDir, `CipherTalk-${safeVersion}-Setup.dmg`)
  const partialPath = `${finalPath}.download`
  await mkdir(downloadDir, { recursive: true })
  await rm(partialPath, { force: true })

  try {
    const response = await fetch(downloadUrl, {
      cache: 'no-store',
      redirect: 'follow'
    })
    if (!response.ok || !response.body) {
      throw new Error(`下载 macOS 更新包失败: HTTP ${response.status}`)
    }

    const headerSize = Number(response.headers.get('content-length'))
    const total = Number.isFinite(headerSize) && headerSize > 0
      ? headerSize
      : updateInfo.fileSize || 0
    const hash = createHash('sha512')
    const startedAt = Date.now()
    let lastProgressAt = 0
    let transferred = 0

    const progressStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferred += chunk.length
        hash.update(chunk)
        const now = Date.now()
        if (now - lastProgressAt < 200 && (total <= 0 || transferred < total)) {
          callback(null, chunk)
          return
        }
        lastProgressAt = now
        const percent = total > 0 ? Math.min(100, (transferred / total) * 100) : 0
        const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001)
        const payload = {
          percent,
          transferred,
          total,
          bytesPerSecond: Math.round(transferred / elapsedSeconds)
        }
        ctx.broadcastToWindows('app:downloadProgress', payload)
        appUpdateService.updateDiagnostics({
          phase: 'downloading',
          strategy: 'full',
          progressPercent: percent,
          downloadedBytes: transferred,
          totalBytes: total || undefined,
          lastEvent: total > 0 ? `下载中 ${percent.toFixed(1)}%` : '正在下载 DMG 更新包'
        })
        callback(null, chunk)
      }
    })

    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      progressStream,
      createWriteStream(partialPath)
    )

    const actualSha512 = hash.digest('base64')
    if (actualSha512 !== updateInfo.sha512) {
      throw new Error('macOS 更新包校验失败，请重新下载')
    }

    await rm(finalPath, { force: true })
    await rename(partialPath, finalPath)
    ctx.broadcastToWindows('app:downloadProgress', {
      percent: 100,
      transferred,
      total: total || transferred,
      bytesPerSecond: 0
    })
    appUpdateService.updateDiagnostics({
      phase: 'downloaded',
      strategy: 'full',
      progressPercent: 100,
      downloadedBytes: transferred,
      totalBytes: total || transferred,
      lastEvent: 'DMG 更新包下载完成，准备打开'
    })

    const openError = await shell.openPath(finalPath)
    if (openError) {
      throw new Error(`无法打开 macOS 更新包: ${openError}`)
    }

    ctx.getLogService()?.info('AppUpdate', 'DMG 更新包已打开，正在退出应用', {
      targetVersion,
      filePath: finalPath
    })
    appUpdateService.updateDiagnostics({
      phase: 'installing',
      lastEvent: 'DMG 更新包已打开，正在退出应用'
    })
    ctx.appWithQuitFlag.isQuitting = true
    app.quit()
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 开发模式专用：模拟下载进度广播，用于本地测试更新进度 UI。
 * 不真实下载安装包，也不触发 quitAndInstall。
 */
async function simulateDownloadProgress(ctx: MainProcessContext, targetVersion?: string): Promise<void> {
  const totalBytes = Math.round(179.5 * 1024 * 1024)
  let percent = 0

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      percent = Math.min(100, percent + Math.random() * 5 + 1.5)
      const transferred = Math.round((percent / 100) * totalBytes)
      const bytesPerSecond = Math.round(220 * 1024 + Math.random() * 400 * 1024)

      ctx.broadcastToWindows('app:downloadProgress', {
        percent,
        transferred,
        total: totalBytes,
        bytesPerSecond
      })
      appUpdateService.updateDiagnostics({
        phase: 'downloading',
        progressPercent: percent,
        downloadedBytes: transferred,
        totalBytes,
        lastEvent: `模拟下载中 ${percent.toFixed(1)}%`
      })

      if (percent >= 100) {
        clearInterval(timer)
        appUpdateService.updateDiagnostics({
          phase: 'downloaded',
          progressPercent: 100,
          lastEvent: '模拟更新下载完成（开发模式不执行安装）'
        })
        ctx.getLogService()?.info('AppUpdate', '模拟更新完成（开发模式）', { targetVersion })
        resolve()
      }
    }, 450)
  })
}
