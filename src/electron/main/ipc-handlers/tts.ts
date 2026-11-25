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
import {
  omniClient,
  type TTSChunkResult,
  type StreamChunkPayload,
  type StreamEndMeta,
  type StreamErrorMeta
} from '../../services/omni-client'
import {
  ttsWavCacheService,
  TTSWavMetadata,
  StreamWavRecorder
} from '../../runtime-services/filesystem/tts-wav-cache-service'
import { voiceArchiveService } from '../../runtime-services/audio/voice-archive-service'
import { modularResourceService } from '../../runtime-services/system/modular-resource-service'
import { moduleHibernationCoordinator } from '../../runtime-services/hibernation/module-hibernation-coordinator'
import type { HibernationLeaseHandle } from '../../runtime-services/hibernation/types'
import { omniService } from '../../runtime-services/system/omni-service'

/** 将插件注册表 ID 映射为休眠目录目标 ID */
export function resolveTtsHibernationTargetId(moduleId?: string): 'tts-m5-onnx' | 'tts-moss-onnx' {
  return moduleId === 'tts_m5_onnx' ? 'tts-m5-onnx' : 'tts-moss-onnx'
}

/** 单播 M5-TTS 纯流式会话唯一资源句柄（收敛全出口至幂等 terminate()） */
export class TtsStreamSession {
  readonly abortController = new AbortController()
  readonly sender: Electron.WebContents
  sessionId = ''
  lease?: HibernationLeaseHandle
  recorder?: StreamWavRecorder
  streamCtrl?: {
    sessionId: string
    pause: () => void
    resume: () => void
    abort: () => void
  }
  watchdogTimer?: NodeJS.Timeout
  lastHeartbeatTime = Date.now()
  residentEnteredAt = 0
  receivedFirstChunk = false
  pendingFramesCount = 0
  playbackState: 'playing' | 'paused' = 'playing'
  terminated = false

  private onDestroyedListener?: () => void
  private onRenderGoneListener?: () => void
  private readonly onTerminateCleanup: (session: TtsStreamSession) => void

  constructor(
    sender: Electron.WebContents,
    onTerminateCleanup: (session: TtsStreamSession) => void
  ) {
    this.sender = sender
    this.onTerminateCleanup = onTerminateCleanup
    this.onDestroyedListener = () => this.terminate('RENDERER_DESTROYED')
    this.onRenderGoneListener = () =>
      this.terminate('RENDERER_GONE', { endedReason: 'error', errorCode: 'RENDERER_GONE' })
    this.sender.once?.('destroyed', this.onDestroyedListener)
    this.sender.once?.('render-process-gone', this.onRenderGoneListener)
  }

  /** 仅在闸门通过、模块进入 resident 后启动看门狗（避免冷启动解码期间误超时） */
  startWatchdogAfterResident(firstChunkTimeoutMs = 60_000): void {
    if (this.terminated || this.watchdogTimer) return
    this.residentEnteredAt = Date.now()
    this.lastHeartbeatTime = Date.now()
    this.watchdogTimer = setInterval(() => {
      if (this.terminated) {
        this.clearWatchdog()
        return
      }
      const now = Date.now()
      if (!this.receivedFirstChunk && now - this.residentEnteredAt > firstChunkTimeoutMs) {
        logger.error(
          LogCategory.MAIN,
          `[TTS Stream IPC] 首块超时熔断: sessionId=${this.sessionId}, elapsed=${now - this.residentEnteredAt}ms`
        )
        this.terminate('FIRST_CHUNK_TIMEOUT', {
          endedReason: 'error',
          errorCode: 'FIRST_CHUNK_TIMEOUT'
        })
        return
      }
      if (this.pendingFramesCount >= 16 && now - this.lastHeartbeatTime > 5000) {
        logger.error(
          LogCategory.MAIN,
          `[TTS Stream IPC] 渲染层假死熔断: sessionId=${this.sessionId}, 积压帧=${this.pendingFramesCount}`
        )
        this.terminate('RENDERER_FROZEN_TIMEOUT', {
          endedReason: 'renderer_frozen',
          errorCode: 'RENDERER_FROZEN_TIMEOUT'
        })
      }
    }, 1000)
    this.watchdogTimer.unref?.()
  }

