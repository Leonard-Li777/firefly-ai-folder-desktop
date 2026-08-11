/**
 * 缩略图服务
 * 负责为文件生成缩略图（优先Electron Native，回退到LibreOffice或Markitdown）
 */

import { nativeImage, app } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fixPath from 'fix-path'
import { pathToFileURL } from 'node:url'
import {
  logger,
  LogCategory,
  FileCategory,
  isCategory,
  BROWSER_NATIVE_IMAGE_EXTS
} from '@firefly/shared'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import sharp from 'sharp'
import { t } from '@app/languages'
import { MarkitdownProcessor } from '@firefly/core-engine'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32' && process.env.NODE_ENV !== 'test') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default
    if (typeof fixPathFunc === 'function') {
      fixPathFunc()
    }
  } catch (e) {
    console.error('Failed to fix PATH in ThumbnailService:', e)
  }
}

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// 虚拟目录文件夹名称常量
const VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'
const THUMBNAIL_FOLDER = '.thumbnail'

export interface ThumbnailGenerationOptions {
  /** 文件ID */
  fileId: string
  /** 文件路径 */
  filePath: string
  /** 文件虚拟名称（用于命名缩略图） */
  smartName: string
  /** 工作目录路径 */
  workspaceDirectoryPath: string
  /** 缩略图尺寸（仅用于Native/Sharp方法，通常用于 Simple 模式） */
  thumbnailSize?: number
  /** 是否为 Simple 模式（Simple 模式下跳过 PDF/Office） */
  isSimple?: boolean
}

export interface ThumbnailResult {
  /** 是否成功 */
  success: boolean
  /** 缩略图相对路径（相对于工作目录） */
  relativePath?: string
  /** 缩略图绝对路径 */
  absolutePath?: string
  /** 生成方法：native | fallback | sharp */
  method?: 'native' | 'fallback' | 'sharp'
  /** 错误信息 */
  error?: string
}

/**
 * 缩略图服务类
 */
export class ThumbnailService {
  /** 失败的缩略图生成负向缓存集合 */
  private failedThumbnailsSet = new Set<string>()

