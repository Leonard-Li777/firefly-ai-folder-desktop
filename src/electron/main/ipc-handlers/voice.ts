/**
 * 统一语音服务 (Voice Seam) IPC 处理程序
 * apps/desktop/src/electron/main/ipc-handlers/voice.ts
 *
 * 职责 (Ticket 04):
 * 1. 代理前端统一语音转录请求 (voice:transcribe)
 * 2. 代理前端标准 WAV 语音合成请求 (voice:synthesize-to-wav)
 * 3. 向上层透传 VoiceSeamError 异常
 */

import { ipcMain } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import {
  voiceSeamDispatcher,
  TranscriptionResult
} from '../../runtime-services/ai/voice-seam-dispatcher'

export function registerVoiceIPCHandlers(): void {
  // 1. 统一语音转录
  ipcMain.handle(
    'voice:transcribe',
    async (
      _event,
      audioPathOrBuffer: string | Buffer,
      options?: { language?: string }
    ): Promise<TranscriptionResult> => {
      try {
        return await voiceSeamDispatcher.transcribe(audioPathOrBuffer, options)
      } catch (err) {
        logger.warn(LogCategory.MAIN, '[Voice IPC] transcribe 失败:', err)
        throw err
      }
    }
  )

  // 2. 统一语音合成导出 WAV
  ipcMain.handle(
    'voice:synthesize-to-wav',
    async (
      _event,
      text: string,
      options?: { voiceId?: string; speed?: number }
    ): Promise<ArrayBuffer> => {
      try {
        return await voiceSeamDispatcher.synthesizeToWav(text, options)
      } catch (err) {
        logger.warn(LogCategory.MAIN, '[Voice IPC] synthesize-to-wav 失败:', err)
        throw err
      }
    }
  )
}
