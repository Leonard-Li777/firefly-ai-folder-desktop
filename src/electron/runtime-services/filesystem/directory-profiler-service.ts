/**
 * 主进程目录探测与场景画像服务 (Directory Profiler Service)
 *
 * 核心目标：
 * 1. 非阻塞快速嗅探：限定 Max Depth = 2，硬退出条件 (300 文件或 60ms 时间盒)；
 * 2. 扩充黑名单目录阻断：避免深入 node_modules、.git、target 等超大工程目录；
 * 3. 优先级正确的置信度数学判据：绝对多数类（图片>=60%、文档>=50%）优先，消除视频低门槛抢占问题；
 * 4. 悲观防穿透与 I/O 硬超时：遭遇空目录、权限拒绝、网络盘断链时安全返回 partial 结果或 confidence: 0，杜绝拖死主进程。
 */

import * as fs from 'fs'
import * as path from 'path'
import type { WorkspaceConfigIntent, SampledFileStemCount } from '@firefly/types'
import {
  LogCategory,
  logger,
  extensionFromFileName,
  getFileCategory,
  FileCategory,
  SHORTCUT_LINK_EXTENSIONS
} from '@firefly/shared'

/**
 * 常见黑名单目录名称 (小写比较，无条件跳过)
 * [RV-05] 补充 Monorepo 大型工程缓存：target-runs（Rust 热编译缓存）、
 * .worktrees（Git 多 worktree 根目录）、dist-electron（Electron 构建产物）
 */
export const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '$recycle.bin',
  'system volume information',
  '__pycache__',
  '.venv',
  'venv',
  '.cargo',
  'target',
  'target-runs',
  'dist',
  'dist-electron',
  'build',
  'out',
  '.next',
  '.nuxt',
  'pods',
  '.idea',
  '.vscode',
  '.trash',
  '.ds_store',
  '.worktrees'
])

/**
 * 文档与文本类扩展名
 */
export const DOCUMENT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'json',
  'xml',
  'html',
  'htm',
  'epub',
  'mobi',
  'chm',
  'rtf',
  'log',
  'tex',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'go',
  'rb',
  'php',
  'sql',
  'sh',
  'bash',
  'ps1',
  'bat',
  'cmd',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env'
])

/**
 * 图片与视觉类扩展名
 */
export const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'tiff',
  'tif',
  'heic',
  'heif',
  'avif',
  'raw',
  'cr2',
  'nef',
  'arw',
  'dng',
  'psd',
  'ai',
  'eps',
  'sketch',
  'xd',
  'fig'
])

/**
 * 视频与影视类扩展名
 */
export const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mkv',
  'mov',
  'avi',
  'wmv',
  'flv',
  'webm',
  'm4v',
  'rmvb',
  'rm',
  '3gp',
  'ts',
  'mpg',
  'mpeg',
  'vob',
  'm2ts',
  'mts'
])

/**
 * 安装包与可执行程序类扩展名
 */
export const INSTALLER_EXTENSIONS = new Set([
  'exe',
  'msi',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'apk',
  'appx',
  'msix'
])

/**
 * 压缩与归档包类扩展名
 */
export const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'zst',
  'tgz',
  'iso',
  'cab'
])

/**
 * 快捷方式与链接类扩展名 (统一源自 file-extension-policies.json SSOT)
 */
export const SHORTCUT_EXTENSIONS = new Set(
  Array.from(SHORTCUT_LINK_EXTENSIONS).map(e => e.replace(/^\./, ''))
)

/**
 * 音频与音乐类扩展名
 */
export const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'flac',
  'aac',
  'ogg',
  'm4a',
  'ape',
  'wma',
  'opus',
  'dsf',
  'dff'
])

/**
 * 探测统计结果
 */
