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
import { logger, LogCategory, ResourceLocator, PluginPathResolver } from '@firefly/shared'
import { omniClient } from '../../services/omni-client'
import { omniService } from '../system/omni-service'
import { moduleHibernationCoordinator } from '../hibernation/module-hibernation-coordinator'
import { PRESET_VOICES, type VoiceMeta } from '../../../renderer/constants/tts-voices'

/**
 * M5-TTS 原生 preset_voices.json ID 到策展元数据 (PRESET_VOICES) ID 的 1:1 映射表。
 * 保留 M5 原生 `voice_m5_*` 作为运行时 ID（直通 Omni O(1) 精确命中），同时复用策展过的
 * 优雅显示名、准确性别/语种与推荐标记，避免 UI 直接暴露原始音频文件名。
 */
const M5_VOICE_ID_TO_CURATED_ID: Record<string, string> = {
  voice_m5_azure_云希: 'azure_yunxi',
  voice_m5_azure_云野: 'azure_yunye',
  voice_m5_donald_j_trump: 'donald_trump',
  voice_m5_my_biggest_weaknesses_is_asking_for_help_when_i_need_it: 'english_native_male',
  voice_m5_ホットするっていうかそれはあの: 'japanese_daily',
  voice_m5_一支穿云箭_千军万马来相见: 'zhouxingchi',
  voice_m5_丁真: 'dingzhen',
  voice_m5_东北娘们: 'dongbei_dajie',
  voice_m5_从来没有一位高官_会在在位或者退休之后: 'documentary_male',
  voice_m5_你干嘛哈哈哎哟: 'kunkun_sound',
  voice_m5_光动嘴不如亲自做给你看: 'action_youth',
  voice_m5_卢本伟: 'lubenwei',
  voice_m5_哪些死去士兵的意义将由我们来赋予: 'erwin',
  voice_m5_喜欢用雷军ai配音来玩梗恶搞的小朋友们你们好_我是雷军: 'leijun',
  voice_m5_坚持才是胜利: 'inspirational_youth',
  voice_m5_大家好我是嘉然戴安娜_关注嘉然顿顿解馋_谢谢: 'jiaran',
  voice_m5_太乙真人: 'taiyi_zhenren',
  voice_m5_奶龙: 'nailong',
  voice_m5_姜文: 'jiangwen',
  voice_m5_孙笑川: 'sunxiaochuan',
  voice_m5_山本_沃日你仙人: 'liangjian_veteran',
  voice_m5_希望你以后_能够做的比我还好哟: 'mentor_gentle',
  voice_m5_常凯申: 'chiang_kai_shek',
  voice_m5_年轻人_不讲武德: 'mabaoguo',
  voice_m5_影视飓风_tim: 'tim',
  voice_m5_懒羊羊: 'lanyangyang',
  voice_m5_我之前无数次地想过_要不然干脆死了算了: 'emotional_monologue',
  voice_m5_我当然知道啦: 'tsundere_girl',
  voice_m5_新闻播报女: 'news_anchor_female',
  voice_m5_新闻播报男: 'news_anchor_male',
  voice_m5_是的_全灭的可能性相当的高: 'anime_hotblood',
  voice_m5_曼波: 'manbo',
  voice_m5_朝鲜播报员: 'passionate_announcer',
  voice_m5_派蒙: 'paimon',
  voice_m5_流萤: 'liuying',
  voice_m5_火山_奶气萌娃: 'huoshan_mengwa',
  voice_m5_火山_朱美: 'huoshan_zhumei',
  voice_m5_火山_湾湾小何: 'huoshan_wanwan',
  voice_m5_火山_猴哥: 'huoshan_houge',
  voice_m5_皆_よろしく: 'japanese_anime',
  voice_m5_短视频解说男声: 'narration_male',
  voice_m5_符玄: 'fuxuan',
  voice_m5_纳西妲: 'nahida',
  voice_m5_舌尖上的中国: 'lilihong_shejian',
  voice_m5_营销号_女声: 'marketing_female',
  voice_m5_蔡徐坤: 'caixukun',
  voice_m5_要到饭了_兄弟们: 'outdoor_streamer',
  voice_m5_说得好像您带我以来我考好过几次一样: 'naughty_boy',
  voice_m5_这种富裕仗_我八辈子也没有打过_咱们就敞开了当回地主_没有助攻_全他娘的主攻: 'liyunlong',
  voice_m5_钟离: 'zhongli',
  voice_m5_麦克阿瑟: 'macarthur'
}

