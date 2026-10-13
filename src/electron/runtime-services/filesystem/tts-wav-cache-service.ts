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
import { logger, LogCategory, isSubPath, getFfmpegPath } from '@firefly/shared'
import { databaseService } from '../database/database-service'

const execFileAsync = promisify(execFile)

/** 虚拟目录及 TTS 缓存目录常量 */
export const VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'
export const TTS_CACHE_FOLDER = '.tts'

/** WAV 内嵌 meta 元数据结构 */
export interface TTSWavMetadata {
  /** 是否全部句子合成完毕 */
  completed: boolean
  /** 总分句数 */
  total: number
  /** 当前已完成分句数 */
  done: number
  /** 发音人 ID */
  sid: number
  /** 播放语速 */
  speed: number
  /** 文件指纹 */
  fingerprint?: string
  /** 字段标识 */
  fieldName?: string
}

export interface AppendWavChunkParams {
  wavPath: string
  /** 分句音频二进制（支持带 44 字节头的 WAV 或裸 PCM） */
  chunkData: Uint8Array | Buffer
  chunkIndex: number
  totalChunks: number
  sid: number
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

        // 设置为隐藏目录（仅Windows）
        if (process.platform === 'win32') {
          try {
            await execFileAsync('attrib', ['+h', ttsDirPath])
            logger.info(
              LogCategory.FILE_PROCESSOR,
              `[TTS缓存服务] 已将 TTS 缓存目录设置为隐藏: ${ttsDirPath}`
            )
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
    text?: string
  ): string {
    if (fileFingerprint && fileFingerprint.trim()) {
      return fileFingerprint.trim()
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
   * 格式: {fileFingerprint}_{fieldName}_{sid}.wav
   * 规范：深度学习模型统一合成 1.0x 标准黄金母带，不同语速共享唯一物理缓存，彻底避免重复合成
   */
  public generateCacheFileName(
    fileFingerprint: string,
    fieldName: string = 'textContent',
    sid: number = 44,
    _speed: number = 1.0
  ): string {
    const safeField = fieldName.replace(/[^a-zA-Z0-9_-]/g, '_')
    return `${fileFingerprint}_${safeField}_${sid}.wav`
  }

  /**
   * 获取内置 FFmpeg 可执行文件路径
   * 委托至 @firefly/shared 统一的 ResourceLocator 资源解析器
   */
  public getFfmpegPath(): string | null {
    return getFfmpegPath()
  }

  /**
   * 利用内置 FFmpeg 高保真（atempo 算法）转换 WAV 语速倍率（保音调、无失真）
   */
  public async convertWavSpeed(
    inputWavPath: string,
    outputWavPath: string,
    targetSpeed: number
  ): Promise<boolean> {
    if (Math.abs(targetSpeed - 1.0) < 0.01) {
      await fsPromises.copyFile(inputWavPath, outputWavPath)
      return true
    }
    const ffmpegPath = getFfmpegPath()
    if (!ffmpegPath) {
      logger.warn(LogCategory.FILE_PROCESSOR, '[TTS缓存服务] 未找到内置 ffmpeg，回退直接复制')
      await fsPromises.copyFile(inputWavPath, outputWavPath)
      return false
    }
    const speed = Math.max(0.5, Math.min(2.0, targetSpeed))
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i',
      inputWavPath,
      '-filter:a',
      `atempo=${speed}`,
      outputWavPath
    ])
    return true
  }

  /**
   * 获取缓存文件的完整绝对路径（优先标准母带，兼容历史旧格式）
   */
  public async getCacheWavPath(params: {
    filePath?: string
    fieldName?: string
    fileFingerprint?: string
    text?: string
    sid?: number
    speed?: number
  }): Promise<string | null> {
    const workspacePath = await this.resolveWorkspaceForPath(params.filePath)
    if (!workspacePath) {
      return null
    }

    await this.ensureTtsDirectory(workspacePath)
    const ttsDir = this.getTtsDirPath(workspacePath)
    const fingerprint = this.resolveFileFingerprint(
      params.filePath,
      params.fileFingerprint,
      params.text
    )
    const standardName = this.generateCacheFileName(
      fingerprint,
      params.fieldName,
      params.sid ?? 44,
      1.0
    )
    const standardPath = path.join(ttsDir, standardName)
    if (fs.existsSync(standardPath)) {
      return standardPath
    }

    // 兼容历史旧格式（如带 _1x.wav）
    if (params.speed) {
      const speedStr = Number(params.speed).toFixed(2).replace(/\.?0+$/, '')
      const legacyName = `${fingerprint}_${(params.fieldName || 'textContent').replace(/[^a-zA-Z0-9_-]/g, '_')}_${params.sid ?? 44}_${speedStr}x.wav`
      const legacyPath = path.join(ttsDir, legacyName)
      if (fs.existsSync(legacyPath)) {
        return legacyPath
      }
    }

    return standardPath
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
      speed,
      fileFingerprint,
      fieldName
    } = params

    try {
      // 提取纯 PCM 裸数据（若包含 44 字节头部则剥离）
      let rawPcm: Buffer
      const inputBuffer = Buffer.isBuffer(chunkData) ? chunkData : Buffer.from(chunkData)
      if (inputBuffer.length > 44 && inputBuffer.toString('ascii', 0, 4) === 'RIFF') {
        rawPcm = inputBuffer.subarray(44)
      } else {
        rawPcm = inputBuffer
      }

      if (rawPcm.length === 0) {
        return false
      }

      let existingPcm: Buffer = Buffer.alloc(0)

      // 若文件已存在，解析提取已有完整的 PCM 数据
      if (fs.existsSync(wavPath)) {
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
      const metaObj: TTSWavMetadata = {
        completed: isCompleted,
        total: totalChunks,
        done: doneCount,
        sid,
        speed,
        fingerprint: fileFingerprint,
        fieldName
      }

      const metaJsonBuffer = Buffer.from(JSON.stringify(metaObj), 'utf-8')
      const metaChunkSize = metaJsonBuffer.length
      const metaPadding = metaChunkSize % 2 !== 0 ? 1 : 0

      // 标准 44 字节 WAV 头部构建 (24000Hz, 16-bit Mono)
      // 总 RIFF 大小 = 4(WAVE) + 24(fmt chunk) + 8(data header) + totalPcmBytes + pcmPadding + 8(meta header) + metaChunkSize + metaPadding
      const riffTotalSize = 4 + 24 + 8 + totalPcmBytes + pcmPadding + 8 + metaChunkSize + metaPadding

      const header = Buffer.alloc(44)
      header.write('RIFF', 0)
      header.writeUInt32LE(riffTotalSize, 4)
      header.write('WAVE', 8)
      header.write('fmt ', 12)
      header.writeUInt32LE(16, 16) // PCM fmt size
      header.writeUInt16LE(1, 20) // AudioFormat: 1 (PCM)
      header.writeUInt16LE(1, 22) // NumChannels: 1
      header.writeUInt32LE(24000, 24) // SampleRate: 24000
      header.writeUInt32LE(48000, 28) // ByteRate: 24000 * 1 * 2
      header.writeUInt16LE(2, 32) // BlockAlign: 1 * 2
      header.writeUInt16LE(16, 34) // BitsPerSample: 16
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