export interface DirectoryProfileStats {
  totalSampled: number
  docCount: number
  imageCount: number
  videoCount: number
  otherCount: number
  installerCount?: number
  executableCount?: number
  archiveCount?: number
  shortcutCount?: number
  audioCount?: number
  codeCount?: number
  countsByExt?: Record<string, number>
  categoryCounts?: Record<string, number>
  topExtensions: Array<{ ext: string; count: number }>
  sampledFileNames?: SampledFileStemCount[]
  durationMs: number
  hitTimeBudget: boolean
}

/**
 * 画像推断输出结果
 */
export interface DirectoryProfileResult {
  detectedIntent: WorkspaceConfigIntent
  confidence: number // 0.0 ~ 1.0
  stats: DirectoryProfileStats
}

/**
 * 纯算法探测器 (DirectoryProfiler)
 */
export class DirectoryProfiler {
  private readonly maxDepth: number
  private readonly maxFiles: number
  private readonly timeBudgetMs: number

  constructor(options?: { maxDepth?: number; maxFiles?: number; timeBudgetMs?: number }) {
    this.maxDepth = options?.maxDepth ?? 2
    this.maxFiles = options?.maxFiles ?? 300
    this.timeBudgetMs = options?.timeBudgetMs ?? 60
  }

  /**
   * 清洗文件名并提取标准化词干 (Spec §2.3.2)
   * 剥离：① 日期/时间戳；② UUID/长十六进制串；③ 副本括号与末尾连续数字序号；截断 24 字符
   */
  private cleanFileNameStem(rawStem: string): string | null {
    if (!rawStem || typeof rawStem !== 'string') return null
    let s = rawStem.trim()
    if (!s) return null

    // 剥离两端常见括号与中英文标点
    s = s.replace(/^[\s\[\]()（）【】_.-]+|[\s\[\]()（）【】_.-]+$/g, '')
    if (!s) return null

    // 剥离日期前缀或后缀 (如 2026-11-12, 20261112_ 等)
    s = s.replace(/^(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])[\s_-]*/i, '')
    s = s.replace(/[\s_-]*(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])$/i, '')

    // 剥离 UUID 或 长十六进制串
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    s = s.replace(/[0-9a-f]{16,64}/gi, '')

    // 剥离副本括号与末尾序号 (如 (1), [2], _01, -副本)，采用无嵌套正则规避 ReDoS
    while (/[\s_-]*(?:副本|\(\d{1,4}\)|\[\d{1,4}\])$/i.test(s)) {
      s = s.replace(/[\s_-]*(?:副本|\(\d{1,4}\)|\[\d{1,4}\])$/i, '')
    }
    s = s.replace(/[\s_-]+\d{1,4}$/g, '')

    // 再次剥离边缘标点
    s = s.replace(/^[\s\[\]()（）【】_.-]+|[\s\[\]()（）【】_.-]+$/g, '')

    // 过滤纯符号或长度 < 2 的碎片
    if (s.length < 2) return null
    if (!/[a-zA-Z0-9\u4e00-\u9fa5]/.test(s)) return null

    return s.slice(0, 24)
  }

  /**
   * 异步广度优先遍历嗅探目录扩展名分布 (带硬超时竞速防护)
   */
  async profileDirectory(targetPath: string): Promise<DirectoryProfileResult> {
    const startTime = Date.now()
    const extensionCounts = new Map<string, number>()
    const rawStemFrequency = new Map<string, number>()

    let docCount = 0
    let imageCount = 0
    let videoCount = 0
    let audioCount = 0
    let archiveCount = 0
    let codeCount = 0
    let executableCount = 0
    let shortcutCount = 0
    let otherCount = 0
    let totalSampled = 0
    let hitTimeBudget = false

    // 内部实际执行遍历的异步任务
    const traverseTask = async (): Promise<void> => {
      const queue: Array<{ dirPath: string; depth: number }> = [{ dirPath: targetPath, depth: 0 }]
      let filesProcessedSinceYield = 0

      while (queue.length > 0) {
        if (totalSampled >= this.maxFiles) {
          break
        }
        if (Date.now() - startTime >= this.timeBudgetMs) {
          hitTimeBudget = true
          break
        }

        const current = queue.shift()!
        if (!current) break

        let entries: fs.Dirent[]
        try {
          entries = await fs.promises.readdir(current.dirPath, { withFileTypes: true })
        } catch {
          // 遭遇权限拒绝、文件被占用或目录不存在时安全跳过
          continue
        }

        for (const entry of entries) {
          if (totalSampled >= this.maxFiles) break
          if (Date.now() - startTime >= this.timeBudgetMs) {
            hitTimeBudget = true
            break
          }

          // 协作式调度：每处理 32 个条目让出事件循环微任务
          filesProcessedSinceYield++
          if (filesProcessedSinceYield >= 32) {
            filesProcessedSinceYield = 0
            await new Promise(r => setImmediate(r))
          }

          // 符号链接一律跳过，防止目录循环与网络映射死锁
          if (entry.isSymbolicLink()) {
            continue
          }

          if (entry.isDirectory()) {
            const dirNameLower = entry.name.toLowerCase()
            // 黑名单目录与点号隐藏目录快速排除
            if (IGNORED_DIRECTORY_NAMES.has(dirNameLower) || dirNameLower.startsWith('.')) {
              continue
            }
            // 深度未超限且队列未暴涨则推入 BFS 队列下一层
            if (current.depth < this.maxDepth && queue.length < 1000) {
              queue.push({
                dirPath: path.join(current.dirPath, entry.name),
                depth: current.depth + 1
              })
            }
          } else if (entry.isFile()) {
            const fileName = entry.name
            // 忽略隐藏文件 (如 .DS_Store, .gitignore)
            if (fileName.startsWith('.')) {
              continue
            }

            totalSampled++
            const extNoDot = extensionFromFileName(fileName, { withDot: false })
            const extWithDot = extensionFromFileName(fileName, { withDot: true })

            // 词干提取与频次统计
            const dotIdx = extWithDot ? fileName.toLowerCase().lastIndexOf(extWithDot) : -1
            const baseStem = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName
            const cleanedStem = this.cleanFileNameStem(baseStem)
            if (cleanedStem) {
              rawStemFrequency.set(cleanedStem, (rawStemFrequency.get(cleanedStem) ?? 0) + 1)
            }

            if (extNoDot) {
              extensionCounts.set(extNoDot, (extensionCounts.get(extNoDot) ?? 0) + 1)
            }

            const category = getFileCategory(fileName)

            if (INSTALLER_EXTENSIONS.has(extNoDot)) {
              executableCount++
            } else if (category === FileCategory.IMAGE) {
              imageCount++
            } else if (category === FileCategory.VIDEO) {
              videoCount++
            } else if (category === FileCategory.AUDIO || AUDIO_EXTENSIONS.has(extNoDot)) {
              audioCount++
            } else if (category === FileCategory.CODE) {
              codeCount++
              docCount++
            } else if (
              category === FileCategory.DOCUMENT ||
              category === FileCategory.OFFICE ||
              category === FileCategory.TEXT ||
              category === FileCategory.EBOOK ||
              DOCUMENT_EXTENSIONS.has(extNoDot)
            ) {
              docCount++
            } else if (category === FileCategory.EXECUTABLE) {
              executableCount++
            } else if (category === FileCategory.ARCHIVE || ARCHIVE_EXTENSIONS.has(extNoDot)) {
              archiveCount++
            } else if (SHORTCUT_EXTENSIONS.has(extNoDot)) {
              shortcutCount++
            } else {
              otherCount++
            }
          }
        }
      }
    }

    // 建立硬超时 Timer 竞速，防止网络盘驱动层 I/O 挂死
    const timeoutPromise = new Promise<void>(resolve => {
      // 留出 10ms 调度缓冲
      setTimeout(() => {
        hitTimeBudget = true
        resolve()
      }, this.timeBudgetMs + 10)
    })

    try {
      await Promise.race([traverseTask(), timeoutPromise])
    } catch (error) {
      logger.warn(
        LogCategory.FILE_SCANNER,
        `[DirectoryProfiler] 嗅探目录发生非致命异常: ${targetPath}`,
        error
      )
    }

    const durationMs = Date.now() - startTime

    // 统计频率最高的前 5 个扩展名与完整扩展名频次字典
    const topExtensions = Array.from(extensionCounts.entries())
      .map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    const countsByExt: Record<string, number> = {}
    for (const [ext, count] of extensionCounts.entries()) {
      countsByExt[ext] = count
    }

    // 统计词干频次 Top 24
    const sampledFileNames: SampledFileStemCount[] = Array.from(rawStemFrequency.entries())
      .map(([stem, count]) => ({ stem, count }))
      .sort((a, b) => b.count - a.count || a.stem.localeCompare(b.stem))
      .slice(0, 24)

    const stats: DirectoryProfileStats = {
      totalSampled,
      docCount,
      imageCount,
      videoCount,
      otherCount,
      installerCount: executableCount, // 兼容历史 installerCount 字段
      executableCount,
      archiveCount,
      shortcutCount,
      audioCount,
      codeCount,
      countsByExt,
      categoryCounts: {
        installer: executableCount,
        executable: executableCount,
        archive: archiveCount,
        shortcut: shortcutCount,
        doc: docCount,
        code: codeCount,
        image: imageCount,
        video: videoCount,
        audio: audioCount,
        other: otherCount
      },
      topExtensions,
      sampledFileNames,
      durationMs,
      hitTimeBudget
    }

    // 执行数学判据推导
    const { detectedIntent, confidence } = this.deriveIntentFromStats(stats)

    return {
      detectedIntent,
      confidence,
      stats
    }
  }

  /**
   * 置信度与场景意图数学判据纯函数 (消灭优先级倒置)
   */
  deriveIntentFromStats(stats: DirectoryProfileStats): {
    detectedIntent: WorkspaceConfigIntent
    confidence: number
  } {
    const { totalSampled, docCount, imageCount, videoCount } = stats

    // 1. 空目录或权限拒绝
    if (totalSampled === 0) {
      return { detectedIntent: 'fast_archive', confidence: 0 }
    }

    const docRatio = docCount / totalSampled
    const imageRatio = imageCount / totalSampled
    const videoRatio = videoCount / totalSampled

    // 2. 绝对多数派优先判定：视觉图库意图 (图片 >= 60%)
    if (imageRatio >= 0.6) {
      return { detectedIntent: 'visual_gallery', confidence: 0.9 }
    }

    // 3. 绝对多数派优先判定：文档文献意图 (文档/代码 >= 50%)
    if (docRatio >= 0.5) {
      return { detectedIntent: 'fast_archive', confidence: 0.9 }
    }

    // 4. 视频次要优势意图 (在无绝对多数派时，视频 >= 25% 裁决为影视素材)
    if (videoRatio >= 0.25) {
      return { detectedIntent: 'footage_studio', confidence: 0.9 }
    }

    // 5. 混合杂乱桌面 (存在常见多媒体，但无单类达到绝对压倒性门限)
    if (docCount + imageCount + videoCount > 0) {
      return { detectedIntent: 'chaotic_inbox', confidence: 0.8 }
    }

    // 6. 纯其他格式 (如压缩包/二进制)
    return { detectedIntent: 'fast_archive', confidence: 0.3 }
  }
}

/**
 * 运行时单例服务 (DirectoryProfilerService)
 */
export class DirectoryProfilerService {
  private static instance: DirectoryProfilerService
  private profiler: DirectoryProfiler

  constructor() {
    this.profiler = new DirectoryProfiler()
  }

  static getInstance(): DirectoryProfilerService {
    if (!DirectoryProfilerService.instance) {
      DirectoryProfilerService.instance = new DirectoryProfilerService()
    }
    return DirectoryProfilerService.instance
  }

  /**
   * 快速嗅探目录画像
   */
  async probeProfile(dirPath: string): Promise<DirectoryProfileResult> {
    return this.profiler.profileDirectory(dirPath)
  }
}

export const directoryProfilerService = DirectoryProfilerService.getInstance()
