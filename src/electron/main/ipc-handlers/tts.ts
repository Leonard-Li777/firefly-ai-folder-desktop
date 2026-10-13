/**
 * TTS (Text-to-Speech) IPC 处理程序
 * apps/desktop/src/electron/main/ipc-handlers/tts.ts
 *
 * 职责：
 * 1. 代理前端单句 TTS 语音合成请求，通过 OmniClient 请求 Omni HTTP 接口
 * 2. 管理会话级 AbortController，支持切歌/停止时即刻中止在途请求
 * 3. 收集各句分块 WAV 数据，拼合为标准 WAV 音频文件并导出保存到本地
 */

import * as fs from 'fs'
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import { omniClient } from '../../services/omni-client'
import { ttsWavCacheService, TTSWavMetadata } from '../../runtime-services/filesystem/tts-wav-cache-service'

/** 管理会话级活跃请求的 AbortController，键为 sessionId */
const activeSessionControllers = new Map<number, Set<AbortController>>()

export function registerTTSIPCHandlers(): void {
  // 1. 单句语音合成
  ipcMain.handle(
    'tts:synthesize-chunk',
    async (
      _event,
      text: string,
      sid: number,
      speed: number,
      sessionId?: number
    ): Promise<ArrayBuffer | null> => {
      let controller: AbortController | undefined

      if (sessionId !== undefined) {
        controller = new AbortController()
        let set = activeSessionControllers.get(sessionId)
        if (!set) {
          set = new Set()
          activeSessionControllers.set(sessionId, set)
        }
        set.add(controller)
      }

      try {
        const result = await omniClient.synthesizeTTSChunk(
          text,
          sid,
          speed,
          controller?.signal
        )
        return result
      } catch (err: unknown) {
        logger.warn(LogCategory.MAIN, '[TTS IPC] synthesize-chunk 失败:', err)
        return null
      } finally {
        if (sessionId !== undefined && controller) {
          const set = activeSessionControllers.get(sessionId)
          if (set) {
            set.delete(controller)
            if (set.size === 0) {
              activeSessionControllers.delete(sessionId)
            }
          }
        }
      }
    }
  )

  // 2. 取消会话在途请求
  ipcMain.handle('tts:abort-session', async (_event, sessionId: number): Promise<void> => {
    const controllers = activeSessionControllers.get(sessionId)
    if (controllers && controllers.size > 0) {
      logger.info(
        LogCategory.MAIN,
        `[TTS IPC] 中止会话 sessionId=${sessionId} 的 ${controllers.size} 个在途请求`
      )
      controllers.forEach(ctrl => ctrl.abort())
      activeSessionControllers.delete(sessionId)
    }
  })

  // 3. 兼容旧版：流式拼装分句 WAV 并保存到用户本地文件
  ipcMain.handle(
    'tts:save-wav-file',
    async (
      _event,
      defaultName: string,
      chunks: Uint8Array[]
    ): Promise<string | null> => {
      if (!chunks || chunks.length === 0) {
        logger.warn(LogCategory.MAIN, '[TTS IPC] save-wav-file: 没有可保存的音频块')
        return null
      }

      try {
        const win = BrowserWindow.getFocusedWindow()
        const saveOptions = {
          title: '导出音频文件',
          defaultPath: defaultName || 'tts-output.wav',
          filters: [{ name: 'WAV 音频文件 (*.wav)', extensions: ['wav'] }]
        }
        const saveResult = win
          ? await dialog.showSaveDialog(win, saveOptions)
          : await dialog.showSaveDialog(saveOptions)

        if (saveResult.canceled || !saveResult.filePath) {
          return null
        }

        const targetPath = saveResult.filePath

        // 计算所有 chunk 的 PCM 数据总字节（跳过每个合法 chunk 的 44 字节头部）
        let totalPcmBytes = 0
        for (const chunk of chunks) {
          if (chunk.byteLength > 44) {
            totalPcmBytes += chunk.byteLength - 44
          }
        }

        // 构建合并后的标准 44 字节 WAV 头部 (24000Hz, 16-bit Mono)
        const header = Buffer.alloc(44)
        header.write('RIFF', 0)
        header.writeUInt32LE(36 + totalPcmBytes, 4)
        header.write('WAVE', 8)
        header.write('fmt ', 12)
        header.writeUInt32LE(16, 16) // PCM format subchunk size
        header.writeUInt16LE(1, 20) // AudioFormat: 1 (PCM)
        header.writeUInt16LE(1, 22) // NumChannels: 1
        header.writeUInt32LE(24000, 24) // SampleRate: 24000
        header.writeUInt32LE(48000, 28) // ByteRate: 24000 * 1 * 2
        header.writeUInt16LE(2, 32) // BlockAlign: 1 * 2
        header.writeUInt16LE(16, 34) // BitsPerSample: 16
        header.write('data', 36)
        header.writeUInt32LE(totalPcmBytes, 40)

        // 写入合并文件
        const writeStream = fs.createWriteStream(targetPath)
        writeStream.write(header)

        for (const chunk of chunks) {
          if (chunk.byteLength > 44) {
            const pcmBuffer = Buffer.from(
              chunk.buffer,
              chunk.byteOffset + 44,
              chunk.byteLength - 44
            )
            writeStream.write(pcmBuffer)
          }
        }

        await new Promise<void>((resolve, reject) => {
          writeStream.end(() => resolve())
          writeStream.on('error', reject)
        })

        logger.info(
          LogCategory.MAIN,
          `[TTS IPC] 音频成功拼装并保存至: ${targetPath} (总PCM大小: ${totalPcmBytes} 字节)`
        )
        return targetPath
      } catch (err: unknown) {
        logger.error(LogCategory.MAIN, '[TTS IPC] save-wav-file 写入失败:', err)
        throw err
      }
    }
  )

  // 4. 解析并获取缓存文件绝对路径
  ipcMain.handle(
    'tts:get-cache-path',
    async (
      _event,
      params: {
        filePath?: string
        fieldName?: string
        fileFingerprint?: string
        text?: string
        sid?: number
        speed?: number
      }
    ): Promise<string | null> => {
      try {
        return await ttsWavCacheService.getCacheWavPath(params)
      } catch (err) {
        logger.warn(LogCategory.MAIN, '[TTS IPC] get-cache-path 失败:', err)
        return null
      }
    }
  )

  // 5. 读取本地 WAV 文件内嵌的 meta Chunk
  ipcMain.handle(
    'tts:read-wav-metadata',
    async (
      _event,
      wavPath: string
    ): Promise<TTSWavMetadata | null> => {
      try {
        return await ttsWavCacheService.readWavMetadata(wavPath)
      } catch (err) {
        logger.warn(LogCategory.MAIN, '[TTS IPC] read-wav-metadata 失败:', err)
        return null
      }
    }
  )

  // 6. 读取完整 WAV 文件供前端秒播
  ipcMain.handle(
    'tts:read-wav-file',
    async (
      _event,
      wavPath: string
    ): Promise<ArrayBuffer | null> => {
      try {
        const buf = await ttsWavCacheService.readWavFile(wavPath)
        if (!buf) return null
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      } catch (err) {
        logger.warn(LogCategory.MAIN, '[TTS IPC] read-wav-file 失败:', err)
        return null
      }
    }
  )

  // 7. 流式追加单句 PCM 并原子更新 meta Chunk
  ipcMain.handle(
    'tts:append-wav-chunk',
    async (
      _event,
      params: {
        wavPath: string
        chunkData: Uint8Array
        chunkIndex: number
        totalChunks: number
        sid: number
        speed: number
        fileFingerprint?: string
        fieldName?: string
      }
    ): Promise<boolean> => {
      try {
        return await ttsWavCacheService.appendWavChunk(params)
      } catch (err) {
        logger.error(LogCategory.MAIN, '[TTS IPC] append-wav-chunk 失败:', err)
        return false
      }
    }
  )

  // 8. 在系统资源管理器中定位并选中该音频文件
  ipcMain.handle(
    'tts:locate-wav-file',
    async (_event, wavPath: string): Promise<boolean> => {
      try {
        return ttsWavCacheService.locateWavFile(wavPath)
      } catch (err) {
        logger.warn(LogCategory.MAIN, '[TTS IPC] locate-wav-file 失败:', err)
        return false
      }
    }
  )
}

