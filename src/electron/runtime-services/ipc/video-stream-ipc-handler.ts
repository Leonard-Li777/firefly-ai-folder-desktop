/**
 * 本地 HTTP 双路视频流式播放 IPC 处理器
 * 所有异常统一结构化返回，绝不向 renderer 抛 unhandled rejection。
 */

import { ipcMain } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import { localVideoStreamService } from '../system/local-video-stream-service'

export function registerVideoStreamIpcHandlers(): void {
  localVideoStreamService.installQuitHook()
  logger.info(LogCategory.MAIN, '正在注册视频流 IPC 处理器...')

  ipcMain.handle(
    'video-stream:prepare',
    async (_event, payload: { filePath?: unknown; startSec?: unknown }) => {
      try {
        const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
        // 非法 startSec 不在此静默归一：交给 service 统一返回 INVALID_SEEK_PARAM
        const startSec = (payload?.startSec === undefined ? 0 : payload.startSec) as number
        return await localVideoStreamService.prepare(filePath, startSec)
      } catch (err: unknown) {
        logger.warn(LogCategory.MAIN, '[视频流] prepare IPC 异常:', err)
        return { success: false, error: '视频流准备失败' }
      }
    }
  )

  ipcMain.handle(
    'video-stream:seek',
    async (_event, payload: { streamId?: unknown; targetSec?: unknown }) => {
      try {
        const streamId = typeof payload?.streamId === 'string' ? payload.streamId : ''
        const targetSec = payload?.targetSec as number
        return await localVideoStreamService.seek(streamId, targetSec)
      } catch (err: unknown) {
        logger.warn(LogCategory.MAIN, '[视频流] seek IPC 异常:', err)
        return { success: false, error: '视频流定位失败' }
      }
    }
  )

  ipcMain.handle('video-stream:release', async (_event, payload: { streamId?: unknown }) => {
    try {
      const streamId = typeof payload?.streamId === 'string' ? payload.streamId : ''
      return localVideoStreamService.release(streamId)
    } catch (err: unknown) {
      logger.warn(LogCategory.MAIN, '[视频流] release IPC 异常:', err)
      return { success: false }
    }
  })
}
