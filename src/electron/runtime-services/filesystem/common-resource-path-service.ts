/**
 * 全局公共资源路径与内容寻址存储 (CAS) 管理服务
 * 规范来源：docs/specs/v4-plugin-engine-workspace-deepening-spec.md §3.1.1
 *
 * 核心职责：
 * 1. 统一管理全局公共资源根目录 COMMON_RESOURCE_PATH（默认位于 userData/resources），允许用户自定义目录
 * 2. 提供缩略图二级分桶 CAS 路径：<COMMON_RESOURCE_PATH>/thumbnails/<ab>/<fingerprint>.webp
 * 3. 提供语音合成音频 CAS 路径：<COMMON_RESOURCE_PATH>/audio_synthesis/<fingerprint>/<voiceId>_<speedFixed2>.wav
 *    及分片目录：<COMMON_RESOURCE_PATH>/audio_synthesis/<fingerprint>/<voiceId>_<speedFixed2>/chunks
 * 4. 执行可写性探测 (Write Probe，带 30s 短 TTL 缓存避免批量分析期 I/O 放大) 与离线/不可写时的 TEMP_PATH 优雅降级
 * 5. 支持切换目录后的历史目录持久化（PREVIOUS_COMMON_RESOURCE_PATH）与懒加载复用，以及旧版 .VirtualDirectory/.thumbnail 与 .tts 的只读兼容
 */

import { app } from 'electron'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { logger, LogCategory, isPathEqual } from '@firefly/shared'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { t } from '@app/languages'

export const COMMON_THUMBNAILS_DIR_NAME = 'thumbnails'
export const COMMON_AUDIO_SYNTHESIS_DIR_NAME = 'audio_synthesis'
const LEGACY_VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'
const LEGACY_THUMBNAIL_FOLDER = '.thumbnail'
const LEGACY_TTS_FOLDER = '.tts'
const EFFECTIVE_ROOT_CACHE_TTL_MS = 30_000

export interface CommonResourceRootResolution {
  /** 当前实际生效的根目录 */
  rootPath: string
  /** 是否触发了不可写降级（降级到 TEMP_PATH/resources） */
  isFallback: boolean
  /** 降级原因（仅 isFallback=true 时存在） */
  fallbackReason?: string
}

export interface CommonResourceDirInfo {
  /** 当前生效路径（若降级则为降级路径） */
  currentPath: string
  /** 配置中保存的路径（未自定义时等于默认路径） */
  configuredPath: string
  /** 系统默认路径 (userData/resources) */
  defaultPath: string
  /** 是否为用户自定义目录 */
  isCustom: boolean
  /** 是否处于降级态 */
  isFallback: boolean
  /** 降级原因 */
  fallbackReason?: string
  /** 缩略图目录绝对路径 */
  thumbnailsDir: string
  /** 语音合成音频目录绝对路径 */
  audioSynthesisDir: string
}

export interface CommonResourcePathUpdateResult {
  success: boolean
  path?: string
  previousPath?: string
  error?: string
}

export type CommonResourceConfigKey =
  | 'COMMON_RESOURCE_PATH'
  | 'PREVIOUS_COMMON_RESOURCE_PATH'
  | 'TEMP_PATH'

export interface CommonResourceConfigAdapter {
  getValue: <T>(key: CommonResourceConfigKey) => T | undefined
  updateValue: (
    key: 'COMMON_RESOURCE_PATH' | 'PREVIOUS_COMMON_RESOURCE_PATH',
    value: string
  ) => Promise<void>
}

interface EffectiveRootCacheEntry {
  configuredRoot: string
  result: CommonResourceRootResolution
  expiresAt: number
}

/**
 * 清洗路径片段，防止目录穿越或非法文件名字符
 */
export function sanitizeCasSegment(raw: string, fallback = 'unknown'): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
  return cleaned.length > 0 ? cleaned : fallback
}

/**
 * 格式化语速为两位小数（如 1.00, 1.25）
 */
export function formatSpeedFixed2(speed?: number): string {
  const numeric = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 1.0
  return numeric.toFixed(2)
}

/**
 * 安全创建目录，捕获并忽略并发初始化的 EEXIST
 */
async function ensureDirSafe(dirPath: string): Promise<void> {
  try {
    await fsPromises.mkdir(dirPath, { recursive: true })
  } catch (error: any) {
    if (error?.code !== 'EEXIST') {
      throw error
    }
  }
}

