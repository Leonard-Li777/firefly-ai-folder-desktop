/**
 * 音色归档与自包含单文件容器管理器 (VoiceArchiveService)
 * apps/desktop/src/electron/runtime-services/audio/voice-archive-service.ts
 *
 * 核心架构契约 (PRD-0058 / MOSS-TTS Integration Spec §2.3 & §3.2):
 * 1. 读写物理隔离：
 *    - 官方预置音色库 preset_voices.bin 打包在应用只读资源目录，严格只读无写入权限；
 *    - 用户自定义音色采用自包含单文件二进制容器 (*.bin)，写入用户可写目录 <userData>/custom_voices/；
 * 2. 16 字节定长 Header 协议：
 *    - Magic 'MTTS' (4B) + Version 1 (4B LE) + MetaLength (4B LE) + TotalFrames (4B LE) + JSON Meta + RVQ-16 二进制特征码；
 * 3. 内存热注册与崩溃重放自愈：
 *    - 监听 omniService.onReady 事件，Omni 首次启动或崩溃重启后自动遍历本地 custom_voices/*.bin 批量静默重放热注册；
 * 4. 零散数据防护：
 *    - 暂存特征码签发 10 分钟 TTL，防内存泄漏；
 *    - 删除音色时联动重置默认音色与收藏音色列表。
 */

import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import { app } from 'electron'
import { logger, LogCategory, ResourceLocator } from '@firefly/shared'
import { omniClient } from '../../services/omni-client'
import { omniService } from '../system/omni-service'
import { PRESET_VOICES, VoiceMeta } from '../../../renderer/constants/tts-voices'

/** 16 字节 Header 常量 */
const ARCHIVE_MAGIC = 'MTTS'
const ARCHIVE_VERSION = 1
const HEADER_SIZE = 16
const BYTES_PER_FRAME = 32 // 16 codebooks * 2 bytes (i16)

/** 暂存临时音色元数据 (10分钟 TTL) */
interface TempVoiceData {
  tempVoiceId: string
  filePath: string
  lang: 'zh' | 'en' | 'ja'
  emotion: string
  suggestedName: string
  durationSec: number
  frames: number
  codes: number[][]
  createdAt: number
}

export class VoiceArchiveService {
  private static instance: VoiceArchiveService
  private tempVoices = new Map<string, TempVoiceData>()
  private presetVoicesCache: VoiceMeta[] | null = null

  private constructor() {
    // 监听 Omni 服务启动就绪事件，崩溃重启时自动全量重放注册用户自定义音色
    omniService.onReady(async () => {
      logger.info(LogCategory.SYSTEM, '[VoiceArchiveService] Omni 服务已就绪，正在重放注册本地自定义音色...')
      await this.replayRegisterCustomVoices()
    })

    // 定期 5 分钟扫描清理过期的临时暂存特征码
    setInterval(() => {
      this.cleanupExpiredTempVoices()
    }, 5 * 60 * 1000)
  }

  public static getInstance(): VoiceArchiveService {
    if (!VoiceArchiveService.instance) {
      VoiceArchiveService.instance = new VoiceArchiveService()
    }
    return VoiceArchiveService.instance
  }

