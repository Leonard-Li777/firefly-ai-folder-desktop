/**
 * 模块休眠与能耗透明 IPC 处理器
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §3.4.1
 */

import { BrowserWindow, ipcMain } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import {
  moduleHibernationCoordinator,
  ModuleHibernationCoordinator
} from '../hibernation/module-hibernation-coordinator'
import { HibernationSnapshot } from '../hibernation/types'

export interface IpcMainLike {
  handle: (channel: string, handler: (...args: any[]) => any) => void
  removeHandler: (channel: string) => void
}

let unbindCoordinatorListener: (() => void) | null = null

/**
 * 全文所有向渲染层推送事件统一经 safeSendToRenderer 守卫，防窗口销毁/重建过渡期崩溃
 */
export function safeBroadcastHibernationSnapshot(snapshot: HibernationSnapshot): void {
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        // 主契约通道
        win.webContents.send('module-hibernation:snapshot-changed', snapshot)
        // 兼容别名通道
        win.webContents.send('hibernation-snapshot-changed', snapshot)
      }
    }
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[HibernationIPC] 广播休眠快照失败:', err)
  }
}

/**
 * 注册模块休眠与能耗透视 IPC 处理器
 */
export function registerHibernationIPCHandlers(
  coordinator: ModuleHibernationCoordinator = moduleHibernationCoordinator,
  ipc: IpcMainLike = ipcMain
): () => void {
  logger.info(LogCategory.SYSTEM, '[HibernationIPC] 正在注册模块休眠 IPC 通道...')

  // 1. 获取休眠快照
  const handleGetSnapshot = async (): Promise<HibernationSnapshot> => {
    return coordinator.getSnapshot()
  }
  ipc.handle('module-hibernation:get-snapshot', handleGetSnapshot)
  ipc.handle('get-hibernation-snapshot', handleGetSnapshot)

  // 2. 一键释放全量空闲可休眠模块
  const handleReclaimAll = async (): Promise<{ success: boolean; releasedBytes: number }> => {
    return coordinator.reclaimAll()
  }
  ipc.handle('module-hibernation:reclaim-all', handleReclaimAll)
  ipc.handle('reclaim-all-hibernatable-modules', handleReclaimAll)

  // 3. 手动解除持久门闩
  ipc.handle('module-hibernation:force-reset', async (_event, targetId: string) => {
    return coordinator.forceReset(targetId)
  })

  // 4. 重试处于 error 态的模块
  ipc.handle('module-hibernation:retry-module', async (_event, targetId: string) => {
    return coordinator.retryModule(targetId)
  })

  // 绑定协调器快照变更广播
  if (unbindCoordinatorListener) {
    unbindCoordinatorListener()
  }
  unbindCoordinatorListener = coordinator.onSnapshotChanged(snapshot => {
    safeBroadcastHibernationSnapshot(snapshot)
  })

  // 返回清理函数
  return () => {
    ipc.removeHandler('module-hibernation:get-snapshot')
    ipc.removeHandler('get-hibernation-snapshot')
    ipc.removeHandler('module-hibernation:reclaim-all')
    ipc.removeHandler('reclaim-all-hibernatable-modules')
    ipc.removeHandler('module-hibernation:force-reset')
    ipc.removeHandler('module-hibernation:retry-module')
    if (unbindCoordinatorListener) {
      unbindCoordinatorListener()
      unbindCoordinatorListener = null
    }
  }
}
