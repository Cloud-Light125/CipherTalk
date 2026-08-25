import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { codeWorkspaceService } from '../../services/agent/codeWorkspaceService'

/** UI 侧读写只允许工作区内的相对路径：绝对路径与 .. 一律拒绝（Agent 工具链路不受此限制）。 */
function parseWorkspaceRelativePath(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('path 不能为空')
  if (raw.length > 400) throw new Error('path 过长')
  const normalized = raw.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) throw new Error('只允许工作区内的相对路径')
  if (normalized.split('/').includes('..')) throw new Error('path 不能包含 ..')
  return normalized
}

export function registerAgentWorkspaceHandlers(ctx: MainProcessContext): void {
  codeWorkspaceService.setContext(ctx)

  ipcMain.handle('agentWorkspace:selectWorkspace', async () => {
    return codeWorkspaceService.selectWorkspace()
  })

  ipcMain.handle('agentWorkspace:clearWorkspace', async () => {
    try {
      const state = await codeWorkspaceService.clearWorkspace()
      return { success: true, state }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:stopDevServer', async () => {
    try {
      await codeWorkspaceService.ensureWorkspaceInitialized()
      const result = await codeWorkspaceService.handleToolCall({ method: 'stop_dev_server' })
      return { success: true, result, state: codeWorkspaceService.getState() }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:getState', async () => {
    try {
      await codeWorkspaceService.ensureWorkspaceInitialized()
      return { success: true, state: codeWorkspaceService.getState() }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:setApprovalPolicy', async (_event, policy: unknown) => {
    try {
      const normalized = policy === 'risk-based' || policy === 'full-access' ? policy : 'on-request'
      const state = await codeWorkspaceService.setApprovalPolicy(normalized)
      return { success: true, state }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:listFiles', async (_event, payload: unknown) => {
    try {
      return await codeWorkspaceService.listFilesForUi(payload && typeof payload === 'object' ? payload as Record<string, unknown> : {})
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:readFile', async (_event, payload: unknown) => {
    try {
      const path = parseWorkspaceRelativePath((payload as any)?.path)
      return await codeWorkspaceService.readFileForUi({ path })
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:writeFile', async (_event, payload: unknown) => {
    try {
      const path = parseWorkspaceRelativePath((payload as any)?.path)
      const content = String((payload as any)?.content ?? '')
      return await codeWorkspaceService.writeFileForUi({ path, content })
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:approve', async (_event, requestId: string) => {
    return { success: codeWorkspaceService.approve(String(requestId || '')) }
  })

  ipcMain.handle('agentWorkspace:reject', async (_event, requestId: string) => {
    return { success: codeWorkspaceService.reject(String(requestId || '')) }
  })
}