const CURATED_VOICE_BY_ID = new Map<string, VoiceMeta>(PRESET_VOICES.map(v => [v.id, v]))

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
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  private constructor() {
    // 监听 Omni 服务启动就绪事件，崩溃重启时自动全量重放注册用户自定义音色
    omniService.onReady(async () => {
      logger.info(
        LogCategory.SYSTEM,
        '[VoiceArchiveService] Omni 服务已就绪，正在重放注册本地自定义音色...'
      )
      await this.replayRegisterCustomVoices()
    })

    // 定期 5 分钟扫描清理过期的临时暂存特征码
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupExpiredTempVoices()
      },
      5 * 60 * 1000
    )
    this.cleanupTimer.unref?.()
  }

  /**
   * 停止临时音色清理定时器（before-quit 清理路径调用）
   */
  public stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
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
   * 失效内置预置音色缓存（在模块切换、卸载或拓扑变更时被调用）
   */
  public invalidatePresetVoicesCache(): void {
    this.presetVoicesCache = null
  }

  /**
   * 读取预置内置音色元数据列表（区分 tts_moss_onnx 与 tts_m5_onnx）
   * 严守 AGENTS.md §2.9/§2.10：严禁生产欺诈伪兜底，未挂载时返回空数组且不污染缓存
   */
  public async getPresetVoices(moduleOverride?: string): Promise<VoiceMeta[]> {
    if (this.presetVoicesCache && this.presetVoicesCache.length > 0) {
      return this.presetVoicesCache
    }

    let activeModuleId: string | null = moduleOverride || null
    let pluginsRoot = ''
    try {
      // 使用 ESM 动态 import 规避与 modular-resource-service-core 的循环依赖，
      // 严禁使用 CommonJS require('../system/...')（主进程单文件打包后会保留字面量路径导致 MODULE_NOT_FOUND）
      const { modularResourceService } = await import('../system/modular-resource-service')
      if (!activeModuleId) {
        const activeModule = modularResourceService?.getActiveModuleBySlot?.('voice_tts')
        if (activeModule && activeModule.install_state === 'active') {
          activeModuleId = activeModule.id
        }
      }
      pluginsRoot =
        modularResourceService?.getPluginsRootDir?.() ||
        (() => {
          try {
            return PluginPathResolver.getPluginsRootDir()
          } catch {
            return ''
          }
        })()
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        '[VoiceArchiveService] 动态加载 modularResourceService 失败，回退 PluginPathResolver:',
        err
      )
      try {
        pluginsRoot = PluginPathResolver.getPluginsRootDir()
      } catch (resolverErr) {
        logger.warn(
          LogCategory.SYSTEM,
          '[VoiceArchiveService] PluginPathResolver.getPluginsRootDir 失败:',
          resolverErr
        )
      }
    }

    if (!activeModuleId) {
      return []
    }

    try {
      if (activeModuleId === 'tts_m5_onnx') {
        const candidateJsonPaths = [
          pluginsRoot
            ? path.join(pluginsRoot, '_shared', 'tts-e43ab9e3', 'preset_voices.json')
            : '',
          pluginsRoot
            ? path.join(
                pluginsRoot,
                '_shared',
                'tts-e43ab9e3',
                'models',
                'audio',
                'm5',
                'preset_voices.json'
              )
            : '',
          pluginsRoot
            ? path.join(
                pluginsRoot,
                '_shared',
                'm5-tts',
                'models',
                'audio',
                'm5',
                'preset_voices.json'
              )
            : '',
          pluginsRoot ? path.join(pluginsRoot, '_shared', 'm5-tts', 'preset_voices.json') : '',
          process.env.OMNI_M5_VOICES_PATH || '',
          ResourceLocator.resolveResourcePath?.('models/audio/m5/preset_voices.json') || '',
          path.join(
            ResourceLocator.getBaseResourceDir(),
            'models',
            'audio',
            'm5',
            'preset_voices.json'
          ),
          path.join(process.cwd(), 'models', 'audio', 'm5', 'preset_voices.json')
        ]
        let foundJsonPath: string | null = null
        for (const p of candidateJsonPaths) {
          if (p && fs.existsSync(p)) {
            foundJsonPath = p
            break
          }
        }
        if (foundJsonPath) {
          const rawStr = await fsPromises.readFile(foundJsonPath, 'utf-8')
          const rawItems = JSON.parse(rawStr)
          if (Array.isArray(rawItems)) {
            const voices: VoiceMeta[] = rawItems.map((item: any) => {
              const rawId = String(item.id)
              const curatedId = M5_VOICE_ID_TO_CURATED_ID[rawId]
              const curated = curatedId ? CURATED_VOICE_BY_ID.get(curatedId) : undefined
              return {
                id: rawId,
                displayName: curated?.displayName || String(item.displayName || item.name || rawId),
                gender:
                  curated?.gender ||
                  (item.gender === 'female' || item.gender === 'male' || item.gender === 'child'
                    ? item.gender
                    : 'female'),
                lang: curated?.lang || String(item.lang || 'zh'),
                desc: curated?.desc || String(item.desc || ''),
                recommended: curated ? Boolean(curated.recommended) : Boolean(item.recommended),
                isCustom: false
              }
            })
            if (voices.length > 0) {
              this.presetVoicesCache = voices
              return voices
            }
          }
        }
        return []
      }

      if (activeModuleId === 'tts_moss_onnx') {
        const candidates = [
          pluginsRoot ? path.join(pluginsRoot, '_shared', 'tts-8a04293a', 'preset_voices.bin') : '',
          pluginsRoot ? path.join(pluginsRoot, '_shared', 'moss-tts', 'preset_voices.bin') : '',
          process.env.OMNI_MOSS_VOICES_PATH || '',
          ResourceLocator.resolveResourcePath?.('modules/_shared/moss-tts/preset_voices.bin') || '',
          path.join(
            process.env.USERPROFILE || process.env.HOME || '',
            '.cache/moss_tts_test/test_voices.bin'
          )
        ]

        let presetBinPath: string | null = null
        for (const p of candidates) {
          if (p && fs.existsSync(p)) {
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

            if (
              magic === ARCHIVE_MAGIC &&
              version === ARCHIVE_VERSION &&
              buf.length >= HEADER_SIZE + metaLength
            ) {
              const metaJsonStr = buf.toString('utf-8', HEADER_SIZE, HEADER_SIZE + metaLength)
              const parsed = JSON.parse(metaJsonStr)
              if (parsed && Array.isArray(parsed.voices)) {
                this.presetVoicesCache = parsed.voices
                return parsed.voices
              }
            }
          }
        }
        return []
      }
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        `[VoiceArchiveService] 读取预置音色失败 (${activeModuleId}):`,
        err
      )
    }

    return []
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
          logger.warn(
            LogCategory.SYSTEM,
            `[VoiceArchiveService] 读取单音色文件 ${file} 失败:`,
            readErr
          )
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
    const [presets, customs] = await Promise.all([this.getPresetVoices(), this.getCustomVoices()])
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

    // 声音克隆固定经统一休眠门闩激活并保护 'tts-moss-onnx'
    const result = await moduleHibernationCoordinator.withHibernationGate(
      {
        targetId: 'tts-moss-onnx',
        clusterId: 'tts_media',
        livenessSourceKey: 'task_progress'
      },
      async (_lease, signal) => await omniClient.analyzeVoice(filePath, signal)
    )
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

      logger.info(
        LogCategory.SYSTEM,
        `[VoiceArchiveService] 成功保存自定义音色 ${voiceId} (${voiceMeta.displayName})`
      )
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
        logger.info(
          LogCategory.SYSTEM,
          `[VoiceArchiveService] 成功删除自定义音色文件: ${targetFilePath}`
        )
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
          logger.warn(
            LogCategory.SYSTEM,
            `[VoiceArchiveService] 重放注册音色 ${file} 失败:`,
            itemErr
          )
        }
      }

      logger.info(
        LogCategory.SYSTEM,
        `[VoiceArchiveService] 完成自定义音色重放，共注册 ${registeredCount} 个音色`
      )
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[VoiceArchiveService] 重放注册流程异常:', err)
    }
  }
}

export const voiceArchiveService = VoiceArchiveService.getInstance()