  /**
   * 获取用户自定义音色存储目录 <userData>/custom_voices
   */
  public getCustomVoicesDir(): string {
    const userData = app?.getPath ? app.getPath('userData') : process.cwd()
    const dir = path.join(userData, 'custom_voices')
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (err) {
        logger.error(LogCategory.SYSTEM, '[VoiceArchiveService] 创建 custom_voices 目录失败:', err)
      }
    }
    return dir
  }

  /**
   * 清理过期（> 10 分钟）的暂存音色
   */
  private cleanupExpiredTempVoices(): void {
    const now = Date.now()
    const expireThreshold = 10 * 60 * 1000
    for (const [id, item] of this.tempVoices.entries()) {
      if (now - item.createdAt > expireThreshold) {
        this.tempVoices.delete(id)
      }
    }
  }

  /**
   * 读取预置内置音色元数据列表
   */
  public async getPresetVoices(): Promise<VoiceMeta[]> {
    if (this.presetVoicesCache && this.presetVoicesCache.length > 0) {
      return this.presetVoicesCache
    }

    try {
      const baseDir = ResourceLocator.getBaseResourceDir()
      const candidates = [
        path.join(baseDir, 'models/audio/moss/preset_voices.bin'),
        path.join(process.cwd(), 'apps/desktop/build/extraResources/models/audio/moss/preset_voices.bin')
      ]

      let presetBinPath: string | null = null
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          presetBinPath = p
          break
        }
      }

      if (presetBinPath) {
        const buf = await fsPromises.readFile(presetBinPath)
        if (buf.length >= HEADER_SIZE) {
          const magic = buf.toString('ascii', 0, 4)
          const version = buf.readUInt32LE(4)
          const metaLength = buf.readUInt32LE(8)

          if (magic === ARCHIVE_MAGIC && version === ARCHIVE_VERSION && buf.length >= HEADER_SIZE + metaLength) {
            const metaJsonStr = buf.toString('utf-8', HEADER_SIZE, HEADER_SIZE + metaLength)
            const parsed = JSON.parse(metaJsonStr)
            if (parsed && Array.isArray(parsed.voices)) {
              this.presetVoicesCache = parsed.voices
              return parsed.voices
            }
          }
        }
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[VoiceArchiveService] 从 preset_voices.bin 读取元数据失败，回退静态字典:', err)
    }

    this.presetVoicesCache = PRESET_VOICES
    return PRESET_VOICES
  }

  /**
   * 读取所有自定义音色元数据
   */
  public async getCustomVoices(): Promise<VoiceMeta[]> {
    const dir = this.getCustomVoicesDir()
    const customVoices: VoiceMeta[] = []

    try {
      const files = await fsPromises.readdir(dir)
      const binFiles = files.filter(f => f.endsWith('.bin'))

      for (const file of binFiles) {
        const filePath = path.join(dir, file)
        try {
          const buf = await fsPromises.readFile(filePath)
          if (buf.length < HEADER_SIZE) continue

          const magic = buf.toString('ascii', 0, 4)
          const version = buf.readUInt32LE(4)
          const metaLength = buf.readUInt32LE(8)

          if (magic !== ARCHIVE_MAGIC || version !== ARCHIVE_VERSION) continue
          if (buf.length < HEADER_SIZE + metaLength) continue

          const jsonStr = buf.toString('utf-8', HEADER_SIZE, HEADER_SIZE + metaLength)
          const meta = JSON.parse(jsonStr) as VoiceMeta
          if (meta && meta.id) {
            customVoices.push({
              ...meta,
              isCustom: true
            })
          }
        } catch (readErr) {
          logger.warn(LogCategory.SYSTEM, `[VoiceArchiveService] 读取单音色文件 ${file} 失败:`, readErr)
        }
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[VoiceArchiveService] 扫描 custom_voices 目录失败:', err)
    }

    return customVoices
  }

  /**
   * 获取所有可用音色列表（内置 preset + 用户 custom）
   */
  public async listVoices(): Promise<VoiceMeta[]> {
    const [presets, customs] = await Promise.all([
      this.getPresetVoices(),
      this.getCustomVoices()
    ])
    // 严格按 ID 去重（自定义音色优先覆盖同 ID 预置音色）
    const seen = new Set<string>()
    const result: VoiceMeta[] = []
    for (const v of [...customs, ...presets]) {
      if (!seen.has(v.id)) {
        seen.add(v.id)
        result.push(v)
      }
    }
    return result
  }

  /**
   * 分析用户上传的外部参考音频并签发 tempVoiceId
   */
  public async analyzeVoiceFile(filePath: string): Promise<{
    tempVoiceId: string
    lang: 'zh' | 'en' | 'ja'
    emotion: string
    suggestedName: string
    durationSec: number
  }> {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('音频文件不存在')
    }

    // 调用 Omni 进行特征分析与提取
    const result = await omniClient.analyzeVoice(filePath)
    if (!result || !result.success || !result.codes || result.codes.length === 0) {
      throw new Error(result?.error || '提取音频声学特征失败')
    }

    const tempVoiceId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const ext = path.extname(filePath)
    const suggestedName = path.basename(filePath, ext)
    const frames = result.frames || result.codes.length
    // MOSS-TTS Codec 帧率为 12.5 fps
    const durationSec = Math.round((frames / 12.5) * 10) / 10

    const tempData: TempVoiceData = {
      tempVoiceId,
      filePath,
      lang: result.lang || 'zh',
      emotion: result.emotion || 'neutral',
      suggestedName,
      durationSec,
      frames,
      codes: result.codes,
      createdAt: Date.now()
    }

    this.tempVoices.set(tempVoiceId, tempData)

    return {
      tempVoiceId,
      lang: tempData.lang,
      emotion: tempData.emotion,
      suggestedName,
      durationSec
    }
  }

  /**
   * 保存自定义音色到 <userData>/custom_voices/{voice_id}.bin 并注入 Omni 内存
   */
  public async saveCustomVoice(params: {
    tempVoiceId: string
    displayName: string
    gender: 'male' | 'female' | 'child'
    lang: string
    desc?: string
  }): Promise<{ success: boolean; voice?: VoiceMeta; error?: string }> {
    const { tempVoiceId, displayName, gender, lang, desc } = params
    const cached = this.tempVoices.get(tempVoiceId)

    if (!cached) {
      return { success: false, error: '克隆特征已过期，请重新选择音频文件分析' }
    }

    const voiceId = `custom_${Date.now()}`
    const customDir = this.getCustomVoicesDir()
    const targetFilePath = path.join(customDir, `${voiceId}.bin`)

    try {
      const voiceMeta: VoiceMeta = {
        id: voiceId,
        displayName: displayName.trim() || cached.suggestedName,
        gender: gender || 'male',
        lang: lang || cached.lang,
        desc: (desc && desc.trim()) || `用户自定义音色 (${displayName})`,
        emotion: cached.emotion,
        isCustom: true,
        recommended: false
      }

      // 序列化 JSON 元数据
      const metaJson = {
        version: ARCHIVE_VERSION,
        id: voiceMeta.id,
        displayName: voiceMeta.displayName,
        gender: voiceMeta.gender,
        lang: voiceMeta.lang,
        desc: voiceMeta.desc,
        emotion: voiceMeta.emotion,
        isCustom: true,
        frames: cached.frames,
        offset_bytes: 0,
        length_bytes: cached.frames * BYTES_PER_FRAME
      }

      const metaJsonBuf = Buffer.from(JSON.stringify(metaJson), 'utf-8')
      const metaLength = metaJsonBuf.length
      const totalFrames = cached.frames

      // 构建 16 字节定长 Header
      const headerBuf = Buffer.alloc(HEADER_SIZE)
      headerBuf.write(ARCHIVE_MAGIC, 0, 4, 'ascii')
      headerBuf.writeUInt32LE(ARCHIVE_VERSION, 4)
      headerBuf.writeUInt32LE(metaLength, 8)
      headerBuf.writeUInt32LE(totalFrames, 12)

      // 构建声学特征码二进制 Buffer (frames * 16 * 2 字节)
      const dataBuf = Buffer.alloc(totalFrames * BYTES_PER_FRAME)
      for (let f = 0; f < totalFrames; f++) {
        const frameRow = cached.codes[f] || []
        for (let cb = 0; cb < 16; cb++) {
          const val = frameRow[cb] !== undefined ? frameRow[cb] : 0
          dataBuf.writeInt16LE(val, (f * 16 + cb) * 2)
        }
      }

      // 写入自包含单文件容器
      const finalArchiveBuf = Buffer.concat([headerBuf, metaJsonBuf, dataBuf])
      await fsPromises.writeFile(targetFilePath, finalArchiveBuf)

      // 注入 Omni 内存热注册
      await omniClient.registerVoice(voiceId, cached.frames, cached.codes)

      // 清理临时缓存
      this.tempVoices.delete(tempVoiceId)

      logger.info(LogCategory.SYSTEM, `[VoiceArchiveService] 成功保存自定义音色 ${voiceId} (${voiceMeta.displayName})`)
      return {
        success: true,
        voice: voiceMeta
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[VoiceArchiveService] 保存自定义音色失败:', err)
      return {
        success: false,
        error: err?.message || '保存自定义音色失败'
      }
    }
  }

  /**
   * 删除自定义音色文件并注销
   */
  public async removeCustomVoice(voiceId: string): Promise<boolean> {
    if (!voiceId || !/^[a-zA-Z0-9_-]{1,64}$/.test(voiceId)) {
      return false
    }

    const customDir = this.getCustomVoicesDir()
    const targetFilePath = path.join(customDir, `${voiceId}.bin`)

    try {
      if (fs.existsSync(targetFilePath)) {
        await fsPromises.unlink(targetFilePath)
        logger.info(LogCategory.SYSTEM, `[VoiceArchiveService] 成功删除自定义音色文件: ${targetFilePath}`)
      }

      // 级联处理配置兜底：若删除的是默认音色或处于收藏中，由主进程/设置端协同更新
      return true
    } catch (err) {
      logger.error(LogCategory.SYSTEM, `[VoiceArchiveService] 删除音色 ${voiceId} 失败:`, err)
      return false
    }
  }

  /**
   * 重放批量热注册所有自定义音色到 Omni 内存
   */
  public async replayRegisterCustomVoices(): Promise<void> {
    const dir = this.getCustomVoicesDir()
    try {
      const files = await fsPromises.readdir(dir)
      const binFiles = files.filter(f => f.endsWith('.bin'))

      let registeredCount = 0
      for (const file of binFiles) {
        const filePath = path.join(dir, file)
        try {
          const buf = await fsPromises.readFile(filePath)
          if (buf.length < HEADER_SIZE) continue

          const magic = buf.toString('ascii', 0, 4)
          const version = buf.readUInt32LE(4)
          const metaLength = buf.readUInt32LE(8)
          const totalFrames = buf.readUInt32LE(12)

          if (magic !== ARCHIVE_MAGIC || version !== ARCHIVE_VERSION) continue
          if (buf.length < HEADER_SIZE + metaLength + totalFrames * BYTES_PER_FRAME) continue

          const metaJsonStr = buf.toString('utf-8', HEADER_SIZE, HEADER_SIZE + metaLength)
          const meta = JSON.parse(metaJsonStr)
          const dataStart = HEADER_SIZE + metaLength

          // 解析 codes 二进制回二维数组
          const codes: number[][] = []
          for (let f = 0; f < totalFrames; f++) {
            const row: number[] = []
            for (let cb = 0; cb < 16; cb++) {
              const val = buf.readInt16LE(dataStart + (f * 16 + cb) * 2)
              row.push(val)
            }
            codes.push(row)
          }

          await omniClient.registerVoice(meta.id, totalFrames, codes)
          registeredCount++
        } catch (itemErr) {
          logger.warn(LogCategory.SYSTEM, `[VoiceArchiveService] 重放注册音色 ${file} 失败:`, itemErr)
        }
      }

      logger.info(LogCategory.SYSTEM, `[VoiceArchiveService] 完成自定义音色重放，共注册 ${registeredCount} 个音色`)
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[VoiceArchiveService] 重放注册流程异常:', err)
    }
  }
}

export const voiceArchiveService = VoiceArchiveService.getInstance()
