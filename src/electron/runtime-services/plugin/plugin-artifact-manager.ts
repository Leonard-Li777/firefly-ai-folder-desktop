/**
 * 插件产物安全管理与持久化中继服务 (PluginArtifactManager)
 *
 * 遵循规格：plugin-runtime-sandbox-and-omni-seams-spec.md §3.1 与 §3.2
 * 职责：
 * 1. 两阶段 Staging/Commit 严格隔离与路径逃逸防御
 * 2. 产物魔数（WebP RIFF..WEBP）与截断完整性校验
 * 3. 同卷 rename 原子提交 + 跨卷 EXDEV 降级
 * 4. 启动清扫 (Startup Sweep)
 * 5. 数据库引用孤儿 GC 与基于 last_accessed_at 的 2GB 配额 LRU 淘汰 + 反向解绑回调
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { isSubPath } from '@firefly/shared'
import {
  ArtifactSecurityError,
  ArtifactValidationError,
  CommitArtifactOptions,
  GcResult,
  OrphanGcOptions,
  ReferenceCheckResult
} from './plugin-types'

export interface PluginArtifactManagerOptions {
  /** 基础缓存目录路径（默认由外部传入或配置） */
  baseCacheDir: string
  /** 自定义日志记录器 */
  logger?: {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }
}

const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_\-\.]+$/
const MAX_SAFE_JSON_BYTES = 10 * 1024 * 1024 // 10MB 保护上限

export class PluginArtifactManager {
  public readonly baseCacheDir: string
  public readonly stagingDir: string
  public readonly artifactsDir: string
  public readonly thumbsDir: string

  private readonly logger: {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }

  constructor(options: PluginArtifactManagerOptions) {
    this.baseCacheDir = options.baseCacheDir
    this.stagingDir = path.join(this.baseCacheDir, 'staging')
    this.artifactsDir = path.join(this.baseCacheDir, 'artifacts')
    this.thumbsDir = path.join(this.artifactsDir, 'thumbs')
    this.logger = options.logger ?? console
  }

  /**
   * 初始化目录结构
   */
  public async initialize(): Promise<void> {
    await fs.mkdir(this.stagingDir, { recursive: true })
    await fs.mkdir(this.thumbsDir, { recursive: true })
  }

  /**
   * 为指定任务分配专属的暂存目录
   * 目录格式：<cache>\staging\<taskId>_<attempt>\
   */
  public async allocateStagingDir(taskId: string, attempt: number = 1): Promise<string> {
    const taskDir = path.join(this.stagingDir, `${taskId}_${attempt}`)
    await fs.mkdir(taskDir, { recursive: true })
    return taskDir
  }

  /**
   * 物理递归清理指定任务的专属暂存目录（宿主 100% 负责，无论成功还是崩溃）
   */
  public async cleanupStagingDir(taskId: string, attempt: number = 1): Promise<void> {
    const taskDir = path.join(this.stagingDir, `${taskId}_${attempt}`)
    try {
      await fs.rm(taskDir, { recursive: true, force: true })
    } catch (err: any) {
      this.logger.warn(`[PluginArtifactManager] Failed to cleanup staging dir ${taskDir}:`, err)
    }
  }