  constructor() {
    // 显式配置 Sharp 图像处理引擎的堆外内存上限与缓存阈值
    try {
      sharp.cache({ memory: 32, files: 20, items: 100 })
      sharp.concurrency(Math.max(1, Math.floor(os.cpus().length / 2)))
      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[缩略图服务] 初始化 Sharp 配置: memory=32MB, files=20, items=100, concurrency=${Math.max(1, Math.floor(os.cpus().length / 2))}`
      )
    } catch (error) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] 初始化 Sharp 配置失败:`, error)
    }
  }

  /**
   * 释放临时解码内存
   */
  private releaseSharpMemory(): void {
    try {
      sharp.cache(false)
      sharp.cache({ memory: 32, files: 20, items: 100 })
    } catch (error) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] 释放 Sharp 缓存失败:`, error)
    }
  }

  /**
   * 清除负向缓存
   */
  public clearNegativeCache(): void {
    this.failedThumbnailsSet.clear()
    logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 已清除缩略图负向缓存`)
  }

  /**
   * 检查是否在负向缓存中
   */
  public isFailed(filePath: string, mtimeMs: number): boolean {
    return this.failedThumbnailsSet.has(`${filePath}:${mtimeMs}`)
  }

  /**
   * 获取缩略图目录路径
   */
  public getThumbnailDirPath(workspaceDirectoryPath: string): string {
    return path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER, THUMBNAIL_FOLDER)
  }

  /**
   * 确保缩略图目录存在（并设置为隐藏）
   */
  public async ensureThumbnailDirectory(workspaceDirectoryPath: string): Promise<string> {
    const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
    const thumbnailDirPath = path.join(virtualDirPath, THUMBNAIL_FOLDER)

    try {
      // 检查虚拟目录是否存在
      try {
        await fs.access(virtualDirPath)
      } catch {
        await fs.mkdir(virtualDirPath, { recursive: true })
      }

      // 检查缩略图目录是否存在
      try {
        await fs.access(thumbnailDirPath)
      } catch {
        await fs.mkdir(thumbnailDirPath, { recursive: true })

        // 设置为隐藏目录（仅Windows）
        if (process.platform === 'win32') {
          try {
            await execFileAsync('attrib', ['+h', thumbnailDirPath])
            logger.info(
              LogCategory.FILE_PROCESSOR,
              `[缩略图服务] 已将目录设置为隐藏: ${thumbnailDirPath}`
            )
          } catch (error) {
            logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] 设置隐藏属性失败:`, error)
          }
        }
      }

      return thumbnailDirPath
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] 创建缩略图目录失败:`, error)
      throw error
    }
  }

  /**
   * 生成缩略图文件名
   */
  private generateThumbnailFileName(fileId: string, _smartName?: string): string {
    return `${fileId}.webp`
  }

  /**
   * 优先级1：使用Electron Native方法生成缩略图
   */
  private async generateThumbnailNative(
    filePath: string,
    outputPath: string,
    size?: number
  ): Promise<boolean> {
    const normalizedPath = path.resolve(filePath)
    try {
      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[缩略图服务] 尝试使用Native方法生成缩略图: ${normalizedPath}`
      )

      // 检查方法是否存在（某些平台或Electron版本可能不存在）
      if (typeof (nativeImage as any).createThumbnailFromPath !== 'function') {
        logger.warn(
          LogCategory.FILE_PROCESSOR,
          `[缩略图服务] 当前环境不支持 nativeImage.createThumbnailFromPath`
        )
        return this.generateThumbnailWithSharp(normalizedPath, outputPath, size)
      }

      // 如果未指定尺寸，默认使用 1024 (不再硬编码为 256)
      const finalSize = size || 1024
      const thumbnail = await (nativeImage as any).createThumbnailFromPath(normalizedPath, {
        width: finalSize,
        height: finalSize
      })

      if (!thumbnail || thumbnail.isEmpty()) {
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] Native方法返回空图片, 尝试Sharp回退`)
        return this.generateThumbnailWithSharp(normalizedPath, outputPath, size)
      }

      // 获取PNG格式的Buffer
      const buffer = thumbnail.toPNG()

      // 使用Sharp转换为 WebP
      await sharp(buffer).webp({ quality: 90 }).toFile(outputPath)

      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[缩略图服务] Native方法成功生成 WebP 缩略图: ${outputPath}`
      )
      return true
    } catch (error) {
      // 降低日志级别，因为很多文件类型（如Office）Native方法失败是正常的
      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[缩略图服务] Native方法生成失败(预期内回退): ${error instanceof Error ? error.message : String(error)}`
      )
      return this.generateThumbnailWithSharp(normalizedPath, outputPath, size)
    }
  }

  /**
   * 辅助方法：直接使用Sharp为常规图片生成缩略图
   */
  private async generateThumbnailWithSharp(
    filePath: string,
    outputPath: string,
    size?: number
  ): Promise<boolean> {
    try {
      if (!isCategory(filePath, FileCategory.IMAGE)) {
        return false
      }

      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[缩略图服务] 尝试使用Sharp直接生成图片缩略图: ${filePath}`
      )

      const sharpInstance = sharp(filePath)
      if (size && size > 0) {
        sharpInstance.resize(size, size, { fit: 'inside', withoutEnlargement: true })
      }

      await sharpInstance.webp({ quality: 90 }).toFile(outputPath)

      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[缩略图服务] Sharp方法成功生成 WebP 缩略图: ${outputPath}`
      )
      return true
    } catch (error) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] Sharp生成图片缩略图失败:`, error)
      return false
    }
  }

  /**
   * 优先级2：使用 Markitdown 直接生成预览图
   */
  private async generateThumbnailFallback(
    filePath: string,
    outputPath: string,
    _fileId: string
  ): Promise<boolean> {
    const ext = path.extname(filePath).toLowerCase()
    const isPDF = ext === '.pdf'
    const isOffice = isCategory(filePath, FileCategory.OFFICE)

    if (!isPDF && !isOffice) {
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 文件类型不支持Fallback方法: ${ext}`)
      return false
    }

    // 直接使用 Markitdown 处理，它内部会根据环境决定是使用 LibreOffice 转换还是提取嵌入图
    return await this.generateThumbnailWithMarkitdown(filePath, outputPath)
  }

  /**
   * 优先级3：使用 markitdown thumbnail 子命令生成缩略图
   */
  private async generateThumbnailWithMarkitdown(
    filePath: string,
    outputPath: string
  ): Promise<boolean> {
    try {
      const markitdownPath = MarkitdownProcessor.getMarkitdownBinaryPath()

      // 检查二进制文件是否存在
      if (!fsSync.existsSync(markitdownPath)) {
        logger.warn(
          LogCategory.FILE_PROCESSOR,
          `[缩略图服务] Markitdown 二进制文件不存在: ${markitdownPath}`
        )
        return false
      }

      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[缩略图服务] 尝试使用 Markitdown 生成缩略图: ${filePath}`
      )

      // 使用 --pages "1" 仅提取第一页
      const args = ['thumbnail', filePath, '-o', outputPath, '--pages', '1']

      await execFileAsync(markitdownPath, args, {
        timeout: 30000, // 增加超时时间到30秒，考虑到Office转换可能较慢
        windowsHide: true
      })

      if (fsSync.existsSync(outputPath)) {
        logger.info(
          LogCategory.FILE_PROCESSOR,
          `[缩略图服务] Markitdown 成功生成缩略图: ${outputPath}`
        )
        return true
      }

      return false
    } catch (error) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] Markitdown 生成缩略图失败:`, error)
      return false
    }
  }

  /**
   * 生成缩略图(主入口)
   */
  async generateThumbnail(options: ThumbnailGenerationOptions): Promise<ThumbnailResult> {
    let cacheKey: string | undefined
    try {
      const {
        fileId,
        filePath,
        smartName,
        workspaceDirectoryPath,
        thumbnailSize,
        isSimple = false
      } = options

      // Simple 模式跳过 PDF/Office
      if (
        isSimple &&
        (isCategory(filePath, FileCategory.OFFICE) || filePath.toLowerCase().endsWith('.pdf'))
      ) {
        return {
          success: false,
          error: t('Simple 模式下跳过 PDF/Office 缩略图生成')
        }
      }

      // 获取文件状态以读取 mtime 并生成 cacheKey
      let stats: any
      try {
        stats = await fs.stat(filePath)
        const mtimeMs = stats.mtimeMs
        cacheKey = `${filePath}:${mtimeMs}`
      } catch {
        return {
          success: false,
          error: t('文件不存在: {filePath}', { filePath })
        }
      }

      // 检查负向缓存
      if (this.failedThumbnailsSet.has(cacheKey)) {
        logger.info(
          LogCategory.FILE_PROCESSOR,
          `[缩略图服务] 匹配负向缓存，快速返回失败结果: ${filePath}`
        )
        return {
          success: false,
          error: t('所有缩略图生成方法都失败（缓存）')
        }
      }

      // 确保缩略图目录存在
      const thumbnailDir = await this.ensureThumbnailDirectory(workspaceDirectoryPath)

      // 生成缩略图文件名
      const thumbnailFileName = this.generateThumbnailFileName(fileId, smartName)
      const thumbnailAbsPath = path.join(thumbnailDir, thumbnailFileName)

      const relativePath = path.join(VIRTUAL_DIRECTORY_FOLDER, THUMBNAIL_FOLDER, thumbnailFileName)

      // 优先级0: 如果是常规图像格式，直接使用 Sharp 以获得最佳稳定性和速度
      if (isCategory(filePath, FileCategory.IMAGE)) {
        const sharpSuccess = await this.generateThumbnailWithSharp(
          filePath,
          thumbnailAbsPath,
          thumbnailSize
        )
        if (sharpSuccess) {
          return {
            success: true,
            relativePath,
            absolutePath: thumbnailAbsPath,
            method: 'sharp'
          }
        }
      }

      // 优先级1:尝试Native方法 (视频、特殊格式等)
      const nativeSuccess = await this.generateThumbnailNative(
        filePath,
        thumbnailAbsPath,
        thumbnailSize
      )

      if (nativeSuccess) {
        return {
          success: true,
          relativePath,
          absolutePath: thumbnailAbsPath,
          method: 'native'
        }
      }

      // 优先级2:尝试Fallback方法(仅Office/PDF)
      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[缩略图服务] Native方法失败或不支持, 尝试Fallback方法`
      )
      const fallbackSuccess = await this.generateThumbnailFallback(
        filePath,
        thumbnailAbsPath,
        fileId
      )

      if (fallbackSuccess) {
        return {
          success: true,
          relativePath,
          absolutePath: thumbnailAbsPath,
          method: 'fallback'
        }
      }

      // 两种方法都失败
      if (cacheKey) {
        this.failedThumbnailsSet.add(cacheKey)
      }
      return {
        success: false,
        error: t('所有缩略图生成方法都失败')
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] 生成缩略图异常:`, error)
      if (cacheKey) {
        this.failedThumbnailsSet.add(cacheKey)
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.releaseSharpMemory()
    }
  }

  /**
   * 删除缩略图文件
   */
  async deleteThumbnail(thumbnailPath: string, workspaceDirectoryPath: string): Promise<boolean> {
    try {
      const absolutePath = path.join(workspaceDirectoryPath, thumbnailPath)
      await fs.unlink(absolutePath)
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 已删除缩略图: ${absolutePath}`)
      return true
    } catch (error) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] 删除缩略图失败:`, error)
      return false
    }
  }

  /**
   * 清理某个工作目录下的所有缩略图
   */
  async cleanupThumbnailDirectory(workspaceDirectoryPath: string): Promise<void> {
    try {
      const thumbnailDir = path.join(
        workspaceDirectoryPath,
        VIRTUAL_DIRECTORY_FOLDER,
        THUMBNAIL_FOLDER
      )

      try {
        await fs.access(thumbnailDir)
        await fs.rm(thumbnailDir, { recursive: true, force: true })
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 已清理缩略图目录: ${thumbnailDir}`)
      } catch {
        // 目录不存在,无需清理
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] 清理缩略图目录失败:`, error)
    }
  }

  /**
   * 获取或生成浏览器不支持的图片的转码原图
   */
  async getOrGenerateOriginalTranscodedImage(
    filePath: string,
    fileFingerprint: string,
    smartName: string,
    workspaceDirectoryPath: string
  ): Promise<{ success: boolean; absolutePath?: string; relativePath?: string; error?: string }> {
    try {
      const thumbnailDir = await this.ensureThumbnailDirectory(workspaceDirectoryPath)
      const transcodedFileName = this.generateThumbnailFileName(fileFingerprint, smartName)
      const transcodedAbsPath = path.join(thumbnailDir, transcodedFileName)
      const relativePath = path.join(VIRTUAL_DIRECTORY_FOLDER, THUMBNAIL_FOLDER, transcodedFileName)

      // 1. 如果已存在，直接返回
      try {
        await fs.access(transcodedAbsPath)
        return {
          success: true,
          absolutePath: transcodedAbsPath,
          relativePath
        }
      } catch {
        // 缓存不存在，开始转码
      }

      // 2. 检查源文件是否存在
      try {
        await fs.access(filePath)
      } catch {
        return {
          success: false,
          error: t('原文件不存在: {filePath}', { filePath })
        }
      }

      // 3. 转码为原尺寸 webp
      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[缩略图服务] 正在对不支持的图片进行原尺寸转码 WebP: ${filePath} -> ${transcodedAbsPath}`
      )

      // 优先使用 Sharp 进行全尺寸转码
      try {
        await sharp(filePath).webp({ quality: 90 }).toFile(transcodedAbsPath)

        return {
          success: true,
          absolutePath: transcodedAbsPath,
          relativePath
        }
      } catch (sharpError) {
        logger.error(
          LogCategory.FILE_PROCESSOR,
          `[缩略图服务] 使用 Sharp 转码失败，尝试使用 Electron Native 进行转码:`,
          sharpError
        )

        // 回退到 Electron Native 转码
        if (typeof (nativeImage as any).createThumbnailFromPath === 'function') {
          let width = 2048
          let height = 2048
          try {
            const metadata = await sharp(filePath).metadata()
            if (metadata.width && metadata.height) {
              width = metadata.width
              height = metadata.height
            }
          } catch (e) {
            logger.warn(LogCategory.FILE_WATCHER, '获取图片尺寸元数据失败:', filePath, e)
          }

          const thumbnail = await (nativeImage as any).createThumbnailFromPath(
            path.resolve(filePath),
            { width, height }
          )
          if (thumbnail && !thumbnail.isEmpty()) {
            const buffer = thumbnail.toPNG()
            await sharp(buffer).webp({ quality: 90 }).toFile(transcodedAbsPath)

            return {
              success: true,
              absolutePath: transcodedAbsPath,
              relativePath
            }
          }
        }

        throw new Error('Sharp 与 Native 转码均失败')
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] 原尺寸转码异常:`, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.releaseSharpMemory()
    }
  }
}

// 导出单例
export const thumbnailService = new ThumbnailService()
