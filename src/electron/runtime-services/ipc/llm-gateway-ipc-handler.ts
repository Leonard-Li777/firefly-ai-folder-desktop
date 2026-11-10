/**
 * apps/desktop/src/electron/runtime-services/ipc/llm-gateway-ipc-handler.ts
 *
 * 统一大模型网关 IPC 接口注册器 (TASK-04 / Spec §3.1, §3.2)
 */

import { ipcMain } from 'electron'
import { llmGatewayService } from '../llm/llm-gateway-service'
import type { GenerativeEngineMode } from '@firefly/shared'

export function registerLlmGatewayIPCHandlers(): void {
  ipcMain.handle('llm-gateway/get-snapshot', async () => {
    return llmGatewayService.getSnapshot()
  })

  ipcMain.handle('llm-gateway/set-desired-mode', async (_event, mode: GenerativeEngineMode) => {
    await llmGatewayService.setDesiredMode(mode)
  })

  ipcMain.handle('llm-gateway/preheat', async (_event, options?: { wait?: boolean }) => {
    await llmGatewayService.preheat(options)
  })

  ipcMain.handle('llm-gateway/drain', async (_event, waitDrainMs?: number) => {
    await llmGatewayService.drain(waitDrainMs)
  })
}
