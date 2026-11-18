import { BrowserWindow } from 'electron'
import type { OmniRuntimeStatus } from './types'

/**
 * 向所有渲染窗口广播基础AI引擎（Omni）状态变更
 * 由状态跃迁点（启动就绪/退出/停止）主动调用，渲染进程无需轮询
 */
export function broadcastOmniStatus(status: OmniRuntimeStatus): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('omni:status-changed', status)
      }
    }
  } catch {}
}
