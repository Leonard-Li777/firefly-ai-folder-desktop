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
import type { WorkspaceConfigIntent } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'

/**
 * 常见黑名单目录名称 (小写比较，无条件跳过)
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
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'pods',
  '.idea',
  '.vscode',
  '.trash',
  '.ds_store'
])

/**
 * 文档与文本类扩展名
 */
export const DOCUMENT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'csv', 'json', 'xml', 'html', 'htm', 'epub', 'mobi', 'rtf', 'log', 'tex',
  'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rb', 'php', 'sql', 'sh', 'bash', 'ps1', 'bat', 'cmd',
  'yaml', 'yml', 'toml', 'ini', 'env'
])

/**
 * 图片与视觉类扩展名
 */
export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif',
  'heic', 'heif', 'avif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'psd', 'ai',
  'eps', 'sketch', 'xd', 'fig'
])

/**
 * 视频与影视类扩展名
 */
export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'rmvb', 'rm',
  '3gp', 'ts', 'mpg', 'mpeg', 'vob', 'm2ts', 'mts'
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
  topExtensions: Array<{ ext: string; count: number }>
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
   * 异步广度优先遍历嗅探目录扩展名分布 (带硬超时竞速防护)
   */
  async profileDirectory(targetPath: string): Promise<DirectoryProfileResult> {
    const startTime = Date.now()
    const extensionCounts = new Map<string, number>()

    let docCount = 0
    let imageCount = 0
    let videoCount = 0
    let otherCount = 0
    let totalSampled = 0
    let hitTimeBudget = false

    // 内部实际执行遍历的异步任务
    const traverseTask = async (): Promise<void> => {
      const queue: Array<{ dirPath: string; depth: number }> = [{ dirPath: targetPath, depth: 0 }]

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
            const ext = path.extname(fileName).slice(1).toLowerCase()
            if (ext) {
              extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1)
              if (DOCUMENT_EXTENSIONS.has(ext)) {
                docCount++
              } else if (IMAGE_EXTENSIONS.has(ext)) {
                imageCount++
              } else if (VIDEO_EXTENSIONS.has(ext)) {
                videoCount++
              } else {
                otherCount++
              }
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
      logger.warn(LogCategory.FILE_SCANNER, `[DirectoryProfiler] 嗅探目录发生非致命异常: ${targetPath}`, error)
    }

    const durationMs = Date.now() - startTime

    // 统计频率最高的前 5 个扩展名
    const topExtensions = Array.from(extensionCounts.entries())
      .map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    const stats: DirectoryProfileStats = {
      totalSampled,
      docCount,
      imageCount,
      videoCount,
      otherCount,
      topExtensions,
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
    if (imageRatio >= 0.60) {
      return { detectedIntent: 'visual_gallery', confidence: 0.9 }
    }

    // 3. 绝对多数派优先判定：文档文献意图 (文档/代码 >= 50%)
    if (docRatio >= 0.50) {
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