  /** 刷新播放态活性信号与租约续期 */
  touchPlayback(state?: 'playing' | 'paused'): void {
    if (this.terminated) return
    const now = Date.now()
    this.lastHeartbeatTime = now
    if (state) {
      this.playbackState = state
    }
    if (this.lease) {
      const registry = moduleHibernationCoordinator.getLeaseRegistry()
      registry?.livenessSourceRegistry.recordPlayback(
        this.lease.leaseId,
        state ?? this.playbackState,
        now
      )
      registry?.renew(this.lease.leaseId)
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = undefined
    }
  }

  /** 全终态唯一幂等出口 */
  terminate(
    reason: string,
    notify?: { endedReason: string; errorCode?: string; summary?: StreamEndMeta }
  ): void {
    if (this.terminated) return
    this.terminated = true

    this.clearWatchdog()
    if (this.onDestroyedListener) {
      this.sender.off?.('destroyed', this.onDestroyedListener)
      this.onDestroyedListener = undefined
    }
    if (this.onRenderGoneListener) {
      this.sender.off?.('render-process-gone', this.onRenderGoneListener)
      this.onRenderGoneListener = undefined
    }

    if (!this.abortController.signal.aborted) {
      this.abortController.abort(reason)
    }
    try {
      this.streamCtrl?.abort()
    } catch {}

    if (this.recorder) {
      this.recorder.finalize(reason === 'COMPLETED').catch(() => {})
    }

    const leaseToRelease = this.lease
    this.lease = undefined
    if (leaseToRelease) {
      leaseToRelease.release()
    }

    this.onTerminateCleanup(this)

    if (notify && this.sessionId && !this.sender.isDestroyed?.()) {
      this.sender.send('tts:stream-ended', {
        sessionId: this.sessionId,
        reason: notify.endedReason,
        ...(notify.errorCode ? { errorCode: notify.errorCode } : {}),
        ...(notify.summary ? { summary: notify.summary } : {})
      })
    }
  }
}

/** 管理会话级活跃请求的 AbortController，键为 sessionId */
const activeSessionControllers = new Map<number, Set<AbortController>>()

/** 单播纯流式 TTS 全局唯一活跃会话句柄 */
let activeStreamSession: TtsStreamSession | null = null

/** 获取当前活跃流式会话（主要供测试观测） */
export function getActiveTtsStreamSession(): TtsStreamSession | null {
  return activeStreamSession
}

/** 检测当前是否有活跃的 TTS 合成或流式朗读任务 */
export function isTTSActive(): boolean {
  return activeSessionControllers.size > 0 || activeStreamSession !== null
}

/** 将两个 AbortSignal 合成为受控联合信号 */
function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a && b) {
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([a, b]) : a
  }
  return a ?? b
}

