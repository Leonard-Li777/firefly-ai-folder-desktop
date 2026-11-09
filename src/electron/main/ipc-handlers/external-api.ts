/**
 * 萤核对外接口 IPC 通道处理程序 (External API IPC Handlers)
 * 
 * 对应技术规格说明书: docs/specs/external-api-settings-tab-and-plugin-delist-spec.md §3.2
 */

import { ipcMain, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import type {
  ExternalApiStatusDTO,
  ExternalApiTestResultDTO,
  ExternalApiSetDesiredResult
} from '@firefly/types'
import { aiSkillApiReconciler } from '../../runtime-services/system/ai-skill-reconciler'
import { ConfigOrchestrator } from '../../config/config-orchestrator'

let isRegistered = false

export function registerExternalApiIPCHandlers(): void {
  if (isRegistered) return
  isRegistered = true

  // 1. 纯内存 O(1) 快照查询，禁止任何 fs.existsSync 读盘
  ipcMain.handle('external-api:get-status', async (): Promise<ExternalApiStatusDTO> => {
    return aiSkillApiReconciler.snapshot()
  })

  // 2. 设置期望启闭态并同步全局配置 (10s 超时保护防悬挂，返回判别联合 ExternalApiSetDesiredResult)
  ipcMain.handle(
    'external-api:set-desired',
    async (_event, enabled: boolean): Promise<ExternalApiSetDesiredResult> => {
      try {
        // 同步写入持久化配置真源
        await ConfigOrchestrator.getInstance().updateValue('ENABLE_AI_SKILL_API', Boolean(enabled))

        // 驱动 Reconciler 收敛 (10s 守护)
        const convergencePromise = aiSkillApiReconciler.setDesired(Boolean(enabled)).then(
          (status): ExternalApiSetDesiredResult => ({
            ok: true,
            pending: false,
            status
          })
        )
        const timeoutPromise = new Promise<ExternalApiSetDesiredResult>(resolve => {
          setTimeout(() => {
            logger.warn(LogCategory.SYSTEM, '[ExternalApiIPC] setDesired 等待超时(10s)，返回 pending 快照')
            resolve({
              ok: true,
              pending: true,
              status: aiSkillApiReconciler.snapshot()
            })
          }, 10000)
        })

        return await Promise.race([convergencePromise, timeoutPromise])
      } catch (err: any) {
        logger.error(LogCategory.SYSTEM, '[ExternalApiIPC] setDesired 失败:', err)
        return {
          ok: false,
          error: {
            code: 'INTERNAL',
            message: err.message || '设置服务期望状态失败'
          },
          status: aiSkillApiReconciler.snapshot()
        }
      }
    }
  )

  // 3. 真实环回 HTTP 自检探活 (Node 原生 http.get，带 Nonce 防污染)
  ipcMain.handle(
    'external-api:test-connection',
    async (): Promise<ExternalApiTestResultDTO> => {
      try {
        return await aiSkillApiReconciler.testConnection()
      } catch (err: any) {
        logger.error(LogCategory.SYSTEM, '[ExternalApiIPC] testConnection 异常:', err)
        return {
          success: false,
          latencyMs: null,
          error: {
            code: 'INTERNAL',
            message: err.message || '自检探针执行异常'
          }
        }
      }
    }
  )

  // 4. 主进程事件广播：状态变更时主动向所有渲染窗口推送带有递增 rev 的快照
  aiSkillApiReconciler.onStatusChanged((status: ExternalApiStatusDTO) => {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('external-api:status-changed', status)
        } catch (err) {
          logger.warn(LogCategory.SYSTEM, '[ExternalApiIPC] 推送状态变更失败:', err)
        }
      }
    }
  })

  logger.info(LogCategory.MAIN, '[ExternalApiIPC] 对外接口 IPC 通道注册完成')
}
