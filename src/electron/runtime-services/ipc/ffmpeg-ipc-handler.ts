/**
 * FFmpeg IPC 处理器
 * 处理渲染进程发来的 FFmpeg 相关请求
 */

import { ipcMain } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import { ffmpegService } from '../system/ffmpeg-service'
import { extractVideoFrameAsWebp } from './video-frame-extractor'

export function registerFfmpegIpcHandlers() {
  logger.info(LogCategory.MAIN, '正在注册 FFmpeg IPC 处理器...')

  // 按时间点抽取视频帧（供非原生格式切片预览图使用）
  ipcMain.handle(
    'ffmpeg:extract-frame',
    async (_event, payload: { filePath?: unknown; timestampSec?: unknown }) => {
      try {
        const filePath = typeof payload?.filePath === 'string' ? payload.filePath : ''
        const timestampSec = typeof payload?.timestampSec === 'number' ? payload.timestampSec : 0
        return await extractVideoFrameAsWebp(filePath, timestampSec)
      } catch (err: unknown) {
        // 保证 IPC 永远以结构化结果返回，不把异常直接抛成 renderer 侧 unhandled rejection
        logger.warn(LogCategory.MAIN, '[视频抽帧] IPC 处理异常:', err)
        return { success: false, error: '抽帧服务异常' }
      }
    }
  )

  // 检测安装状态
  ipcMain.handle('ffmpeg:check-installation', async () => {
    return await ffmpegService.detectFfmpegStatus()
  })

  // 检测外部 ffprobe 可用性 (Issue #738 深度清理中心显式门禁)
  ipcMain.handle('ffmpeg:check-ffprobe', async () => {
    try {
      const ffprobePath = await ffmpegService.detectFfprobe()
      return { available: Boolean(ffprobePath), path: ffprobePath }
    } catch (err: any) {
      logger.warn(LogCategory.MAIN, `ffprobe 检测失败: ${err?.message}`)
      return { available: false, path: null }
    }
  })

  // 开始安装 (网络自动下载已移除)
  ipcMain.handle('ffmpeg:install', async () => {
    const status = await ffmpegService.detectFfmpegStatus()
    return {
      success: status.installed,
      message: status.installed
        ? 'FFmpeg 已就绪'
        : '在线自动下载已被移除，请确保系统已安装 FFmpeg 并将其添加至 PATH 环境变量'
    }
  })
}
