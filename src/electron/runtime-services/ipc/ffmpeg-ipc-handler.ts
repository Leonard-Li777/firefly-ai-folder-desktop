/**
 * FFmpeg IPC 处理器
 * 处理渲染进程发来的 FFmpeg 相关请求
 */

import { ipcMain } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import { ffmpegService } from '../system/ffmpeg-service'

export function registerFfmpegIpcHandlers() {
  logger.info(LogCategory.MAIN, '正在注册 FFmpeg IPC 处理器...')

  // 检测安装状态
  ipcMain.handle('ffmpeg:check-installation', async () => {
    return await ffmpegService.detectFfmpegStatus()
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
