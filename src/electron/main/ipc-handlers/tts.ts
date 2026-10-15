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
import { voiceArchiveService } from '../../runtime-services/audio/voice-archive-service'

/** 管理会话级活跃请求的 AbortController，键为 sessionId */
const activeSessionControllers = new Map<number, Set<AbortController>>()

export function registerTTSIPCHandlers(): void {
  // 1. 单句语音合成（支持 voiceId 字符串或数字 sid）
  ipcMain.handle(
    'tts:synthesize-chunk',
    async (
      _event,
      text: string,
      voiceId: string | number,
      speed: number,
      sessionId?: number,
      sid?: number
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
          voiceId,
          speed,
          sid,
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

        // 自适应提取音频格式规格（默认 48000Hz 立体声 16-bit）
        let numChannels = 2
        let sampleRate = 48000
        let byteRate = 192000
        let blockAlign = 4
        let bitsPerSample = 16

        for (const chunk of chunks) {
          if (chunk.byteLength > 44) {
            const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            if (buf.toString('ascii', 0, 4) === 'RIFF') {
              numChannels = buf.readUInt16LE(22)
              sampleRate = buf.readUInt32LE(24)
              byteRate = buf.readUInt32LE(28)
              blockAlign = buf.readUInt16LE(32)
              bitsPerSample = buf.readUInt16LE(34)
              break
            }
          }
        }

        // 构建合并后的标准 44 字节 WAV 头部
        const header = Buffer.alloc(44)
        header.write('RIFF', 0)
        header.writeUInt32LE(36 + totalPcmBytes, 4)
        header.write('WAVE', 8)
        header.write('fmt ', 12)
        header.writeUInt32LE(16, 16) // PCM format subchunk size
        header.writeUInt16LE(1, 20) // AudioFormat: 1 (PCM)
        header.writeUInt16LE(numChannels, 22) // NumChannels
        header.writeUInt32LE(sampleRate, 24) // SampleRate
        header.writeUInt32LE(byteRate, 28) // ByteRate
        header.writeUInt16LE(blockAlign, 32) // BlockAlign
        header.writeUInt16LE(bitsPerSample, 34) // BitsPerSample
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
        displayName?: string
        text?: string
        sid?: number
        voiceId?: string | number
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
        sid?: number
        voiceId?: string | number
        displayName?: string
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

  // 9. 获取所有可用音色列表（内置预置 + 用户自定义）
  ipcMain.handle('tts:list-voices', async () => {
    try {
      return await voiceArchiveService.listVoices()
    } catch (err) {
      logger.error(LogCategory.MAIN, '[TTS IPC] list-voices 失败:', err)
      return []
    }
  })

  // 10. 上传并分析外部音频特征，返回签发 tempVoiceId 与自动识别标签
  ipcMain.handle('tts:analyze-voice-file', async (_event, filePath: string) => {
    try {
      return await voiceArchiveService.analyzeVoiceFile(filePath)
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[TTS IPC] analyze-voice-file 失败:', err)
      throw new Error(err?.message || '音频分析提取失败')
    }
  })

  // 11. 确认保存自定义音色并写入单文件容器与注入 Omni
  ipcMain.handle(
    'tts:save-custom-voice',
    async (
      _event,
      params: {
        tempVoiceId: string
        displayName: string
        gender: 'male' | 'female' | 'child'
        lang: string
        desc?: string
      }
    ) => {
      try {
        return await voiceArchiveService.saveCustomVoice(params)
      } catch (err: any) {
        logger.error(LogCategory.MAIN, '[TTS IPC] save-custom-voice 失败:', err)
        return { success: false, error: err?.message || '保存自定义音色失败' }
      }
    }
  )

  // 12. 删除自定义音色文件并级联处理配置兜底
  ipcMain.handle('tts:remove-custom-voice', async (_event, voiceId: string): Promise<boolean> => {
    try {
      const { ConfigOrchestrator } = await import('../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator.getInstance()
      const defaultVoice = orchestrator.getValue<string>('TTS_DEFAULT_VOICE_ID' as any)
      if (defaultVoice === voiceId) {
        await orchestrator.updateValue('TTS_DEFAULT_VOICE_ID' as any, 'lilihong_shejian')
        await orchestrator.updateValue('TTS_DEFAULT_VOICE_SID' as any, 'lilihong_shejian')
      }
      const favVoices = orchestrator.getValue<string[]>('TTS_FAVORITE_VOICES' as any) || []
      if (favVoices.includes(voiceId)) {
        await orchestrator.updateValue(
          'TTS_FAVORITE_VOICES' as any,
          favVoices.filter(id => id !== voiceId)
        )
      }
      return await voiceArchiveService.removeCustomVoice(voiceId)
    } catch (err) {
      logger.error(LogCategory.MAIN, '[TTS IPC] remove-custom-voice 失败:', err)
      return false
    }
  })

  // 13. 极速保音调倍速转换：调用 Omni WSOLA 纯 Rust 内存算法
  ipcMain.handle(
    'tts:scale-wav',
    async (_event, wavBuffer: ArrayBuffer, speed: number): Promise<ArrayBuffer | null> => {
      try {
        const res = await omniClient.scaleWavSpeed(Buffer.from(wavBuffer), speed)
        if (!res) return null
        return res.buffer.slice(res.byteOffset, res.byteOffset + res.byteLength) as ArrayBuffer
      } catch (err) {
        logger.warn(LogCategory.MAIN, '[TTS IPC] scale-wav 失败:', err)
        return null
      }
    }
  )

  // 14. 极速从 1.0x 基准文件派生目标倍速文件
  ipcMain.handle(
    'tts:derive-scaled-wav',
    async (
      _event,
      baseWavPath: string,
      targetWavPath: string,
      targetSpeed: number
    ): Promise<boolean> => {
      try {
        return await ttsWavCacheService.deriveScaledWav(baseWavPath, targetWavPath, targetSpeed)
      } catch (err) {
        logger.warn(LogCategory.MAIN, '[TTS IPC] derive-scaled-wav 失败:', err)
        return false
      }
    }
  )

  // 15. 智能文本分句切片：由 Omni 原生 jieba 词性与自然断句驱动，附带 300ms 超时优雅降级
  ipcMain.handle(
    'tts:split-chunks',
    async (
      _event,
      text: string,
      options?: {
        targetChunkChars?: number
        minChunkChars?: number
        maxChunkChars?: number
        language?: string
      }
    ): Promise<string[]> => {
      if (!text || !text.trim()) return []

      const abortController = new AbortController()
      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          abortController.abort()
          resolve(null)
        }, 300)
      })

      try {
        const res = await Promise.race([
          omniClient.splitTTSChunks(text, options, abortController.signal),
          timeoutPromise
        ])
        if (res && res.chunks && res.chunks.length > 0) {
          return res.chunks
        }
      } catch (err: unknown) {
        logger.warn(LogCategory.MAIN, '[TTS IPC] split-chunks 降级到本地正则分句:', err)
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }

      // 降级兜底：遵守 AGENTS.md §2.9 显式记录警告并返回本地快速切分
      logger.warn(
        LogCategory.MAIN,
        '[TTS IPC] split-chunks: Omni 服务不可用或超时(>300ms)，触发本地正则切分降级'
      )
      return fallbackLocalSplitChunks(text)
    }
  )

  // 16. 独立分片保存与落盘（即合成即写盘，支持乱序与内存减压）
  ipcMain.handle('tts:save-chunk', async (_event, params: any): Promise<boolean> => {
    try {
      return await ttsWavCacheService.saveChunk(params)
    } catch (err) {
      logger.warn(LogCategory.MAIN, '[TTS IPC] save-chunk 失败:', err)
      return false
    }
  })

  // 17. 独立分片读取（分片级断点与秒播复用）
  ipcMain.handle('tts:read-chunk', async (_event, params: any): Promise<ArrayBuffer | null> => {
    try {
      const buf = await ttsWavCacheService.readChunk(params)
      if (!buf) return null
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    } catch (err) {
      logger.warn(LogCategory.MAIN, '[TTS IPC] read-chunk 失败:', err)
      return null
    }
  })
}

/** 本地正则分句降级辅助函数 */
function fallbackLocalSplitChunks(text: string, minLen = 45, maxLen = 120): string[] {
  if (!text || !text.trim()) return []
  const rawSentences = text.match(/[^。！？；\n\r.!?]+[。！？；\n\r.!?]*/g) || [text]
  const chunks: string[] = []
  let current = ''

  for (const raw of rawSentences) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    if (!current) {
      current = trimmed
      continue
    }

    // 若累积长度未达下限且尚未超过上限，贪婪合并后续短句；一旦达到下限且遇到新句，即切片输出
    if (current.length < minLen && current.length + trimmed.length <= maxLen) {
      current += trimmed
    } else {
      chunks.push(current.trim())
      current = trimmed
    }
  }

  if (current.trim()) {
    chunks.push(current.trim())
  }
  return chunks.length > 0 ? chunks : [text.trim()]
}