  /**
   * 两阶段提交：安全校验并原子移动产物至持久化资产区
   */
  public async commitArtifact(options: CommitArtifactOptions): Promise<string> {
    const {
      taskId,
      attempt = 1,
      relativePath,
      fileFingerprint,
      pluginVersion,
      viewName,
      targetExtension,
      expectedMagic
    } = options

    const taskDir = path.join(this.stagingDir, `${taskId}_${attempt}`)

    // 1. 严格输入路径防御：严禁绝对路径、'.' 或包含 '..' 试图逃逸
    const trimmedPath = relativePath.trim()
    if (
      !trimmedPath ||
      trimmedPath === '.' ||
      path.isAbsolute(trimmedPath) ||
      trimmedPath.includes('..')
    ) {
      throw new ArtifactSecurityError(
        `Path traversal detected or invalid relative path: ${relativePath}`
      )
    }

    // 2. 目标元数据防逃逸断言 (SEC-01)
    if (
      !SAFE_IDENTIFIER_REGEX.test(viewName) ||
      !SAFE_IDENTIFIER_REGEX.test(pluginVersion) ||
      !SAFE_IDENTIFIER_REGEX.test(fileFingerprint)
    ) {
      throw new ArtifactSecurityError(
        `Invalid character in target artifact identifiers: viewName=${viewName}, pluginVersion=${pluginVersion}`
      )
    }

    const candidatePath = path.resolve(taskDir, trimmedPath)

    // 检查源文件物理存在性与常规文件属性 (SEC-03)
    let stat: import('node:fs').Stats
    try {
      stat = await fs.stat(candidatePath)
    } catch {
      throw new ArtifactValidationError(`Artifact file not found: ${candidatePath}`)
    }

    if (!stat.isFile()) {
      throw new ArtifactValidationError(
        `Artifact must be a regular file, not a directory: ${relativePath}`
      )
    }

    // 通过 realpath 获取真实物理路径（防御符号链接逃逸）
    const realTaskDir = await fs.realpath(taskDir)
    const realSourcePath = await fs.realpath(candidatePath)

    if (!isSubPath(realTaskDir, realSourcePath)) {
      throw new ArtifactSecurityError(
        `Artifact realpath ${realSourcePath} escaped staging directory ${realTaskDir}`
      )
    }

    // 检查文件尺寸
    if (stat.size === 0) {
      await fs.unlink(realSourcePath).catch(() => {})
      throw new ArtifactValidationError(`Artifact file is empty (0 bytes): ${relativePath}`)
    }

    // 3. 校验文件完整性与魔数 (SEC-02 & RES-01)
    const ext = (targetExtension || path.extname(relativePath) || '').toLowerCase()
    const shouldCheckWebP = expectedMagic === 'webp' || (!expectedMagic && ext === '.webp')
    const shouldCheckJson = expectedMagic === 'json' || (!expectedMagic && ext === '.json')

    try {
      if (shouldCheckWebP) {
        await this.validateWebPMagic(realSourcePath, stat.size)
      } else if (shouldCheckJson) {
        await this.validateJsonFormat(realSourcePath, stat.size)
      }
    } catch (valErr) {
      // 校验失败，物理删除损坏的源文件，避免残留
      await fs.unlink(realSourcePath).catch(() => {})
      throw valErr
    }

    // 4. 计算目标持久化路径与二次越界阻断
    // 命名格式：<cache>\artifacts\thumbs\<fileFingerprint>_<pluginVersion>_<viewName>.webp
    const outExt = ext || '.webp'
    const targetFileName = `${fileFingerprint}_${pluginVersion}_${viewName}${outExt}`
    const targetPath = path.join(this.thumbsDir, targetFileName)

    if (!isSubPath(this.thumbsDir, targetPath)) {
      throw new ArtifactSecurityError(
        `Target artifact path escaped thumbs directory: ${targetPath}`
      )
    }

    await fs.mkdir(this.thumbsDir, { recursive: true })

    // 5. 原子迁移（优先 fs.rename，跨卷 EXDEV 降级为 copyFile + unlink 并做失败清理）
    try {
      await fs.rename(realSourcePath, targetPath)
    } catch (err: any) {
      if (err.code === 'EXDEV') {
        this.logger.warn(
          `[PluginArtifactManager] EXDEV detected across drives, falling back to copyFile + unlink`
        )
        try {
          await fs.copyFile(realSourcePath, targetPath)
          await fs.unlink(realSourcePath).catch(() => {})
        } catch (copyErr) {
          // 降级失败时清理半截残片 (REL-01)
          await fs.unlink(targetPath).catch(() => {})
          throw copyErr
        }
      } else {
        throw err
      }
    }

    return targetPath
  }

  /**
   * 启动清扫 (Startup Sweep)：物理清空整个 staging 目录
   * 零在途任务跨重启存活
   */
  public async sweepStagingDir(): Promise<{ clearedCount: number; errors: any[] }> {
    let clearedCount = 0
    const errors: any[] = []

    try {
      await fs.mkdir(this.stagingDir, { recursive: true })
      const entries = await fs.readdir(this.stagingDir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(this.stagingDir, entry.name)
        try {
          await fs.rm(fullPath, { recursive: true, force: true })
          clearedCount++
        } catch (err: any) {
          errors.push({ path: fullPath, error: err })
          this.logger.warn(`[PluginArtifactManager] Failed to sweep ${fullPath}:`, err)
        }
      }
    } catch (err: any) {
      errors.push({ path: this.stagingDir, error: err })
      this.logger.error(`[PluginArtifactManager] Fatal error during staging sweep:`, err)
    }

    return { clearedCount, errors }
  }

