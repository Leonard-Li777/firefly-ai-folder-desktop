import { registerConfigIPCHandlers } from './config'
import { registerFileIPCHandlers } from './file'
import { registerAIServiceIPCHandlers } from './ai-service'
import { registerAnalysisQueueIPCHandlers } from './analysis-queue'
import { registerVirtualDirectoryIPCHandlers } from './virtual-directory'
import { registerHardwareIPCHandlers } from './hardware'
import { registerWindowIPCHandlers } from './window'
import { registerQueueWindowIPCHandlers } from './queue-window-ipc'
import { registerMiscIPCHandlers } from './misc'
import { syncedDirectories } from '../state'
import { logger, LogCategory } from '@firefly/shared'

let syncedDirectoriesCleanupInterval: ReturnType<typeof setInterval> | null = null

export async function setupIPCHandlers(): Promise<void> {
  registerConfigIPCHandlers()
  registerFileIPCHandlers()
  registerAIServiceIPCHandlers()
  registerAnalysisQueueIPCHandlers()
  registerVirtualDirectoryIPCHandlers()
  registerHardwareIPCHandlers()
  registerWindowIPCHandlers()
  registerQueueWindowIPCHandlers()
  registerMiscIPCHandlers()

  if (syncedDirectoriesCleanupInterval) {
    clearInterval(syncedDirectoriesCleanupInterval)
  }
  syncedDirectoriesCleanupInterval = setInterval(
    () => {
      if (syncedDirectories.size > 50) {
        const entries = Array.from(syncedDirectories)
        syncedDirectories.clear()
        entries.slice(-50).forEach(dir => syncedDirectories.add(dir))
      }
    },
    5 * 60 * 1000
  )

  logger.info(LogCategory.MAIN, '[IPC] 所有 IPC 处理程序注册完成')
}
