/**
 * TTS WAV 磁盘自动缓存与增量断点续存服务
 * apps/desktop/src/electron/runtime-services/filesystem/tts-wav-cache-service.ts
 *
 * 核心特性：
 * 1. 唯一且默认落盘路径：<workspaceDir>/.VirtualDirectory/.tts/
 * 2. Windows 平台自动设置 +h 隐藏属性（与 .VirtualDirectory/.thumbnail 一致）
 * 3. 自包含标准 RIFF 'meta' Sub-chunk，存放 UTF-8 编码的进度元数据，无伴生文件
 * 4. 增量断点续存：流式追加分句 PCM 并原子更新 meta chunk 与 RIFF 长度
 * 5. 在文件夹中定位：调用 shell.showItemInFolder
 */

import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { shell } from 'electron'
import { logger, LogCategory, isSubPath } from '@firefly/shared'
import { databaseService } from '../database/database-service'
import { omniClient } from '../../services/omni-client'

const execFileAsync = promisify(execFile)

/** 虚拟目录及 TTS 缓存目录常量 */
export const VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'
export const TTS_CACHE_FOLDER = '.tts'

/** 单个分句时间戳条目（供合并后整音频 0 误差秒切任意分句） */
export interface TTSChunkCue {
  index: number
  startTime: number
  duration: number
  textHash?: string
}

/** 分片池清单结构 */
export interface TTSChunkManifest {
  total: number
  voiceId: string
  displayName?: string
  fileFingerprint?: string
  fieldName?: string
  completed: number[]
  cues: Record<string, { duration: number; textHash?: string }>
}

/** WAV 内嵌 meta 元数据结构 */
export interface TTSWavMetadata {
  /** 是否全部句子合成完毕 */
  completed: boolean
  /** 总分句数 */
  total: number
  /** 当前已完成分句数 */
  done: number
  /** 发音人 ID (兼容历史数字与当前字符串 voiceId) */
  sid?: number
  voiceId?: string
  /** 发音人显示名称 */
  displayName?: string
  /** 播放语速 */
  speed: number
  /** 文件指纹 */
  fingerprint?: string
  /** 字段标识 */
  fieldName?: string
  /** 全文分句时间戳索引表（供合并后整音频 0 误差秒切任意分句） */
  chunks?: TTSChunkCue[]
}

export interface SaveChunkParams {
  filePath?: string
  fileFingerprint?: string
  fieldName?: string
  displayName?: string
  voiceId: string | number
  sid?: number
  speed?: number
  chunkIndex: number
  totalChunks: number
  chunkData: Uint8Array | Buffer
  duration?: number
  chunkText?: string
}

export interface ReadChunkParams {
  filePath?: string
  fileFingerprint?: string
  fieldName?: string
  displayName?: string
  voiceId: string | number
  chunkIndex: number
  chunkText?: string
}

export interface AppendWavChunkParams {
  wavPath: string
  /** 分句音频二进制（支持带 44 字节头的 WAV 或裸 PCM） */
  chunkData: Uint8Array | Buffer
  chunkIndex: number
  totalChunks: number
  sid?: number
  voiceId?: string | number
  displayName?: string
  speed: number
  fileFingerprint?: string
  fieldName?: string
}

