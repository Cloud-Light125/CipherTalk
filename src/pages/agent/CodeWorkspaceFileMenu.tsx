/**
 * 代码工作区文件树右键菜单 —— portal 到 body 并按鼠标坐标定位（贴边自动翻转），
 * 与聊天页消息右键菜单同一套交互习惯（见 chat/components/portals/ContextMenuPortal.tsx）。
 * 菜单只负责触发回调，路径解析、读写文件都在调用方。
 */
import { createPortal } from 'react-dom'
import { Dropdown, Label } from '@heroui/react'
import { ArrowsRotateLeft, ArrowUpRightFromSquare, At, ChevronRight, Code, Copy, FolderMagnifier, FolderOpen } from '@gravity-ui/icons'
import type { CodeWorkspaceFileItem } from '@/types/electron'

export type CodeWorkspaceFileMenuState = {
  item: CodeWorkspaceFileItem
  /** 工作区根 + 相对路径，供 shell 打开/定位 */
  absPath: string
  expanded: boolean
  x: number
  y: number
}

export type CodeWorkspaceFileMenuProps = {
  /** 无会话时禁用「在画布中打开」（画布必须挂在会话下） */
  canOpenInCanvas: boolean
  menu: CodeWorkspaceFileMenuState | null
  onClose: () => void
  onCopied: (message: string) => void
  onOpenInCanvas: (item: CodeWorkspaceFileItem) => void
  onRefreshDirectory: (item: CodeWorkspaceFileItem) => void
  onReference: (item: CodeWorkspaceFileItem) => void
  onToggleDirectory: (item: CodeWorkspaceFileItem) => void
}

const MENU_WIDTH = 208
const EDGE_PADDING = 8

export function CodeWorkspaceFileMenu({
  canOpenInCanvas,
  menu,
  onClose,
  onCopied,
  onOpenInCanvas,
  onRefreshDirectory,
  onReference,
  onToggleDirectory,
}: CodeWorkspaceFileMenuProps) {
  if (!menu) return null

  const isDir = menu.item.type === 'dir'
  const itemCount = isDir ? 5 : 6
  const estimatedHeight = itemCount * 36 + 12
  const openLeft = window.innerWidth - menu.x - EDGE_PADDING < MENU_WIDTH && menu.x > window.innerWidth / 2
  const openAbove = window.innerHeight - menu.y - EDGE_PADDING < estimatedHeight && menu.y > estimatedHeight

  const menuStyle = {
    ...(openLeft
      ? { right: Math.max(EDGE_PADDING, window.innerWidth - menu.x) }
      : { left: Math.max(EDGE_PADDING, Math.min(menu.x, window.innerWidth - MENU_WIDTH - EDGE_PADDING)) }),
    ...(openAbove
      ? { bottom: Math.max(EDGE_PADDING, window.innerHeight - menu.y) }
      : { top: Math.max(EDGE_PADDING, Math.min(menu.y, window.innerHeight - estimatedHeight - EDGE_PADDING)) }),
    maxHeight: `calc(100vh - ${EDGE_PADDING * 2}px)`,
  }

  const copyText = async (text: string, message: string) => {
    onClose()
    if (!navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(text)
    onCopied(message)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[10000]"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        className="fixed z-[10002] min-w-52 overflow-y-auto rounded-(--agent-radius,12px) border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        style={menuStyle}
      >
        <Dropdown.Menu aria-label="文件操作">
          {isDir ? (
            <Dropdown.Item
              id="toggle"
              onAction={() => { onToggleDirectory(menu.item); onClose() }}
              textValue={menu.expanded ? '折叠目录' : '展开目录'}
            >
              <ChevronRight className={`size-4 shrink-0 text-muted transition-transform ${menu.expanded ? 'rotate-90' : ''}`} />
              <Label>{menu.expanded ? '折叠目录' : '展开目录'}</Label>
            </Dropdown.Item>
          ) : (
            <Dropdown.Item
              id="open-canvas"
              isDisabled={!canOpenInCanvas}
              onAction={() => { onOpenInCanvas(menu.item); onClose() }}
              textValue="在画布中打开"
            >
              <Code className="size-4 shrink-0 text-muted" />
              <Label>在画布中打开</Label>
            </Dropdown.Item>
          )}
          {isDir ? (
            <Dropdown.Item
              id="refresh"
              onAction={() => { onRefreshDirectory(menu.item); onClose() }}
              textValue="刷新此目录"
            >
              <ArrowsRotateLeft className="size-4 shrink-0 text-muted" />
              <Label>刷新此目录</Label>
            </Dropdown.Item>
          ) : (
            <Dropdown.Item
              id="reference"
              onAction={() => { onReference(menu.item); onClose() }}
              textValue="引用到输入框"
            >
              <At className="size-4 shrink-0 text-muted" />
              <Label>引用到输入框</Label>
            </Dropdown.Item>
          )}
          <Dropdown.Item
            id="open-native"
            onAction={() => {
              onClose()
              void window.electronAPI.shell.openPath(menu.absPath)
            }}
            textValue={isDir ? '在文件管理器中打开' : '用默认程序打开'}
          >
            {isDir ? <FolderOpen className="size-4 shrink-0 text-muted" /> : <ArrowUpRightFromSquare className="size-4 shrink-0 text-muted" />}
            <Label>{isDir ? '在文件管理器中打开' : '用默认程序打开'}</Label>
          </Dropdown.Item>
          <Dropdown.Item
            id="reveal"
            onAction={() => {
              onClose()
              void window.electronAPI.shell.showItemInFolder(menu.absPath)
            }}
            textValue="在文件管理器中定位"
          >
            <FolderMagnifier className="size-4 shrink-0 text-muted" />
            <Label>在文件管理器中定位</Label>
          </Dropdown.Item>
          <Dropdown.Item
            id="copy-relative"
            onAction={() => { void copyText(menu.item.path, '已复制相对路径') }}
            textValue="复制相对路径"
          >
            <Copy className="size-4 shrink-0 text-muted" />
            <Label>复制相对路径</Label>
          </Dropdown.Item>
          <Dropdown.Item
            id="copy-absolute"
            onAction={() => { void copyText(menu.absPath, '已复制绝对路径') }}
            textValue="复制绝对路径"
          >
            <Copy className="size-4 shrink-0 text-muted" />
            <Label>复制绝对路径</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </div>
    </div>,
    document.body,
  )
}