export class CommonResourcePathService {
  /** 记录本次进程内切换目录前的历史有效根路径，结合持久化 PREVIOUS_COMMON_RESOURCE_PATH 实现跨重启懒复用 */
  private previousRootPaths: string[] = []
  /** 可选配置适配器（主要用于单元测试隔离） */
  private configAdapter?: CommonResourceConfigAdapter
  /** 生效根目录探测短 TTL 缓存，避免批量分析期高频磁盘写探针造成 I/O 放大 */
  private effectiveRootCache: EffectiveRootCacheEntry | null = null

  constructor(configAdapter?: CommonResourceConfigAdapter) {
    this.configAdapter = configAdapter
  }

  /**
   * 注入或重置配置适配器（仅用于测试或自定义运行时装配）
   */
  public setConfigAdapter(adapter?: CommonResourceConfigAdapter): void {
    this.configAdapter = adapter
    this.previousRootPaths = []
    this.effectiveRootCache = null
  }

  /**
   * 主动失效根目录探测缓存（目录切换或写入失败时调用）
   */
  public invalidateRootCache(): void {
    this.effectiveRootCache = null
  }

  /**
   * 安全读取配置项
   */
  private readConfigValue(key: CommonResourceConfigKey): string {
    try {
      if (this.configAdapter) {
        const val = this.configAdapter.getValue<string>(key)
        return typeof val === 'string' ? val.trim() : ''
      }
      const orchestrator = ConfigOrchestrator.getInstance()
      const val = orchestrator?.getValue<string>(key)
      return typeof val === 'string' ? val.trim() : ''
    } catch {
      return ''
    }
  }

  /**
   * 安全写入配置项
   */
  private async writeConfigValue(
    key: 'COMMON_RESOURCE_PATH' | 'PREVIOUS_COMMON_RESOURCE_PATH',
    targetPath: string
  ): Promise<void> {
    if (this.configAdapter) {
      await this.configAdapter.updateValue(key, targetPath)
      return
    }
    const orchestrator = ConfigOrchestrator.getInstance()
    await orchestrator.updateValue(key, targetPath)
  }

  /**
   * 获取系统默认公共资源根目录：<userData>/resources
   */
  public getDefaultRootPath(): string {
    try {
      if (app && typeof app.getPath === 'function') {
        const userData = app.getPath('userData')
        if (userData) {
          return path.join(userData, 'resources')
        }
      }
    } catch {
      // 非 Electron 运行时或 app 尚未就绪时降级
    }
    return path.join(process.cwd(), '.firefly-user-data', 'resources')
  }

  /**
   * 获取降级临时公共资源根目录：<TEMP_PATH>/resources
   */
  public getFallbackTempRootPath(): string {
    const configuredTemp = this.readConfigValue('TEMP_PATH')
    if (configuredTemp) {
      return path.join(configuredTemp, 'resources')
    }
    try {
      if (app && typeof app.getPath === 'function') {
        const electronTemp = app.getPath('temp')
        if (electronTemp) {
          return path.join(electronTemp, 'firefly-temp', 'resources')
        }
      }
    } catch {
      // 忽略异常回退到 os.tmpdir
    }
    return path.join(os.tmpdir(), 'firefly-temp', 'resources')
  }

  /**
   * 获取当前配置的目标根目录（未配置时返回默认路径）
   */
  public getConfiguredRootPath(): string {
    const configured = this.readConfigValue('COMMON_RESOURCE_PATH')
    if (configured) {
      return path.resolve(configured)
    }
    return this.getDefaultRootPath()
  }

  /**
   * 记录历史目录（去重，供切换目录后懒加载复用）
   */
  private rememberPreviousRootPath(oldPath: string): void {
    if (!oldPath) return
    const resolved = path.resolve(oldPath)
    if (!this.previousRootPaths.some(p => isPathEqual(p, resolved))) {
      this.previousRootPaths.unshift(resolved)
    }
  }