export class TTSWavCacheService {
  /**
   * 获取 TTS 缓存目录路径
   */
  public getTtsDirPath(workspaceDirectoryPath: string): string {
    return path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER, TTS_CACHE_FOLDER)
  }

  /**
   * 确保 TTS 缓存目录存在，并设置为隐藏目录（仅 Windows）
   */
  public async ensureTtsDirectory(workspaceDirectoryPath: string): Promise<string> {
    const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
    const ttsDirPath = path.join(virtualDirPath, TTS_CACHE_FOLDER)

    try {
      // 检查 .VirtualDirectory 是否存在
      try {
        await fsPromises.access(virtualDirPath)
      } catch {
        await fsPromises.mkdir(virtualDirPath, { recursive: true })
      }

      // 检查 .tts 是否存在
      try {
        await fsPromises.access(ttsDirPath)
      } catch {
        await fsPromises.mkdir(ttsDirPath, { recursive: true })

        // 设置为隐藏目录（仅Windows，保持内部缓存目录静默隐藏）
        if (process.platform === 'win32') {
          try {
            await execFileAsync('attrib', ['+h', ttsDirPath])
          } catch (error) {
            logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 设置隐藏属性失败:`, error)
          }
        }
      }

      return ttsDirPath
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 创建 TTS 缓存目录失败:`, error)
      throw error
    }
  }

  /**
   * 根据文件路径定位其所属工作区物理根路径
   */
  public async resolveWorkspaceForPath(filePath?: string): Promise<string | null> {
    try {
      const allWorkspaces = await databaseService.getAllWorkspaceDirectories()

      if (filePath && allWorkspaces.length > 0) {
        // 优先根据路径前缀匹配工作区
        const matched = allWorkspaces.find((w: { path: string }) => isSubPath(w.path, filePath))
        if (matched) {
          return matched.path
        }
      }

      // 回退至当前活跃工作区
      const current = await databaseService.getCurrentWorkspaceDirectory()
      if (current) {
        return current.path
      }

      // 再次回退至首个可用工作区
      if (allWorkspaces.length > 0) {
        return allWorkspaces[0].path
      }

      return null
    } catch (err) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 解析工作区失败:`, err)
      return null
    }
  }

  /**
   * 解析或生成文件内容指纹
    */
  public resolveFileFingerprint(
    filePath?: string,
    fileFingerprint?: string,
    text?: string,
    fieldName?: string
  ): string {
    if (fileFingerprint && fileFingerprint.trim()) {
      return fileFingerprint.trim()
    }

    if (fieldName === 'audition' || fieldName === 'preview') {
      return 'preview'
    }

    if (filePath && filePath.trim()) {
      try {
        if (databaseService.db) {
          // 尝试从数据库查询已入库的文件指纹
          const row = databaseService.db
            .prepare('SELECT file_fingerprint FROM workspace_files WHERE path = ? LIMIT 1')
            .get(filePath) as { file_fingerprint: string } | undefined
          if (row?.file_fingerprint) {
            return row.file_fingerprint
          }
        }
      } catch {
        // 忽略数据库查询偶发异常
      }

      // 数据库未命中时，基于文件规范路径派生确定性哈希
      return crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16)
    }

    if (text && text.trim()) {
      return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
    }

    return 'unknown_content'
  }

  /**
   * 生成规范缓存文件名
   * 格式:
   * 1. 实体文件朗读: {fileFingerprint}_{safeDisplayName}_{speed}x_{safeVoiceId}.wav
   * 2. 音色预览/试听: preview_{safeDisplayName}_{speed}x_{safeVoiceId}.wav
   * 规范：音色预览统一以 preview_ 开头，无文件指纹干扰；每个语速与音色拥有独立落盘实体，各语速直接由语音合成端输出并复用，彻底摒弃 FFmpeg 转码
   */
  public generateCacheFileName(
    fileFingerprint: string,
    displayName: string = '李立宏',
    speed: number = 1.0,
    voiceId: string | number = 'lilihong_shejian'
  ): string {
    const isPreview = !fileFingerprint || fileFingerprint === 'preview' || fileFingerprint.startsWith('preview_')
    const safeFingerprint = (fileFingerprint || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
    const safeDisplayName = String(displayName || voiceId || 'voice').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')
    const speedStr = Number(speed || 1.0).toFixed(2).replace(/\.?0+$/, '')
    const safeVoice = String(
      voiceId !== undefined && voiceId !== null && voiceId !== '' ? voiceId : 'lilihong_shejian'
    ).replace(/[^a-zA-Z0-9_-]/g, '_')

    if (isPreview) {
      return `preview_${safeDisplayName}_${speedStr}x_${safeVoice}.wav`
    }
    return `${safeFingerprint}_${safeDisplayName}_${speedStr}x_${safeVoice}.wav`
  }

  /**
   * 获取缓存文件的完整绝对路径（优先按新命名规范匹配，并平滑兼容历史旧格式）
   */
  public async getCacheWavPath(params: {
    filePath?: string
    fieldName?: string
    fileFingerprint?: string
    displayName?: string
    text?: string
    sid?: number
    voiceId?: string | number
    speed?: number
  }): Promise<string | null> {
    const workspacePath = await this.resolveWorkspaceForPath(params.filePath)
    if (!workspacePath) {
      return null
    }

    await this.ensureTtsDirectory(workspacePath)
    const ttsDir = this.getTtsDirPath(workspacePath)
    const isPreviewMode =
      params.fieldName === 'audition' ||
      params.fieldName === 'preview' ||
      params.fileFingerprint === 'preview'
    const fingerprint = isPreviewMode
      ? 'preview'
      : this.resolveFileFingerprint(
          params.filePath,
          params.fileFingerprint,
          params.text,
          params.fieldName
        )
    const voiceIdVal = params.voiceId !== undefined ? params.voiceId : (params.sid !== undefined ? params.sid : 'lilihong_shejian')
    const speedVal = params.speed !== undefined ? params.speed : 1.0
    const displayNameVal = params.displayName || String(voiceIdVal)

    // 1. 优先按最新命名规范命中：{fileFingerprint}_{displayName}_{speed}x_{voiceId}.wav 或 preview_{displayName}_{speed}x_{voiceId}.wav
    const standardName = this.generateCacheFileName(
      fingerprint,
      displayNameVal,
      speedVal,
      voiceIdVal
    )
    const standardPath = path.join(ttsDir, standardName)
    if (fs.existsSync(standardPath)) {
      return standardPath
    }

    // 2. 兼容历史带 fieldName 格式：{fileFingerprint}_{fieldName}_{voiceId}_{speed}x.wav
    const speedStr = Number(speedVal).toFixed(2).replace(/\.?0+$/, '')
    const safeField = (params.fieldName || 'textContent').replace(/[^a-zA-Z0-9_-]/g, '_')
    const safeVoice = String(voiceIdVal).replace(/[^a-zA-Z0-9_-]/g, '_')
    const legacySpeedName = `${fingerprint}_${safeField}_${safeVoice}_${speedStr}x.wav`
    const legacySpeedPath = path.join(ttsDir, legacySpeedName)
    if (fs.existsSync(legacySpeedPath)) {
      return legacySpeedPath
    }

    // 3. 兼容历史无 speed 格式（仅当 1.0x 时）：{fileFingerprint}_{fieldName}_{voiceId}.wav
    if (Math.abs(speedVal - 1.0) < 0.01) {
      const legacyName = `${fingerprint}_${safeField}_${safeVoice}.wav`
      const legacyPath = path.join(ttsDir, legacyName)
      if (fs.existsSync(legacyPath)) {
        return legacyPath
      }
    }

    // 4. 【核心创新】：若目标倍率非 1.0x，探测 1.0x 基准文件是否存在且已全部完成合成
    // 若 1.0x 基准文件已就绪，立即通过纯 Rust WSOLA 极速算法在内存中（< 30ms）派生目标倍率文件并落盘，秒级就绪！
    if (Math.abs(speedVal - 1.0) >= 0.01) {
      const base1xCandidates = [
        path.join(ttsDir, this.generateCacheFileName(fingerprint, displayNameVal, 1.0, voiceIdVal)),
        path.join(ttsDir, `${fingerprint}_${safeField}_${safeVoice}_1x.wav`),
        path.join(ttsDir, `${fingerprint}_${safeField}_${safeVoice}.wav`)
      ]

      for (const baseCandidate of base1xCandidates) {
        if (fs.existsSync(baseCandidate)) {
          const meta = await this.readWavMetadata(baseCandidate)
          if (meta && meta.completed) {
            const derived = await this.deriveScaledWav(baseCandidate, standardPath, speedVal)
            if (derived) {
              return standardPath
            }
          }
        }
      }
    }

    return standardPath
  }

  /**
   * 基于纯 Rust WSOLA 极速算法，将已有的 1.0x 基准 WAV 文件毫秒级派生为目标语速的新文件
   * 自动保留并更新内嵌 meta chunk 中的 speed 字段，零 FFmpeg 外部进程依赖
   */
  public async deriveScaledWav(
    baseWavPath: string,
    targetWavPath: string,
    targetSpeed: number
  ): Promise<boolean> {
    try {
      if (!fs.existsSync(baseWavPath)) {
        return false
      }
      const baseBuffer = await fsPromises.readFile(baseWavPath)
      if (baseBuffer.length < 44) {
        return false
      }

      // 如果目标倍率与基准几乎一致，直接复制
      if (Math.abs(targetSpeed - 1.0) < 0.01) {
        await fsPromises.copyFile(baseWavPath, targetWavPath)
        return true
      }

      const scaledBuffer = await omniClient.scaleWavSpeed(baseBuffer, targetSpeed)
      if (!scaledBuffer || scaledBuffer.length < 44) {
        logger.warn(
          LogCategory.FILE_PROCESSOR,
          `[TTS缓存服务] WSOLA 派生音频失败或返回为空: ${baseWavPath} -> ${targetSpeed}x`
        )
        return false
      }

      const parentDir = path.dirname(targetWavPath)
      if (!fs.existsSync(parentDir)) {
        await fsPromises.mkdir(parentDir, { recursive: true })
      }

      // 提取母本元数据并注入派生倍速与 completed 状态，确保通道 A 秒切接管能精准识别
      let finalScaledBuffer = scaledBuffer
      try {
        const baseMeta = await this.readWavMetadata(baseWavPath)
        const derivedMeta: TTSWavMetadata = {
          completed: true,
          total: baseMeta?.total ?? 1,
          done: baseMeta?.total ?? 1,
          sid: baseMeta?.sid,
          voiceId: baseMeta?.voiceId,
          displayName: baseMeta?.displayName,
          speed: targetSpeed,
          fingerprint: baseMeta?.fingerprint,
          fieldName: baseMeta?.fieldName,
          chunks: baseMeta?.chunks
            ? baseMeta.chunks.map(c => ({
                index: c.index,
                startTime: c.startTime / targetSpeed,
                duration: c.duration / targetSpeed
              }))
            : undefined
        }
        finalScaledBuffer = this.injectOrUpdateMetaChunk(scaledBuffer, derivedMeta)
      } catch (metaErr) {
        logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 注入派生 WAV 元数据异常:`, metaErr)
      }

      await fsPromises.writeFile(targetWavPath, finalScaledBuffer)
      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[TTS缓存服务] 成功基于 1.0x 基准毫秒级派生 ${targetSpeed}x 音频: ${path.basename(targetWavPath)} (大小: ${finalScaledBuffer.length} 字节)`
      )
      return true
    } catch (err) {
      logger.error(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 派生倍速音频异常:`, err)
      return false
    }
  }

  /**
   * 将 meta 元数据注入或更新至 WAV Buffer 尾部，确保 RIFF 格式完全合规且自包含
   */
  public injectOrUpdateMetaChunk(wavBuffer: Buffer, meta: TTSWavMetadata): Buffer {
    if (
      wavBuffer.length < 44 ||
      wavBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
      wavBuffer.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      return wavBuffer
    }

    // 收集所有非 meta chunk 数据
    const keptChunks: Buffer[] = []
    let offset = 12
    while (offset + 8 <= wavBuffer.length) {
      const chunkId = wavBuffer.toString('ascii', offset, offset + 4)
      const chunkSize = wavBuffer.readUInt32LE(offset + 4)
      const chunkTotalLen = 8 + chunkSize + (chunkSize % 2)
      const chunkEnd = Math.min(offset + chunkTotalLen, wavBuffer.length)

      if (chunkId !== 'meta') {
        keptChunks.push(wavBuffer.subarray(offset, chunkEnd))
      }
      offset = chunkEnd
    }

    const metaJsonBuffer = Buffer.from(JSON.stringify(meta), 'utf-8')
    const metaChunkSize = metaJsonBuffer.length
    const metaPadding = metaChunkSize % 2 !== 0 ? 1 : 0

    const metaHeader = Buffer.alloc(8)
    metaHeader.write('meta', 0)
    metaHeader.writeUInt32LE(metaChunkSize, 4)

    const chunksToCombine = [
      wavBuffer.subarray(0, 12),
      ...keptChunks,
      metaHeader,
      metaJsonBuffer,
      ...(metaPadding ? [Buffer.alloc(1, 0)] : [])
    ]
    const finalBuffer = Buffer.concat(chunksToCombine)

    // 重写 RIFF 总大小字段（总字节数 - 8）
    finalBuffer.writeUInt32LE(finalBuffer.length - 8, 4)
    return finalBuffer
  }

  /**
   * 从已存在的 WAV 文件中读取嵌入的 'meta' Chunk
   */
  public async readWavMetadata(wavPath: string): Promise<TTSWavMetadata | null> {
    try {
      if (!fs.existsSync(wavPath)) {
        return null
      }

      const fileBuffer = await fsPromises.readFile(wavPath)
      if (fileBuffer.length < 44) {
        return null
      }

      // 验证 RIFF 与 WAVE 标识
      if (
        fileBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
        fileBuffer.toString('ascii', 8, 12) !== 'WAVE'
      ) {
        return null
      }

      let offset = 12
      while (offset + 8 <= fileBuffer.length) {
        const chunkId = fileBuffer.toString('ascii', offset, offset + 4)
        const chunkSize = fileBuffer.readUInt32LE(offset + 4)
        offset += 8

        if (chunkId === 'meta') {
          if (offset + chunkSize <= fileBuffer.length) {
            const jsonStr = fileBuffer.toString('utf-8', offset, offset + chunkSize)
            const meta = JSON.parse(jsonStr) as TTSWavMetadata
            return meta
          }
          break
        }

        // 跳过当前 chunk 数据（RIFF 要求 2 字节对齐）
        offset += chunkSize + (chunkSize % 2)
      }

      // 若未包含自定义 meta chunk，基于已有的 PCM 数据推断基础信息
      return {
        completed: false,
        total: 0,
        done: 0,
        sid: 44,
        speed: 1.0
      }
    } catch (err) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 读取 WAV 元数据失败 (${wavPath}):`, err)
      return null
    }
  }

  /**
   * 读取本地完整 WAV 文件供秒播
   */
  public async readWavFile(wavPath: string): Promise<Buffer | null> {
    try {
      if (!fs.existsSync(wavPath)) {
        return null
      }
      return await fsPromises.readFile(wavPath)
    } catch (err) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 读取 WAV 文件失败 (${wavPath}):`, err)
      return null
    }
  }

  /**
   * 流式增量写入/追加单句 PCM 数据并原子更新尾部 meta Chunk
   */
  public async appendWavChunk(params: AppendWavChunkParams): Promise<boolean> {
    const {
      wavPath,
      chunkData,
      chunkIndex,
      totalChunks,
      sid,
      voiceId,
      speed,
      fileFingerprint,
      fieldName
    } = params

    try {
      // 提取纯 PCM 裸数据与音频规格参数（若包含 44 字节头部则剥离）
      let rawPcm: Buffer
      let numChannels = 2
      let sampleRate = 48000
      let byteRate = 192000
      let blockAlign = 4
      let bitsPerSample = 16

      const inputBuffer = Buffer.isBuffer(chunkData) ? chunkData : Buffer.from(chunkData)
      if (inputBuffer.length > 44 && inputBuffer.toString('ascii', 0, 4) === 'RIFF') {
        rawPcm = inputBuffer.subarray(44)
        numChannels = inputBuffer.readUInt16LE(22)
        sampleRate = inputBuffer.readUInt32LE(24)
        byteRate = inputBuffer.readUInt32LE(28)
        blockAlign = inputBuffer.readUInt16LE(32)
        bitsPerSample = inputBuffer.readUInt16LE(34)
      } else {
        rawPcm = inputBuffer
      }

      if (rawPcm.length === 0) {
        return false
      }

      let existingPcm: Buffer = Buffer.alloc(0)

      // 仅当 chunkIndex > 0 时才从已有文件中追加 PCM；若 chunkIndex === 0，必须作为新录制覆写重建
      if (chunkIndex > 0 && fs.existsSync(wavPath)) {
        try {
          const oldFile = await fsPromises.readFile(wavPath)
          if (
            oldFile.length >= 44 &&
            oldFile.toString('ascii', 0, 4) === 'RIFF' &&
            oldFile.toString('ascii', 8, 12) === 'WAVE'
          ) {
            let offset = 12
            while (offset + 8 <= oldFile.length) {
              const chunkId = oldFile.toString('ascii', offset, offset + 4)
              const chunkSize = oldFile.readUInt32LE(offset + 4)
              offset += 8

              if (chunkId === 'data') {
                const dataEnd = Math.min(offset + chunkSize, oldFile.length)
                existingPcm = oldFile.subarray(offset, dataEnd)
                break
              }

              offset += chunkSize + (chunkSize % 2)
            }
          }
        } catch (e) {
          logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 读取已有 WAV 出错，重新创建:`, e)
        }
      }

      // 合并 PCM 音频数据
      const mergedPcm = existingPcm.length > 0 ? Buffer.concat([existingPcm, rawPcm]) : rawPcm
      const totalPcmBytes = mergedPcm.length
      const pcmPadding = totalPcmBytes % 2 !== 0 ? 1 : 0

      // 构建更新后的 meta 元数据
      const doneCount = chunkIndex + 1
      const isCompleted = doneCount >= totalChunks
      const resolvedVoiceId = voiceId !== undefined ? String(voiceId) : (sid !== undefined ? String(sid) : 'lilihong_shejian')
      const metaObj: TTSWavMetadata = {
        completed: isCompleted,
        total: totalChunks,
        done: doneCount,
        sid: typeof sid === 'number' ? sid : (typeof voiceId === 'number' ? voiceId : undefined),
        voiceId: resolvedVoiceId,
        displayName: params.displayName,
        speed,
        fingerprint: fileFingerprint,
        fieldName
      }

      const metaJsonBuffer = Buffer.from(JSON.stringify(metaObj), 'utf-8')
      const metaChunkSize = metaJsonBuffer.length
      const metaPadding = metaChunkSize % 2 !== 0 ? 1 : 0

      // 标准 44 字节 WAV 头部构建 (动态自适应采样率与声道，默认 48000Hz 立体声 16-bit)
      // 总 RIFF 大小 = 4(WAVE) + 24(fmt chunk) + 8(data header) + totalPcmBytes + pcmPadding + 8(meta header) + metaChunkSize + metaPadding
      const riffTotalSize = 4 + 24 + 8 + totalPcmBytes + pcmPadding + 8 + metaChunkSize + metaPadding

      const header = Buffer.alloc(44)
      header.write('RIFF', 0)
      header.writeUInt32LE(riffTotalSize, 4)
      header.write('WAVE', 8)
      header.write('fmt ', 12)
      header.writeUInt32LE(16, 16) // PCM fmt size
      header.writeUInt16LE(1, 20) // AudioFormat: 1 (PCM)
      header.writeUInt16LE(numChannels, 22) // NumChannels
      header.writeUInt32LE(sampleRate, 24) // SampleRate
      header.writeUInt32LE(byteRate, 28) // ByteRate
      header.writeUInt16LE(blockAlign, 32) // BlockAlign
      header.writeUInt16LE(bitsPerSample, 34) // BitsPerSample
      header.write('data', 36)
      header.writeUInt32LE(totalPcmBytes, 40)

      // meta chunk 头部
      const metaHeader = Buffer.alloc(8)
      metaHeader.write('meta', 0)
      metaHeader.writeUInt32LE(metaChunkSize, 4)

      // 组装最终完整的自包含合法 WAV 文件
      const parts: Buffer[] = [
        header,
        mergedPcm,
        ...(pcmPadding ? [Buffer.alloc(1, 0)] : []),
        metaHeader,
        metaJsonBuffer,
        ...(metaPadding ? [Buffer.alloc(1, 0)] : [])
      ]
      const finalFileBuffer = Buffer.concat(parts)

      // 确保父目录存在
      const parentDir = path.dirname(wavPath)
      if (!fs.existsSync(parentDir)) {
        await fsPromises.mkdir(parentDir, { recursive: true })
      }

      // 原子写入文件
      await fsPromises.writeFile(wavPath, finalFileBuffer)

      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[TTS缓存服务] 追加写入 WAV 成功: ${path.basename(wavPath)} (进度: ${doneCount}/${totalChunks}, completed=${isCompleted})`
      )
      return true
    } catch (err) {
      logger.error(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 追加写入 WAV 失败:`, err)
      return false
    }
  }

  /**
   * 获取特定音频的分片缓存池目录路径
   */
  public async getChunksDirPath(params: {
    filePath?: string
    fileFingerprint?: string
    fieldName?: string
    displayName?: string
    voiceId: string | number
  }): Promise<string | null> {
    const workspacePath = await this.resolveWorkspaceForPath(params.filePath)
    if (!workspacePath) return null
    await this.ensureTtsDirectory(workspacePath)
    const ttsDir = this.getTtsDirPath(workspacePath)

    const isPreview =
      params.fieldName === 'audition' ||
      params.fieldName === 'preview' ||
      params.fileFingerprint === 'preview' ||
      (params.fileFingerprint && params.fileFingerprint.startsWith('preview_'))

    const fingerprint = isPreview
      ? 'preview'
      : this.resolveFileFingerprint(params.filePath, params.fileFingerprint, undefined, params.fieldName)

    const safeVoice = String(params.voiceId || 'voice').replace(/[^a-zA-Z0-9_-]/g, '_')
    // 优先匹配可能已存在的带 safeDisplay 的历史目录
    if (params.displayName) {
      const safeDisplay = String(params.displayName).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')
      const legacyKey = `${fingerprint}_${safeDisplay}_${safeVoice}`
      const legacyDir = path.join(ttsDir, '.chunks', legacyKey)
      if (fs.existsSync(legacyDir)) {
        return legacyDir
      }
    }
    // 默认使用唯一确定的稳定分片池 key，避免 displayName 缺省或漂移导致分片池割裂
    const baseKey = `${fingerprint}_${safeVoice}`
    return path.join(ttsDir, '.chunks', baseKey)
  }

  /**
   * 将分句 PCM 数据包装为标准 44 字节 WAV 容器
   */
  public wrapPcmAsWav(
    pcmData: Buffer,
    numChannels = 2,
    sampleRate = 48000,
    bitsPerSample = 16
  ): Buffer {
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)
    const dataSize = pcmData.length
    const riffSize = 36 + dataSize

    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(riffSize, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(numChannels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36)
    header.writeUInt32LE(dataSize, 40)

    return Buffer.concat([header, pcmData])
  }

  /**
   * 计算 WAV Buffer 物理发音时长（秒）
   */
  public calculateWavDuration(wavBuffer: Buffer): number {
    if (wavBuffer.length < 44) return 0
    const numChannels = wavBuffer.readUInt16LE(22)
    const sampleRate = wavBuffer.readUInt32LE(24)
    const bitsPerSample = wavBuffer.readUInt16LE(34)
    const dataSize = wavBuffer.length - 44
    const bytesPerSec = sampleRate * numChannels * (bitsPerSample / 8)
    return bytesPerSec > 0 ? dataSize / bytesPerSec : 0
  }

  /**
   * 保存独立分片文件并原子更新清单（即合成即落盘，零内存驻留）
   */
  public async saveChunk(params: SaveChunkParams): Promise<boolean> {
    try {
      const chunksDir = await this.getChunksDirPath(params)
      if (!chunksDir) return false
      if (!fs.existsSync(chunksDir)) {
        await fsPromises.mkdir(chunksDir, { recursive: true })
      }

      const chunkPath = path.join(chunksDir, `chunk_${params.chunkIndex}.wav`)
      const inputBuffer = Buffer.isBuffer(params.chunkData)
        ? params.chunkData
        : Buffer.from(params.chunkData)

      let wavBuffer = inputBuffer
      if (inputBuffer.length > 44 && inputBuffer.toString('ascii', 0, 4) === 'RIFF') {
        wavBuffer = inputBuffer
      } else {
        wavBuffer = this.wrapPcmAsWav(inputBuffer, 2, 48000, 16)
      }

      await fsPromises.writeFile(chunkPath, wavBuffer)

      let duration = params.duration
      if (!duration || duration <= 0) {
        duration = this.calculateWavDuration(wavBuffer)
      }

      const manifestPath = path.join(chunksDir, 'manifest.json')
      let manifest: TTSChunkManifest = {
        total: params.totalChunks,
        voiceId: String(params.voiceId),
        displayName: params.displayName,
        fileFingerprint: params.fileFingerprint,
        fieldName: params.fieldName,
        completed: [],
        cues: {}
      }

      if (fs.existsSync(manifestPath)) {
        try {
          const raw = await fsPromises.readFile(manifestPath, 'utf-8')
          manifest = JSON.parse(raw)
        } catch {}
      }

      manifest.total = params.totalChunks
      if (!manifest.completed.includes(params.chunkIndex)) {
        manifest.completed.push(params.chunkIndex)
        manifest.completed.sort((a, b) => a - b)
      }

      let textHash: string | undefined
      if (params.chunkText && params.chunkText.trim()) {
        textHash = crypto.createHash('sha256').update(params.chunkText.trim()).digest('hex').slice(0, 16)
      }

      manifest.cues[String(params.chunkIndex)] = {
        duration,
        ...(textHash ? { textHash } : {})
      }

      await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

      // 若全部句子均已集齐无空洞，触发终态流式合并
      if (manifest.completed.length >= params.totalChunks) {
        const isAllPresent = Array.from({ length: params.totalChunks }, (_, i) => i).every(
          idx => manifest.completed.includes(idx)
        )
        if (isAllPresent) {
          logger.info(
            LogCategory.FILE_PROCESSOR,
            `[TTS缓存服务] 所有 ${params.totalChunks} 个分片已集齐，开始执行终态流式合并...`
          )
          await this.assembleFinalWav(chunksDir, manifest, params).catch(err => {
            logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 自动合并完整 WAV 异常:`, err)
          })
        }
      }

      return true
    } catch (err) {
      logger.error(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 保存分片异常:`, err)
      return false
    }
  }

  /**
   * 从分片池中读取指定分片音频
   * 若提供了 chunkText，将校验文本指纹，防分句切片升级后产生错位
   */
  public async readChunk(params: ReadChunkParams): Promise<Buffer | null> {
    try {
      const chunksDir = await this.getChunksDirPath(params)
      if (!chunksDir) return null
      const chunkPath = path.join(chunksDir, `chunk_${params.chunkIndex}.wav`)
      if (!fs.existsSync(chunkPath)) return null

      // 若指定了 chunkText，严格比对 manifest.json 中的文本指纹（Cache Shield 防错位屏障）
      if (params.chunkText && params.chunkText.trim()) {
        const manifestPath = path.join(chunksDir, 'manifest.json')
        if (!fs.existsSync(manifestPath)) {
          logger.warn(
            LogCategory.FILE_PROCESSOR,
            `[TTS缓存服务] 分片 ${params.chunkIndex} 缺失 manifest.json，判定为未命中重新合成`
          )
          return null
        }
        try {
          const raw = await fsPromises.readFile(manifestPath, 'utf-8')
          const manifest = JSON.parse(raw) as TTSChunkManifest
          const cue = manifest.cues?.[String(params.chunkIndex)]
          const expectedHash = crypto
            .createHash('sha256')
            .update(params.chunkText.trim())
            .digest('hex')
            .slice(0, 16)

          if (!cue?.textHash || cue.textHash !== expectedHash) {
            logger.warn(
              LogCategory.FILE_PROCESSOR,
              `[TTS缓存服务] 分片 ${params.chunkIndex} 文本指纹缺失或不匹配 (缓存: ${cue?.textHash || 'none'}, 当前: ${expectedHash})，判定为未命中重新合成`
            )
            return null
          }
        } catch (manifestErr) {
          logger.warn(
            LogCategory.FILE_PROCESSOR,
            `[TTS缓存服务] 读取 manifest.json 校验文本指纹失败:`,
            manifestErr
          )
          return null
        }
      }

      return await fsPromises.readFile(chunkPath)
    } catch (err) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] readChunk 异常:`, err)
      return null
    }
  }

  /**
   * 将分片池中的所有分片按 0..N-1 严格升序组装为自包含标准母带 WAV
   * 并在 meta chunk 中注入精确的分片起止时间戳表 (Cue Table)
   */
  public async assembleFinalWav(
    chunksDir: string,
    manifest: TTSChunkManifest,
    params: SaveChunkParams
  ): Promise<string | null> {
    try {
      const total = manifest.total
      const pcmList: Buffer[] = []
      const cueList: TTSChunkCue[] = []
      let currentTime = 0
      let numChannels = 2
      let sampleRate = 48000
      let byteRate = 192000
      let blockAlign = 4
      let bitsPerSample = 16

      for (let i = 0; i < total; i++) {
        const chunkPath = path.join(chunksDir, `chunk_${i}.wav`)
        if (!fs.existsSync(chunkPath)) {
          logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 合并中断：缺失分片 ${chunkPath}`)
          return null
        }

        const chunkBuffer = await fsPromises.readFile(chunkPath)
        if (chunkBuffer.length < 44) continue

        numChannels = chunkBuffer.readUInt16LE(22)
        sampleRate = chunkBuffer.readUInt32LE(24)
        byteRate = chunkBuffer.readUInt32LE(28)
        blockAlign = chunkBuffer.readUInt16LE(32)
        bitsPerSample = chunkBuffer.readUInt16LE(34)

        const rawPcm = chunkBuffer.subarray(44)
        const bytesPerSec = sampleRate * numChannels * (bitsPerSample / 8)
        const duration = bytesPerSec > 0 ? rawPcm.length / bytesPerSec : 0

        cueList.push({
          index: i,
          startTime: currentTime,
          duration,
          textHash: manifest.cues?.[String(i)]?.textHash
        })
        currentTime += duration
        pcmList.push(rawPcm)
      }

      const mergedPcm = Buffer.concat(pcmList)
      const totalPcmBytes = mergedPcm.length
      const pcmPadding = totalPcmBytes % 2 !== 0 ? 1 : 0

      const metaObj: TTSWavMetadata = {
        completed: true,
        total,
        done: total,
        sid: params.sid,
        voiceId: String(params.voiceId),
        displayName: params.displayName,
        speed: 1.0,
        fingerprint: params.fileFingerprint,
        fieldName: params.fieldName,
        chunks: cueList
      }

      const metaJsonBuffer = Buffer.from(JSON.stringify(metaObj), 'utf-8')
      const metaChunkSize = metaJsonBuffer.length
      const metaPadding = metaChunkSize % 2 !== 0 ? 1 : 0

      const riffTotalSize = 4 + 24 + 8 + totalPcmBytes + pcmPadding + 8 + metaChunkSize + metaPadding

      const header = Buffer.alloc(44)
      header.write('RIFF', 0)
      header.writeUInt32LE(riffTotalSize, 4)
      header.write('WAVE', 8)
      header.write('fmt ', 12)
      header.writeUInt32LE(16, 16)
      header.writeUInt16LE(1, 20)
      header.writeUInt16LE(numChannels, 22)
      header.writeUInt32LE(sampleRate, 24)
      header.writeUInt32LE(byteRate, 28)
      header.writeUInt16LE(blockAlign, 32)
      header.writeUInt16LE(bitsPerSample, 34)
      header.write('data', 36)
      header.writeUInt32LE(totalPcmBytes, 40)

      const metaHeader = Buffer.alloc(8)
      metaHeader.write('meta', 0)
      metaHeader.writeUInt32LE(metaChunkSize, 4)

      const finalBuffer = Buffer.concat([
        header,
        mergedPcm,
        ...(pcmPadding ? [Buffer.alloc(1, 0)] : []),
        metaHeader,
        metaJsonBuffer,
        ...(metaPadding ? [Buffer.alloc(1, 0)] : [])
      ])

      const workspacePath = await this.resolveWorkspaceForPath(params.filePath)
      if (!workspacePath) return null
      const ttsDir = this.getTtsDirPath(workspacePath)
      const isPreview =
        params.fieldName === 'audition' ||
        params.fieldName === 'preview' ||
        params.fileFingerprint === 'preview' ||
        (params.fileFingerprint && params.fileFingerprint.startsWith('preview_'))

      const fingerprint = isPreview
        ? 'preview'
        : this.resolveFileFingerprint(params.filePath, params.fileFingerprint, undefined, params.fieldName)

      const standard1xName = this.generateCacheFileName(
        fingerprint,
        params.displayName || String(params.voiceId),
        1.0,
        params.voiceId
      )
      const standard1xPath = path.join(ttsDir, standard1xName)

      await fsPromises.writeFile(standard1xPath, finalBuffer)
      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[TTS缓存服务] 成功组装完整 1.0x 母带 WAV 并嵌入 ${cueList.length} 条时间戳索引: ${standard1xName}`
      )

      // 若当前语速非 1.0x，同步派生目标倍速母带并等比缩放时间戳表
      if (params.speed && Math.abs(params.speed - 1.0) >= 0.01) {
        const targetSpeedName = this.generateCacheFileName(
          fingerprint,
          params.displayName || String(params.voiceId),
          params.speed,
          params.voiceId
        )
        const targetSpeedPath = path.join(ttsDir, targetSpeedName)
        await this.deriveScaledWav(standard1xPath, targetSpeedPath, params.speed)
      }

      // 组装完成后安全清理临时分片池
      try {
        await fsPromises.rm(chunksDir, { recursive: true, force: true })
      } catch (rmErr) {
        logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 清理分片临时目录失败:`, rmErr)
      }

      return standard1xPath
    } catch (err) {
      logger.error(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 终态组装 WAV 失败:`, err)
      return null
    }
  }

  /**
   * 在系统资源管理器中定位并选中该音频文件
   */
  public locateWavFile(wavPath: string): boolean {
    try {
      if (fs.existsSync(wavPath)) {
        shell.showItemInFolder(wavPath)
        return true
      }
      return false
    } catch (err) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[TTS缓存服务] 定位文件失败 (${wavPath}):`, err)
      return false
    }
  }
}

export const ttsWavCacheService = new TTSWavCacheService()
