/**
 * 预览资源与会话 IPC 处理程序
 * 遵循规格书 docs/specs/file-previewer-engine-and-custom-extensions-spec.md (v1.2)
 */

import { ipcMain } from 'electron'
import { previewResourceService } from '../../runtime-services/preview'
import { logger, LogCategory } from '@firefly/shared'

export function registerPreviewIPCHandlers(): void {
  // 初始化 ff-preview 协议流式处理器
  previewResourceService.initProtocolHandler()

  // 挂载会话
  ipcMain.handle('preview:mount-session', async (_event, sessionId: string, filePath: string) => {
    try {
      return previewResourceService.mountSession(sessionId, filePath)
    } catch (err: any) {
      logger.error(LogCategory.MAIN, `[IPC:preview:mount-session] 异常: ${err?.message}`)
      return false
    }
  })

  // 卸载会话
  ipcMain.handle('preview:unmount-session', async (_event, sessionId: string) => {
    try {
      return previewResourceService.unmountSession(sessionId)
    } catch (err: any) {
      logger.error(LogCategory.MAIN, `[IPC:preview:unmount-session] 异常: ${err?.message}`)
      return false
    }
  })

  logger.info(LogCategory.MAIN, '[IPC] 预览资源 IPC 处理程序注册完成')
}