  /**
   * 以数据库引用为准的孤儿 GC 与基于 files.last_accessed_at 的 2GB 配额 LRU 淘汰
   */
  public async runOrphanGc(options: OrphanGcOptions): Promise<GcResult> {
    const {
      isReferenced,
      onEvicted,
      maxTotalBytes = 2 * 1024 * 1024 * 1024, // 默认 2GB
      now = Date.now()
    } = options

    const result: GcResult = {
      deletedOrphans: 0,
      deletedLru: 0,
      totalFreedBytes: 0,
      lockedFilesSkipped: 0,
      errors: []
    }

    try {
      await fs.mkdir(this.thumbsDir, { recursive: true })
    } catch {
      return result
    }

    const entries = await fs.readdir(this.thumbsDir, { withFileTypes: true })
    const validFiles: Array<{ name: string; fullPath: string; size: number; accessTime: number }> =
      []

    // 1. 第一步：孤儿文件清理（未被 SQLite 引用）
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fileName = entry.name
      const fullPath = path.join(this.thumbsDir, fileName)

      let isRef = false
      let dbAccessTime: number | undefined

      try {
        const check = await isReferenced(fileName)
        if (typeof check === 'boolean') {
          isRef = check
        } else if (check && typeof check === 'object') {
          isRef = check.referenced
          dbAccessTime = check.lastAccessedAt
        }
      } catch (refErr: any) {
        result.errors.push({ file: fileName, error: refErr })
        continue
      }

      if (!isRef) {
        // 未被数据库引用，执行删除
        try {
          const stat = await fs.stat(fullPath)
          await fs.unlink(fullPath)
          result.deletedOrphans++
          result.totalFreedBytes += stat.size
        } catch (unlinkErr: any) {
          if (unlinkErr.code === 'EBUSY' || unlinkErr.code === 'EPERM') {
            // Windows 句柄锁静默留存至下一轮
            result.lockedFilesSkipped++
          } else {
            result.errors.push({ file: fileName, error: unlinkErr })
          }
        }
      } else {
        // 有效引用，记录统计与业务访问时间戳 (ARC-01: 优先采纳数据库业务时间)
        try {
          const stat = await fs.stat(fullPath)
          const accessTime = dbAccessTime ?? stat.atimeMs ?? stat.mtimeMs ?? now
          validFiles.push({
            name: fileName,
            fullPath,
            size: stat.size,
            accessTime
          })
        } catch (statErr: any) {
          result.errors.push({ file: fileName, error: statErr })
        }
      }
    }

    // 2. 第二步：全局配额检查与基于 accessTime 的 LRU 淘汰
    let currentTotalBytes = validFiles.reduce((sum, f) => sum + f.size, 0)
    if (currentTotalBytes > maxTotalBytes) {
      // 按最旧访问时间升序排序（最久未访问者优先淘汰）
      validFiles.sort((a, b) => a.accessTime - b.accessTime)

      for (const file of validFiles) {
        if (currentTotalBytes <= maxTotalBytes) {
          break
        }

        try {
          await fs.unlink(file.fullPath)
          result.deletedLru++
          result.totalFreedBytes += file.size
          currentTotalBytes -= file.size

          // 触发反向解绑回调，通知主库置空对应引用 (ARC-01 防悬空死链)
          if (onEvicted) {
            try {
              await onEvicted(file.name)
            } catch (evictErr: any) {
              this.logger.warn(
                `[PluginArtifactManager] onEvicted callback error for ${file.name}:`,
                evictErr
              )
            }
          }
        } catch (unlinkErr: any) {
          if (unlinkErr.code === 'EBUSY' || unlinkErr.code === 'EPERM') {
            result.lockedFilesSkipped++
          } else {
            result.errors.push({ file: file.name, error: unlinkErr })
          }
        }
      }
    }

    return result
  }

  /**
   * 校验 WebP 文件头魔数与声明体积截断 (RIFF....WEBP) (SEC-02)
   */
  private async validateWebPMagic(filePath: string, physicalSize: number): Promise<void> {
    if (physicalSize < 12) {
      throw new ArtifactValidationError(`WebP file is too short (<12 bytes)`)
    }

    const handle = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(12)
      const { bytesRead } = await handle.read(buffer, 0, 12, 0)
      if (bytesRead < 12) {
        throw new ArtifactValidationError(`Failed to read WebP header`)
      }

      // 检查 'RIFF' (0..3)
      const riff = buffer.toString('ascii', 0, 4)
      // 检查 'WEBP' (8..11)
      const webp = buffer.toString('ascii', 8, 12)

      if (riff !== 'RIFF' || webp !== 'WEBP') {
        throw new ArtifactValidationError(
          `Invalid WebP magic signature: expected RIFF....WEBP, got ${riff}....${webp}`
        )
      }

      // 检查 RIFF 声明体积与真实物理体积，防御半截截断损坏文件入库
      const riffPayloadSize = buffer.readUInt32LE(4)
      const expectedMinSize = riffPayloadSize + 8
      if (physicalSize < expectedMinSize) {
        throw new ArtifactValidationError(
          `WebP file truncated: declared ${expectedMinSize} bytes in RIFF header, but actual file size is only ${physicalSize} bytes`
        )
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * 校验 JSON 产物合法性与体积上限防御 (RES-01)
   */
  private async validateJsonFormat(filePath: string, physicalSize: number): Promise<void> {
    if (physicalSize > MAX_SAFE_JSON_BYTES) {
      throw new ArtifactValidationError(
        `JSON artifact exceeds maximum safe size limit (${MAX_SAFE_JSON_BYTES} bytes): got ${physicalSize} bytes`
      )
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8')
      JSON.parse(content)
    } catch (err: any) {
      throw new ArtifactValidationError(`Invalid JSON content: ${err.message}`)
    }
  }
}
