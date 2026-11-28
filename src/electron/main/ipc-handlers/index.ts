import { registerConfigIPCHandlers } from './config'
import { registerFileIPCHandlers } from './file'
import { registerAIServiceIPCHandlers } from './ai-service'
import { registerAnalysisQueueIPCHandlers } from './analysis-queue'
import { registerVirtualDirectoryIPCHandlers } from './virtual-directory'
import { registerHardwareIPCHandlers } from './hardware'
import { registerWindowIPCHandlers } from './window'
import { registerQueueWindowIPCHandlers } from './queue-window-ipc'
import { registerMiscIPCHandlers } from './misc'
import { registerEngineBridgeIPCHandlers } from './engine-bridge'
import { registerUpdateIPCHandlers } from './update'
import { registerTTSIPCHandlers } from './tts'
import { registerDeviceBindIPCHandlers } from './device-bind'
import { registerPreviewIPCHandlers } from './preview'
import { registerVoiceIPCHandlers } from './voice'
import { registerExternalApiIPCHandlers } from './external-api'
import { registerModularResourceIpcHandlers } from '../../runtime-services/ipc/modular-resource-ipc-handler'
import { registerHibernationIPCHandlers } from '../../runtime-services/ipc/hibernation-ipc-handler'
import { logger, LogCategory } from '@firefly/shared'

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
  registerEngineBridgeIPCHandlers()
  registerUpdateIPCHandlers()
  registerTTSIPCHandlers()
  registerDeviceBindIPCHandlers()
  registerPreviewIPCHandlers()
  registerVoiceIPCHandlers()
  registerExternalApiIPCHandlers()
  registerModularResourceIpcHandlers()
  registerHibernationIPCHandlers()

  logger.info(LogCategory.MAIN, '[IPC] 所有 IPC 处理程序注册完成')
}