  /**
   * 对目标目录执行真实写入探针 (Write Probe)
   */
  public async probeWritable(dirPath: string): Promise<{ writable: boolean; error?: string }> {
    const trimmed = String(dirPath || '').trim()
    if (!trimmed) {
      return { writable: false, error: t('目录路径不能为空') }
    }
    if (!path.isAbsolute(trimmed)) {
      return { writable: false, error: t('目录路径必须是绝对路径') }
    }

    const resolved = path.resolve(trimmed)
    const probeFile = path.join(
      resolved,
      `.firefly-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    )

    try {
      await ensureDirSafe(resolved)
      await fsPromises.writeFile(probeFile, 'ok', 'utf8')
      await fsPromises.unlink(probeFile).catch(() => {})
      return { writable: true }
    } catch (error: any) {
      await fsPromises.unlink(probeFile).catch(() => {})
      return {
        writable: false,
        error: error?.message || String(error)
      }
    }
  }

  /**
   * 确保根目录及标准子目录骨架（thumbnails / audio_synthesis）存在
   */
  public async ensureRootSkeleton(rootPath: string): Promise<void> {
    await ensureDirSafe(rootPath)
    await ensureDirSafe(path.join(rootPath, COMMON_THUMBNAILS_DIR_NAME))
    await ensureDirSafe(path.join(rootPath, COMMON_AUDIO_SYNTHESIS_DIR_NAME))
  }

  /**
   * 解析并确保当前实际生效的公共资源根目录：
   * - 带 30s 短 TTL 缓存，避免批量分析期高频执行磁盘写探针；
   * - 若用户配置的目录离线/不可写，显式告警并自动优雅降级至 TEMP_PATH/resources
   */
  public async resolveEffectiveRootPath(options?: {
    bypassCache?: boolean
  }): Promise<CommonResourceRootResolution> {
    const configured = this.getConfiguredRootPath()
    const now = Date.now()

    if (
      !options?.bypassCache &&
      this.effectiveRootCache &&
      this.effectiveRootCache.expiresAt > now &&
      isPathEqual(this.effectiveRootCache.configuredRoot, configured)
    ) {
      return this.effectiveRootCache.result
    }

    const probe = await this.probeWritable(configured)

    if (probe.writable) {
      await this.ensureRootSkeleton(configured)
      const result: CommonResourceRootResolution = { rootPath: configured, isFallback: false }
      this.effectiveRootCache = {
        configuredRoot: configured,
        result,
        expiresAt: now + EFFECTIVE_ROOT_CACHE_TTL_MS
      }
      return result
    }

    const fallbackRoot = this.getFallbackTempRootPath()
    logger.warn(
      LogCategory.FILE_PROCESSOR,
      `[公共资源路径] 配置目录不可写或离线 (${configured}: ${probe.error || 'unknown'})，已优雅降级至临时目录: ${fallbackRoot}`
    )

    const fallbackProbe = await this.probeWritable(fallbackRoot)
    if (fallbackProbe.writable) {
      await this.ensureRootSkeleton(fallbackRoot)
      const result: CommonResourceRootResolution = {
        rootPath: fallbackRoot,
        isFallback: true,
        fallbackReason: probe.error || t('所选目录不可写入，请更换其他目录')
      }
      this.effectiveRootCache = {
        configuredRoot: configured,
        result,
        expiresAt: now + EFFECTIVE_ROOT_CACHE_TTL_MS
      }
      return result
    }

    const osTmpFallback = path.join(os.tmpdir(), 'firefly-resources')
    logger.warn(
      LogCategory.FILE_PROCESSOR,
      `[公共资源路径] TEMP_PATH 同样不可写 (${fallbackRoot}: ${fallbackProbe.error || 'unknown'})，最终降级至系统临时目录: ${osTmpFallback}`
    )
    await this.ensureRootSkeleton(osTmpFallback)
    const result: CommonResourceRootResolution = {
      rootPath: osTmpFallback,
      isFallback: true,
      fallbackReason: probe.error || t('所选目录不可写入，请更换其他目录')
    }
    this.effectiveRootCache = {
      configuredRoot: configured,
      result,
      expiresAt: now + EFFECTIVE_ROOT_CACHE_TTL_MS
    }
    return result
  }

  /**
   * 计算缩略图二级分桶 CAS 路径：<rootPath>/thumbnails/<ab>/<fingerprint>.webp
   */
  public getThumbnailPath(fileFingerprint: string, rootPath?: string): string {
    const baseRoot = rootPath ? path.resolve(rootPath) : this.getConfiguredRootPath()
    const safeFp = sanitizeCasSegment(fileFingerprint, 'unknown')
    const bucket = safeFp.length >= 2 ? safeFp.slice(0, 2).toLowerCase() : '00'
    return path.join(baseRoot, COMMON_THUMBNAILS_DIR_NAME, bucket, `${safeFp}.webp`)
  }

  /**
   * 确保缩略图二级分桶目录存在并返回目标写入绝对路径
   */
  public async ensureThumbnailPath(fileFingerprint: string): Promise<{
    absolutePath: string
    bucketDir: string
    rootPath: string
    isFallback: boolean
  }> {
    const resolved = await this.resolveEffectiveRootPath()
    const absolutePath = this.getThumbnailPath(fileFingerprint, resolved.rootPath)
    const bucketDir = path.dirname(absolutePath)
    await ensureDirSafe(bucketDir)
    return {
      absolutePath,
      bucketDir,
      rootPath: resolved.rootPath,
      isFallback: resolved.isFallback
    }
  }

  /**
   * 查找已存在的缩略图（优先级：当前生效 CAS > 历史 CAS 目录懒复用（含跨重启持久化目录） > 旧工作区 .VirtualDirectory/.thumbnail 懒兼容）
   */
  public async findExistingThumbnail(
    fileFingerprint: string,
    legacyWorkspaceDirPath?: string
  ): Promise<{
    exists: boolean
    absolutePath: string
    source: 'cas' | 'previous_cas' | 'legacy_workspace' | 'none'
  }> {
    const safeFp = sanitizeCasSegment(fileFingerprint, 'unknown')
    const configuredRoot = this.getConfiguredRootPath()
    const currentCasPath = this.getThumbnailPath(safeFp, configuredRoot)

    try {
      await fsPromises.access(currentCasPath)
      return { exists: true, absolutePath: currentCasPath, source: 'cas' }
    } catch {
      // 未命中当前目录，继续按优先级查找
    }

    // 切换目录后的历史目录（内存 + 持久化 PREVIOUS_COMMON_RESOURCE_PATH + 默认目录 + 降级临时目录）懒复用
    for (const prevRoot of this.getLazyReadFallbackRoots(configuredRoot)) {
      const prevPath = this.getThumbnailPath(safeFp, prevRoot)
      try {
        await fsPromises.access(prevPath)
        return { exists: true, absolutePath: prevPath, source: 'previous_cas' }
      } catch {
        // 未命中
      }
    }

    // 兼容旧版工作区 .VirtualDirectory/.thumbnail/<fp>.webp（只读懒兼容）
    if (legacyWorkspaceDirPath) {
      const legacyPath = path.join(
        legacyWorkspaceDirPath,
        LEGACY_VIRTUAL_DIRECTORY_FOLDER,
        LEGACY_THUMBNAIL_FOLDER,
        `${safeFp}.webp`
      )
      try {
        await fsPromises.access(legacyPath)
        return { exists: true, absolutePath: legacyPath, source: 'legacy_workspace' }
      } catch {
        // 未命中
      }
    }

    return { exists: false, absolutePath: currentCasPath, source: 'none' }
  }

  /**
   * 获取语音合成音频根目录：<rootPath>/audio_synthesis
   */
  public getAudioSynthesisRoot(rootPath?: string): string {
    const baseRoot = rootPath ? path.resolve(rootPath) : this.getConfiguredRootPath()
    return path.join(baseRoot, COMMON_AUDIO_SYNTHESIS_DIR_NAME)
  }

  /**
   * 获取单文件语音合成 CAS 整音频路径：
   * <rootPath>/audio_synthesis/<fingerprint>/<voiceId>_<speedFixed2>.wav
   */
  public getAudioWavPath(params: {
    fingerprint: string
    voiceId: string | number
    speed?: number
    rootPath?: string
  }): string {
    const safeFp = sanitizeCasSegment(params.fingerprint, 'unknown')
    const safeVoice = sanitizeCasSegment(String(params.voiceId ?? 'voice'), 'voice')
    const speedFixed2 = formatSpeedFixed2(params.speed)
    return path.join(
      this.getAudioSynthesisRoot(params.rootPath),
      safeFp,
      `${safeVoice}_${speedFixed2}.wav`
    )
  }

  /**
   * 获取语音合成分片目录路径：
   * <rootPath>/audio_synthesis/<fingerprint>/<voiceId>_<speedFixed2>/chunks
   */
  public getAudioChunksDir(params: {
    fingerprint: string
    voiceId: string | number
    speed?: number
    rootPath?: string
  }): string {
    const safeFp = sanitizeCasSegment(params.fingerprint, 'unknown')
    const safeVoice = sanitizeCasSegment(String(params.voiceId ?? 'voice'), 'voice')
    const speedFixed2 = formatSpeedFixed2(params.speed)
    return path.join(
      this.getAudioSynthesisRoot(params.rootPath),
      safeFp,
      `${safeVoice}_${speedFixed2}`,
      'chunks'
    )
  }

  /**
   * 确保语音合成目标文件目录存在
   */
  public async ensureAudioSynthesisDir(fingerprint: string): Promise<{
    dirPath: string
    rootPath: string
    isFallback: boolean
  }> {
    const resolved = await this.resolveEffectiveRootPath()
    const safeFp = sanitizeCasSegment(fingerprint, 'unknown')
    const dirPath = path.join(resolved.rootPath, COMMON_AUDIO_SYNTHESIS_DIR_NAME, safeFp)
    await ensureDirSafe(dirPath)
    return {
      dirPath,
      rootPath: resolved.rootPath,
      isFallback: resolved.isFallback
    }
  }

  /**
   * 获取可用于只读懒加载复用的候选历史根目录列表（不含当前配置目录）
   * 覆盖：本次进程内历史目录、持久化 PREVIOUS_COMMON_RESOURCE_PATH、系统默认目录、降级临时目录
   */
  public getLazyReadFallbackRoots(currentRoot: string): string[] {
    const candidates: string[] = []
    const pushUnique = (dir: string) => {
      if (!dir) return
      const resolved = path.resolve(dir)
      if (isPathEqual(resolved, currentRoot)) return
      if (!candidates.some(c => isPathEqual(c, resolved))) {
        candidates.push(resolved)
      }
    }

    for (const prev of this.previousRootPaths) {
      pushUnique(prev)
    }
    const persistedPrevious = this.readConfigValue('PREVIOUS_COMMON_RESOURCE_PATH')
    if (persistedPrevious) {
      pushUnique(persistedPrevious)
    }
    pushUnique(this.getDefaultRootPath())
    pushUnique(this.getFallbackTempRootPath())
    return candidates
  }

  /**
   * 获取旧工作区 TTS 目录路径（仅用于旧缓存只读懒兼容）
   */
  public getLegacyWorkspaceTtsDir(workspaceDirectoryPath: string): string {
    return path.join(workspaceDirectoryPath, LEGACY_VIRTUAL_DIRECTORY_FOLDER, LEGACY_TTS_FOLDER)
  }

  /**
   * 更新用户自定义的公共资源保存目录（执行 Write Probe 并建立目录骨架）
   */
  public async updateCommonResourcePath(
    targetDir: string
  ): Promise<CommonResourcePathUpdateResult> {
    const trimmed = String(targetDir || '').trim()
    const probe = await this.probeWritable(trimmed)
    if (!probe.writable) {
      return {
        success: false,
        error: probe.error || t('所选目录不可写入，请更换其他目录')
      }
    }

    const resolvedTarget = path.resolve(trimmed)
    const previousPath = this.getConfiguredRootPath()

    try {
      await this.ensureRootSkeleton(resolvedTarget)
      if (!isPathEqual(previousPath, resolvedTarget)) {
        this.rememberPreviousRootPath(previousPath)
        await this.writeConfigValue('PREVIOUS_COMMON_RESOURCE_PATH', previousPath)
      }
      await this.writeConfigValue('COMMON_RESOURCE_PATH', resolvedTarget)
      this.invalidateRootCache()
      logger.info(
        LogCategory.SETTING,
        `[公共资源路径] 已更新全局缓存保存目录: ${previousPath} -> ${resolvedTarget}`
      )
      return {
        success: true,
        path: resolvedTarget,
        previousPath
      }
    } catch (error: any) {
      logger.error(LogCategory.SETTING, '[公共资源路径] 更新保存目录失败:', error)
      return {
        success: false,
        error: error?.message || t('更新缓存目录失败，请稍后重试')
      }
    }
  }

  /**
   * 重置公共资源目录为默认路径 (userData/resources)
   */
  public async resetCommonResourcePath(): Promise<CommonResourcePathUpdateResult> {
    const defaultRoot = this.getDefaultRootPath()
    return this.updateCommonResourcePath(defaultRoot)
  }

  /**
   * 获取公共资源目录状态信息（供设置页面展示，跳过缓存实时探测以反映最新磁盘状态）
   */
  public async getResourceDirInfo(): Promise<CommonResourceDirInfo> {
    const defaultPath = this.getDefaultRootPath()
    const configuredPath = this.getConfiguredRootPath()
    const effective = await this.resolveEffectiveRootPath({ bypassCache: true })
    const isCustom = !isPathEqual(configuredPath, defaultPath)

    return {
      currentPath: effective.rootPath,
      configuredPath,
      defaultPath,
      isCustom,
      isFallback: effective.isFallback,
      fallbackReason: effective.fallbackReason,
      thumbnailsDir: path.join(effective.rootPath, COMMON_THUMBNAILS_DIR_NAME),
      audioSynthesisDir: path.join(effective.rootPath, COMMON_AUDIO_SYNTHESIS_DIR_NAME)
    }
  }
}

export const commonResourcePathService = new CommonResourcePathService()
