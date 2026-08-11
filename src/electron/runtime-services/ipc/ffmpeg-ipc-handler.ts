/**
 * FFmpeg IPC 处理器
 * 处理渲染进程发来的 FFmpeg 相关请求
 */

import { t } from '@app/languages'
import { ipcMain, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import { ffmpegService, FfmpegEvent } from '../system/ffmpeg-service'

export function registerFfmpegIpcHandlers() {
  logger.info(LogCategory.MAIN, '正在注册 FFmpeg IPC 处理器...')

  // 检测安装状态
  ipcMain.handle('ffmpeg:check-installation', async () => {
    return await ffmpegService.detectFfmpegStatus()
  })

  // 开始安装
  ipcMain.handle('ffmpeg:install', async event => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { success: false, error: t('未找到窗口') }

    // 设置监听器转发进度
    const progressHandler = (data: any) => {
      win.webContents.send(FfmpegEvent.INSTALL_PROGRESS, data)
    }
    const completeHandler = (data: any) => {
      win.webContents.send(FfmpegEvent.INSTALL_COMPLETE, data)
      ffmpegService.removeListener(FfmpegEvent.INSTALL_PROGRESS, progressHandler)
      ffmpegService.removeListener(FfmpegEvent.INSTALL_COMPLETE, completeHandler)
      ffmpegService.removeListener(FfmpegEvent.INSTALL_ERROR, errorHandler)
    }
    const errorHandler = (data: any) => {
      win.webContents.send(FfmpegEvent.INSTALL_ERROR, data)
      ffmpegService.removeListener(FfmpegEvent.INSTALL_PROGRESS, progressHandler)
      ffmpegService.removeListener(FfmpegEvent.INSTALL_COMPLETE, completeHandler)
      ffmpegService.removeListener(FfmpegEvent.INSTALL_ERROR, errorHandler)
    }

    ffmpegService.on(FfmpegEvent.INSTALL_PROGRESS, progressHandler)
    ffmpegService.on(FfmpegEvent.INSTALL_COMPLETE, completeHandler)
    ffmpegService.on(FfmpegEvent.INSTALL_ERROR, errorHandler)

    const success = await ffmpegService.install()
    return { success }
  })
}