export function registerTTSIPCHandlers(): void {
  // 1. 单句语音合成（支持 voiceId 字符串或数字 sid）
  ipcMain.handle(
    'tts:synthesize-chunk',
    async (
      event,
      text: string,
      voiceId: string | number,
      speed: number,
      sessionId?: number,
      sid?: number
    ): Promise<TTSChunkResult | null> => {
      // 未安装或未激活 TTS 插件时，安全跳过，绝不发起底层调用，不阻塞
      const activeTTS = modularResourceService.getActiveModuleBySlot('voice_tts')
      if (!activeTTS) {
        logger.debug(LogCategory.MAIN, '[TTS IPC] 未安装或未激活 TTS 插件，安全跳过合成')
        return null
      }

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

      const targetId = resolveTtsHibernationTargetId(activeTTS.id)

      const runWithGateRetry = async (attempt = 0): Promise<TTSChunkResult | null> => {
        const entryGen = omniService.getGeneration()
        try {
          return await moduleHibernationCoordinator.withHibernationGate(
            {
              targetId,
              clusterId: 'tts_media',
              livenessSourceKey: 'task_progress'
            },
            async (_lease, gateSignal) => {
              const combined = combineAbortSignals(controller?.signal, gateSignal)
              return await omniClient.synthesizeTTSChunk(text, voiceId, speed, sid, combined)
            }
          )
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          if (
            attempt === 0 &&
            msg === 'ENGINE_UNAVAILABLE' &&
            omniService.getGeneration() !== entryGen
          ) {
            logger.warn(
              LogCategory.MAIN,
              `[TTS IPC] 检测到 Omni 代际切换引发 /chunk 503，复位并在闸门内自动重试一次: targetId=${targetId}`
            )
            moduleHibernationCoordinator.forceResetExternalHibernated(
              targetId,
              omniService.getGeneration()
            )
            return await runWithGateRetry(1)
          }
          throw err
        }
      }

      try {
        return await runWithGateRetry()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'ABORTED') {
          logger.debug(LogCategory.MAIN, `[TTS IPC] 分片请求已中止 (sessionId=${sessionId})`)
          return null
        }
        if (msg === 'ENGINE_BUSY_STREAMING') {
          logger.warn(
            LogCategory.MAIN,
            `[TTS冲突] Scheme A 分片请求遇流式会话占用已拒绝 (409 Conflict): sessionId=${sessionId}`
          )
          if (!event.sender.isDestroyed()) {
            event.sender.send('tts:busy-rejected', {
              code: 'ENGINE_BUSY_STREAMING',
              message: 'TTS 引擎正处于沉浸式流式朗读中，分块通道暂不可用'
            })
          }
        } else {
          logger.warn(LogCategory.MAIN, '[TTS IPC] synthesize-chunk 失败:', err)
        }
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
        if (activeSessionControllers.size === 0 && !activeStreamSession) {
          moduleHibernationCoordinator.scheduleIdleHibernation('tts_media')
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
    async (_event, defaultName: string, chunks: Uint8Array[]): Promise<string | null> => {
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
    async (_event, wavPath: string): Promise<TTSWavMetadata | null> => {
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
    async (_event, wavPath: string): Promise<ArrayBuffer | null> => {
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
  ipcMain.handle('tts:locate-wav-file', async (_event, wavPath: string): Promise<boolean> => {
    try {
      return ttsWavCacheService.locateWavFile(wavPath)
    } catch (err) {
      logger.warn(LogCategory.MAIN, '[TTS IPC] locate-wav-file 失败:', err)
      return false
    }
  })

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
        const remaining = await voiceArchiveService.listVoices().catch(() => [])
        const fallbackId = remaining.find(v => v.id !== voiceId)?.id || ''
        await orchestrator.updateValue('TTS_DEFAULT_VOICE_ID' as any, fallbackId)
        await orchestrator.updateValue('TTS_DEFAULT_VOICE_SID' as any, fallbackId)
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
      const timeoutPromise = new Promise<null>(resolve => {
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

  // ============================================================================
  // M5-TTS 纯流式会话 IPC 管道 (v1.7.2 规格书 §4.0 / §4.2 / §4.3)
  // ============================================================================

  // 18. 启动纯流式 TTS 会话（单播 TtsStreamSession 唯一句柄闭环）
  ipcMain.handle(
    'tts:stream-start',
    async (
      event,
      req: {
        text: string
        voiceId: string
        speed: number
        resumeCharStart?: number
        targetCachePath?: string
        filePath?: string
        fileFingerprint?: string
        fieldName?: string
        displayName?: string
      }
    ): Promise<{
      ok: boolean
      sessionId?: string
      sampleRate?: number
      errorCode?: string
    }> => {
      // 入口槽位校核：流式纯协议当前仅支持 tts_m5_onnx (tts-m5-onnx)
      const activeTTS = modularResourceService.getActiveModuleBySlot('voice_tts')
      if (!activeTTS || activeTTS.id !== 'tts_m5_onnx') {
        logger.debug(
          LogCategory.MAIN,
          `[TTS Stream IPC] 未激活 tts_m5_onnx 插件 (active=${activeTTS?.id ?? 'none'})，拒绝流式请求`
        )
        return {
          ok: false,
          errorCode: activeTTS ? 'UNSUPPORTED_BACKEND' : 'NO_ACTIVE_PLUGIN'
        }
      }

      // 同步抢占：立即中止旧流式会话并在底层 abort 切断 HTTP/Rust 生成
      if (activeStreamSession) {
        logger.info(
          LogCategory.MAIN,
          `[TTS Stream IPC] 抢占中止旧流式会话: ${activeStreamSession.sessionId || 'pending'}`
        )
        activeStreamSession.terminate('PREEMPTED', { endedReason: 'aborted' })
      }

      // 同时主动中止在途的传统分块合成请求，杜绝非流式分块在后台空跑掠夺 CPU 算力与触发 409 冲突
      for (const [sessId, set] of activeSessionControllers.entries()) {
        for (const ctrl of set) {
          ctrl.abort()
        }
        activeSessionControllers.delete(sessId)
      }

      logger.info(
        LogCategory.MAIN,
        `[TTS Stream IPC] 收到流式会话请求: voiceId=${req.voiceId}, speed=${req.speed}, 文本长度=${req.text.length}, 起始字符=${req.resumeCharStart || 0}`
      )

      const session = new TtsStreamSession(event.sender, closed => {
        if (activeStreamSession === closed) {
          activeStreamSession = null
        }
        if (activeSessionControllers.size === 0 && !activeStreamSession) {
          moduleHibernationCoordinator.scheduleIdleHibernation('tts_media')
        }
      })
      activeStreamSession = session

      let leaseAbortUnbind: (() => void) | undefined

      try {
        let lease!: HibernationLeaseHandle
        let leaseSignal!: AbortSignal
        let streamCtrl!: {
          sessionId: string
          pause: () => void
          resume: () => void
          abort: () => void
        }

        // 1. 闸门与长会话租约申领（冷加载期不计首块看门狗耗时）；若遇 503 且 Omni 已换代则单次自动重试
        for (let attempt = 0; attempt < 2; attempt++) {
          const entryGen = omniService.getGeneration?.() ?? 0
          const acquired = await moduleHibernationCoordinator.acquireStreamLease({
            targetId: 'tts-m5-onnx',
            clusterId: 'tts_media',
            livenessSourceKey: 'player_state'
          })
          lease = acquired.lease
          leaseSignal = acquired.signal

          if (session.terminated || session.abortController.signal.aborted) {
            lease.release()
            return { ok: false, errorCode: 'ABORTED' }
          }

          session.lease = lease
          const onLeaseAbort = () => {
            session.terminate('LEASE_ABORTED', { endedReason: 'aborted' })
          }
          if (leaseSignal.aborted) {
            onLeaseAbort()
            return { ok: false, errorCode: 'ABORTED' }
          }
          leaseSignal.addEventListener('abort', onLeaseAbort, { once: true })
          leaseAbortUnbind = () => leaseSignal.removeEventListener('abort', onLeaseAbort)

          // 2. 初始化流式 WAV 落盘记录器（仅首轮初始化一次）
          if (!session.recorder) {
            try {
              let cachePath = req.targetCachePath
              if (!cachePath) {
                cachePath =
                  (await ttsWavCacheService.getCacheWavPath({
                    filePath: req.filePath,
                    fieldName: req.fieldName,
                    fileFingerprint: req.fileFingerprint,
                    displayName: req.displayName,
                    text: req.text,
                    voiceId: req.voiceId,
                    speed: req.speed
                  })) || undefined
              }

              if (cachePath && !session.terminated) {
                const recorder = new StreamWavRecorder({
                  wavPath: cachePath,
                  voiceId: req.voiceId,
                  displayName: req.displayName,
                  speed: req.speed,
                  fileFingerprint: req.fileFingerprint,
                  fieldName: req.fieldName,
                  textLength: req.text.length,
                  resumeCharStart: req.resumeCharStart
                })
                await recorder.init()
                if (session.terminated) {
                  recorder.finalize(false).catch(() => {})
                } else {
                  session.recorder = recorder
                }
              }
            } catch (recErr) {
              logger.warn(LogCategory.MAIN, '[TTS Stream IPC] 初始化 StreamWavRecorder 异常:', recErr)
            }
          }

          if (session.terminated) {
            return { ok: false, errorCode: 'ABORTED' }
          }

          // 3. 模块已进入 resident：正式激活首块 + 假死看门狗并建立 HTTP 流连接
          session.startWatchdogAfterResident()
          const combinedSignal = combineAbortSignals(session.abortController.signal, leaseSignal)

          try {
            streamCtrl = await omniClient.startTTSStream(
              {
                text: req.text,
                voiceId: req.voiceId,
                speed: req.speed,
                resumeCharStart: req.resumeCharStart
              },
              {
                onChunk: (payload: StreamChunkPayload) => {
                  if (session.terminated || session.sender.isDestroyed()) return
                  session.receivedFirstChunk = true
                  session.pendingFramesCount++
                  session.touchPlayback('playing')
                  if (
                    payload.isFirst ||
                    payload.isLast ||
                    session.pendingFramesCount <= 3 ||
                    session.pendingFramesCount % 4 === 0
                  ) {
                    const chunkSec = (payload.sampleCount / 24000).toFixed(2)
                    const totalSec = ((payload.startSample + payload.sampleCount) / 24000).toFixed(2)
                    logger.info(
                      LogCategory.MAIN,
                      `[TTS Stream IPC] 收到音频块 seq=${payload.startSample}: 采样=${payload.sampleCount} (${chunkSec}s, 累计=${totalSec}s), 字符=[${payload.charStart}..${payload.charEnd}]`
                    )
                  }

                  if (session.recorder) {
                    session.recorder
                      .appendChunk(payload.pcm, payload.charEnd, {
                        charStart: payload.charStart,
                        sampleCount: payload.sampleCount
                      })
                      .catch(() => {})
                  }

                  session.sender.send('tts:stream-chunk-data', payload)
                },
                onEnd: (meta: StreamEndMeta) => {
                  if (session.terminated) return
                  logger.info(
                    LogCategory.MAIN,
                    `[TTS Stream IPC] 流式会话完成: sessionId=${session.sessionId || streamCtrl.sessionId}, 总帧数=${meta.totalFrames}, 总采样=${meta.totalSamples} (${(meta.totalSamples / 24000).toFixed(2)}s), 耗时=${meta.elapsedMs}ms`
                  )
                  session.terminate('COMPLETED', {
                    endedReason: 'completed',
                    summary: meta
                  })
                },
                onError: (meta: StreamErrorMeta) => {
                  session.terminate(`ERROR:${meta.code}`, {
                    endedReason: 'error',
                    errorCode: meta.code
                  })
                }
              },
              combinedSignal
            )
            break
          } catch (streamErr: unknown) {
            const streamMsg = streamErr instanceof Error ? streamErr.message : String(streamErr)
            const currentGen = omniService.getGeneration?.() ?? 0
            if (
              attempt === 0 &&
              streamMsg === 'TTS_STREAM_HTTP_503' &&
              currentGen !== entryGen &&
              !session.terminated &&
              !session.abortController.signal.aborted
            ) {
              logger.warn(
                LogCategory.MAIN,
                `[TTS Stream IPC] 检测到 Omni 代际切换引发 /stream 503 (${entryGen} -> ${currentGen})，复位并在闸门内自动重试一次`
              )
              leaseAbortUnbind?.()
              leaseAbortUnbind = undefined
              if (session.lease === lease) {
                session.lease = undefined
              }
              lease.release()
              moduleHibernationCoordinator.forceResetExternalHibernated('tts-m5-onnx', currentGen)
              continue
            }
            throw streamErr
          }
        }

        session.streamCtrl = streamCtrl
        session.sessionId = streamCtrl.sessionId

        if (session.terminated) {
          try {
            streamCtrl.abort()
          } catch {}
          return { ok: false, errorCode: 'ABORTED' }
        }

        return {
          ok: true,
          sessionId: streamCtrl.sessionId,
          sampleRate: 24000
        }
      } catch (err: unknown) {
        session.terminate('START_FAILED')
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'ABORTED' || (err as any)?.code === 'LOAD_ABORTED') {
          logger.debug(LogCategory.MAIN, '[TTS Stream IPC] 流式会话已中止 (ABORTED)')
          return { ok: false, errorCode: 'ABORTED' }
        }
        if (msg === 'ENGINE_BUSY_STREAMING') {
          if (!event.sender.isDestroyed()) {
            event.sender.send('tts:busy-rejected', {
              code: 'ENGINE_BUSY_STREAMING',
              message: 'TTS 引擎正处于沉浸式流式朗读中，分块通道暂不可用'
            })
          }
          return { ok: false, errorCode: 'ENGINE_BUSY_STREAMING' }
        }
        logger.warn(LogCategory.MAIN, '[TTS Stream IPC] 启动流式会话失败:', err)
        return { ok: false, errorCode: (err as any)?.code || msg }
      } finally {
        leaseAbortUnbind?.()
      }
    }
  )

  // 19. 接收渲染层反压流控指令
  ipcMain.on(
    'tts:stream-flow',
    (_event, cmd: { sessionId: string; command: 'pause' | 'resume' }) => {
      const session = activeStreamSession
      if (session && !session.terminated && session.sessionId === cmd.sessionId) {
        if (cmd.command === 'pause') {
          logger.info(
            LogCategory.MAIN,
            `[TTS Stream IPC] 收到反压暂停指令: sessionId=${cmd.sessionId}`
          )
          session.touchPlayback('paused')
          session.streamCtrl?.pause()
        } else if (cmd.command === 'resume') {
          logger.info(
            LogCategory.MAIN,
            `[TTS Stream IPC] 收到反压恢复指令: sessionId=${cmd.sessionId}`
          )
          session.touchPlayback('playing')
          session.streamCtrl?.resume()
        }
      }
    }
  )

  // 20. 接收渲染层心跳脉冲（刷新 180s+ 长流租约活性与积压计数）
  ipcMain.on(
    'tts:stream-heartbeat',
    (_event, hb: { sessionId: string; bufferedSeconds: number }) => {
      const session = activeStreamSession
      if (session && !session.terminated && session.sessionId === hb.sessionId) {
        session.touchPlayback()
        session.pendingFramesCount = Math.max(0, session.pendingFramesCount - 4)
      }
    }
  )

  // 21. 显式中止流式会话
  ipcMain.on('tts:stream-abort', (_event, req: { sessionId: string }) => {
    const session = activeStreamSession
    if (session && (!req.sessionId || session.sessionId === req.sessionId)) {
      session.terminate('USER_ABORTED', { endedReason: 'aborted' })
    }
  })
}

/** 本地正则分句降级辅助函数（与前端保持一致的阶梯式切片：首句 8~18 字极速首发音，过渡句 14~26 字，稳态 20~36 字） */
function fallbackLocalSplitChunks(text: string): string[] {
  if (!text || !text.trim()) return []
  const rawSentences = text.match(/[^。！？；\n\r.!?]+[。！？；\n\r.!?]*/g) || [text]
  const secondaryRegex = /[^，,、 :：；;()（）「」『』—\n\r]+[，,、 :：；;()（）「」『』—\n\r]*/g
  const normalizedPieces: string[] = []

  for (const raw of rawSentences) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    if (trimmed.length <= 18) {
      normalizedPieces.push(trimmed)
      continue
    }

    const subMatches = trimmed.match(secondaryRegex)
    if (!subMatches || subMatches.length === 1) {
      let start = 0
      while (start < trimmed.length) {
        normalizedPieces.push(trimmed.slice(start, start + 18))
        start += 18
      }
      continue
    }

    let subBuffer = ''
    for (const sub of subMatches) {
      if (subBuffer.length + sub.length > 18 && subBuffer.length > 0) {
        normalizedPieces.push(subBuffer.trim())
        subBuffer = sub
      } else {
        subBuffer += sub
      }
    }
    if (subBuffer.trim()) {
      normalizedPieces.push(subBuffer.trim())
    }
  }

  const chunks: string[] = []
  let currentBuffer = ''

  for (const piece of normalizedPieces) {
    if (!currentBuffer) {
      currentBuffer = piece
      continue
    }

    const currentMin = chunks.length === 0 ? 8 : chunks.length === 1 ? 14 : 20
    const currentMax = chunks.length === 0 ? 18 : chunks.length === 1 ? 26 : 36

    if (currentBuffer.length < currentMin && currentBuffer.length + piece.length <= currentMax) {
      currentBuffer += piece
    } else {
      chunks.push(currentBuffer.trim())
      currentBuffer = piece
    }
  }

  if (currentBuffer.trim()) {
    chunks.push(currentBuffer.trim())
  }
  return chunks.map(c => c.trim()).filter(Boolean)
}
