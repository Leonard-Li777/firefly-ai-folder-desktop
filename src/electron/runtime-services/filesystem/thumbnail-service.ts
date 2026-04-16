/**
 * 缩略图服务
 * 负责为文件生成缩略图（优先Electron Native，回退到LibreOffice + pdf-poppler）
 */

import { nativeImage, app } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fixPath from 'fix-path'
import { pathToFileURL } from 'node:url'
import { logger, LogCategory } from '@yonuc/shared'
import { configService } from '../config'
import sharp from 'sharp'
import { libreOfficeDetector } from '../system/libreoffice-detector'
import pdf from 'pdf-poppler'
import { t } from '@app/languages'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in ThumbnailService:', e);
  }
}

const execAsync = promisify(exec)

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
  /** 缩略图尺寸（仅用于Native方法）默认256 */
  thumbnailSize?: number
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
  /**
   * 确保缩略图目录存在（并设置为隐藏）
   */
  private async ensureThumbnailDirectory(workspaceDirectoryPath: string): Promise<string> {
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
            await execAsync(`attrib +h "${thumbnailDirPath}"`)
            logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 已将目录设置为隐藏: ${thumbnailDirPath}`)
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
  private generateThumbnailFileName(fileId: string, smartName: string): string {
    // 去除原文件扩展名，添加.jpg扩展名
    const nameWithoutExt = path.parse(smartName).name
    return `${fileId}_${nameWithoutExt}.jpg`
  }

  /**
   * 优先级1：使用Electron Native方法生成缩略图
   */
  private async generateThumbnailNative(
    filePath: string,
    outputPath: string,
    size = 256
  ): Promise<boolean> {
    const normalizedPath = path.resolve(filePath)
    try {
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 尝试使用Native方法生成缩略图: ${normalizedPath}`)

      // 检查方法是否存在（某些平台或Electron版本可能不存在）
      if (typeof (nativeImage as any).createThumbnailFromPath !== 'function') {
        logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] 当前环境不支持 nativeImage.createThumbnailFromPath`)
        return this.generateThumbnailWithSharp(normalizedPath, outputPath, size)
      }

      const thumbnail = await (nativeImage as any).createThumbnailFromPath(normalizedPath, { width: size, height: size })

      if (!thumbnail || thumbnail.isEmpty()) {
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] Native方法返回空图片, 尝试Sharp回退`)
        return this.generateThumbnailWithSharp(normalizedPath, outputPath, size)
      }

      // 获取PNG格式的Buffer
      const buffer = thumbnail.toPNG()

      // 使用Sharp转换为JPG
      await sharp(buffer)
        .jpeg({ quality: 85 })
        .toFile(outputPath)

      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] Native方法成功生成缩略图: ${outputPath}`)
      return true
    } catch (error) {
      // 降低日志级别，因为很多文件类型（如Office）Native方法失败是正常的
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] Native方法生成失败(预期内回退): ${error instanceof Error ? error.message : String(error)}`)
      return this.generateThumbnailWithSharp(normalizedPath, outputPath, size)
    }
  }

  /**
   * 辅助方法：直接使用Sharp为常规图片生成缩略图
   */
  private async generateThumbnailWithSharp(
    filePath: string,
    outputPath: string,
    size = 256
  ): Promise<boolean> {
    try {
      const ext = path.extname(filePath).toLowerCase()
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg']
      
      if (!imageExtensions.includes(ext)) {
        return false
      }

      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 尝试使用Sharp直接生成图片缩略图: ${filePath}`)
      
      await sharp(filePath)
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(outputPath)

      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] Sharp方法成功生成缩略图: ${outputPath}`)
      return true
    } catch (error) {
      logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] Sharp生成图片缩略图失败:`, error)
      return false
    }
  }

  /**
   * 使用LibreOffice命令行将Office文档转换为PDF
   * @param officePath 原始Office文件路径
   * @param outputDir 输出目录
   * @param fileId 文件ID（用于生成临时文件名，避免特殊字符问题）
   */
  private async convertOfficeToPDF(officePath: string, outputDir: string, fileId: string): Promise<string | null> {
    try {
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 开始将Office文档转换为PDF: ${officePath}`)

      // 检查文件是否存在
      try {
        await fs.access(officePath)
      } catch {
        logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] Office文件不存在: ${officePath}`)
        return null
      }

      const stats = await fs.stat(officePath)
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] Office文件大小: ${stats.size} 字节`)

      // 从系统设置中获取LibreOffice路径
      let libreOfficePath = configService.getValue<string>('LIBREOFFICE_PATH');
      
      // 如果系统设置中没有保存路径，则重新检测
      if (!libreOfficePath) {
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 系统设置中未找到LibreOffice路径，重新检测`)
        const detection = await libreOfficeDetector.detectLibreOffice()
        if (!detection.installed || !detection.path) {
          logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] LibreOffice未安装或未找到`)
          return null
        }
        libreOfficePath = detection.path
      }

      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 使用LibreOffice路径: ${libreOfficePath}`)

      // 确保输出目录存在
      await fs.mkdir(outputDir, { recursive: true })

      // 创建临时文件路径（使用fileId避免特殊字符问题）
      const ext = path.extname(officePath)
      const tempFileName = `temp_office_${fileId}${ext}`
      const tempOfficePath = path.join(outputDir, tempFileName)

      // 复制Office文件到临时文件（使用安全的文件名）
      try {
        await fs.copyFile(officePath, tempOfficePath)
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 已创建临时Office文件: ${tempOfficePath}`)
      } catch (copyError) {
        logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] 复制Office文件失败:`, copyError)
        return null
      }

      // 使用独立的临时用户目录，避免多实例冲突
      const userProfileDir = path.join(os.tmpdir(), `lo_user_${fileId}_${Date.now()}`);
      await fs.mkdir(userProfileDir, { recursive: true });
      const userProfileArg = `-env:UserInstallation=${pathToFileURL(userProfileDir).href}`;

      // 使用LibreOffice命令行转换临时文件
      // --headless: 不显示GUI
      // --convert-to pdf: 转换为PDF格式
      // --outdir: 输出目录
      const command = `"${libreOfficePath}" ${userProfileArg} --headless --convert-to pdf --outdir "${outputDir}" "${tempOfficePath}"`
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 执行命令: ${command}`)

      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 30000, // 30秒超时
          windowsHide: true, // Windows下隐藏窗口
          maxBuffer: 10 * 1024 * 1024 // 10MB缓冲区
        })

        if (stdout) {
          logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] LibreOffice输出: ${stdout}`)
        }
        if (stderr) {
          logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] LibreOffice错误输出: ${stderr}`)
        }
      } catch (execError: any) {
        logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] LibreOffice命令执行失败:`, execError)
        if (execError.stdout) {
          logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] stdout: ${execError.stdout}`)
        }
        if (execError.stderr) {
          logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] stderr: ${execError.stderr}`)
        }
        // 清理临时目录
        try {
          await fs.rm(userProfileDir, { recursive: true, force: true });
        } catch (e) { /* ignore */ }
        // 清理临时Office文件
        try {
          await fs.unlink(tempOfficePath)
        } catch (e) { /* ignore */ }
        return null
      }

      // 清理临时用户目录
      try {
        await fs.rm(userProfileDir, { recursive: true, force: true });
      } catch (e) {
        logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] 删除临时用户目录失败:`, e)
      }

      // 清理临时Office文件
      try {
        await fs.unlink(tempOfficePath)
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 已删除临时Office文件: ${tempOfficePath}`)
      } catch (e) {
        logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] 删除临时Office文件失败:`, e)
      }

      // 生成的PDF文件路径（LibreOffice会自动使用临时文件名）
      const baseName = path.basename(tempOfficePath, ext)
      const pdfPath = path.join(outputDir, `${baseName}.pdf`)

      // 检查PDF文件是否生成成功
      try {
        await fs.access(pdfPath)
        const pdfStats = await fs.stat(pdfPath)
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] PDF转换成功，文件大小: ${pdfStats.size} 字节`)
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] PDF文件路径: ${pdfPath}`)
        return pdfPath
      } catch {
        logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] PDF文件未生成: ${pdfPath}`)
        return null
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] Office转PDF失败:`, error)
      return null
    }
  }

  /**
   * 获取Poppler路径
   * 解决Electron Monorepo环境下找不到Poppler二进制文件的问题
   */
  private getPopplerPath(): string | undefined {
    // 在生产环境中，通常不需要设置，pdf-poppler会使用默认路径
    // 但在Electron monorepo开发环境中，我们需要手动指向根目录的node_modules
    if (app.isPackaged) {
      return undefined
    }

    // 开发环境：尝试寻找node_modules/pdf-poppler
    // 尝试几个可能的路径
    const possiblePaths = [
      // 1. Monorepo root (relative to apps/desktop)
      path.resolve(process.cwd(), '../../node_modules/pdf-poppler/lib/win/poppler-0.51'),
      // 2. Current directory node_modules (fallback)
      path.resolve(process.cwd(), 'node_modules/pdf-poppler/lib/win/poppler-0.51'),
      // 3. Relative to __dirname (deep search)
      path.resolve(__dirname, '../../../../../../node_modules/pdf-poppler/lib/win/poppler-0.51'),
      path.resolve(__dirname, '../../../../../../../node_modules/pdf-poppler/lib/win/poppler-0.51')
    ]

    for (const p of possiblePaths) {
      // Check if bin/pdftocairo.exe exists
      const exePath = path.join(p, 'bin', 'pdftocairo.exe')
      if (fsSync.existsSync(exePath)) {
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 找到Poppler路径: ${p}`)
        return p
      }
    }

    logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] 未找到Poppler路径，将使用默认配置`)
    return undefined
  }

  /**
   * 使用pdf-poppler将PDF转换为图片
   */
  private async convertPDFToImage(pdfPath: string, outputPath: string): Promise<boolean> {
    try {
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 开始将PDF转换为图片: ${pdfPath}`)

      const outputDir = path.dirname(outputPath)
      const outputName = path.basename(outputPath, path.extname(outputPath))

      // 获取Poppler路径
      // const popplerPath = this.getPopplerPath()

      // 使用临时前缀避免特殊字符问题
      const tempPrefix = `temp_thumb_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`

      const options = {
        format: 'jpeg',
        out_dir: outputDir,
        out_prefix: tempPrefix,
        page: 1,
        scale: 1024,
        // 如果找到了路径则设置，否则undefined（使用默认）
        // bin_path: popplerPath
      } as any;

      await pdf.convert(pdfPath, options)

      // pdf-poppler生成的图片文件名格式为: prefix-1.jpg 或 prefix-01.jpg
      // 我们需要检查这两种情况，或者查找以 prefix 开头的文件
      let generatedFile: string | null = null

      // 尝试查找生成的文件
      const files = await fs.readdir(outputDir)
      const match = files.find(f => f.startsWith(tempPrefix) && f.endsWith('.jpg'))

      if (match) {
        generatedFile = path.join(outputDir, match)
      } else {
        throw new Error(t('无法找到生成的缩略图文件 (prefix: {tempPrefix})', { tempPrefix }))
      }

      // 重命名为目标文件
      try {
        // 如果目标文件已存在，先删除
        try {
          await fs.unlink(outputPath)
        } catch (e) {
          // 忽略删除错误（文件可能不存在）
        }

        await fs.rename(generatedFile, outputPath)
        logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] PDF转图片成功: ${outputPath}`)
        return true
      } catch (error) {
        logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] 重命名生成的图片失败: ${generatedFile} -> ${outputPath}`, error)
        // 尝试清理生成的临时文件
        try {
          await fs.unlink(generatedFile)
        } catch (e) { /* ignore */ }
        return false
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] PDF转图片失败:`, error)
      return false
    }
  }

  /**
   * 优先级2：使用LibreOffice + pdf-poppler生成高清缩略图（仅Office/PDF）
   */
  private async generateThumbnailFallback(
    filePath: string,
    outputPath: string,
    fileId: string
  ): Promise<boolean> {
    const ext = path.extname(filePath).toLowerCase()
    const officeExtensions = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp']
    const isPDF = ext === '.pdf'
    const isOffice = officeExtensions.includes(ext)

    if (!isPDF && !isOffice) {
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] 文件类型不支持Fallback方法: ${ext}`)
      return false
    }

    try {
      let pdfPath: string | null = null
      let tempDir: string | null = null
      let needsCleanup = false

      if (isOffice) {
        // Office文档需要先转PDF(使用libreoffice-convert)
        // 使用fileId确保临时目录唯一且安全
        tempDir = path.join(os.tmpdir(), `thumbnail_${Date.now()}_${fileId}`)
        await fs.mkdir(tempDir, { recursive: true })

        pdfPath = await this.convertOfficeToPDF(filePath, tempDir, fileId)
        needsCleanup = true

        if (!pdfPath) {
          return false
        }
      } else {
        // 已经是PDF
        pdfPath = filePath
      }

      // PDF转图片
      const success = await this.convertPDFToImage(pdfPath, outputPath)

      // 清理临时文件
      if (needsCleanup && tempDir) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true })
        } catch (error) {
          logger.warn(LogCategory.FILE_PROCESSOR, `[缩略图服务] 清理临时文件失败:`, error)
        }
      }

      return success
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] Fallback方法异常:`, error)
      return false
    }
  }

  /**
   * 生成缩略图(主入口)
   */
  async generateThumbnail(options: ThumbnailGenerationOptions): Promise<ThumbnailResult> {
    try {
      const {
        fileId,
        filePath,
        smartName,
        workspaceDirectoryPath,
        thumbnailSize = 256
      } = options

      // 确保缩略图目录存在
      const thumbnailDir = await this.ensureThumbnailDirectory(workspaceDirectoryPath)

      // 生成缩略图文件名
      const thumbnailFileName = this.generateThumbnailFileName(fileId, smartName)
      const thumbnailAbsPath = path.join(thumbnailDir, thumbnailFileName)

      // 检查文件是否存在
      try {
        await fs.access(filePath)
      } catch {
        return {
          success: false,
          error: t('文件不存在: {filePath}', { filePath })
        }
      }

      const ext = path.extname(filePath).toLowerCase()
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg']
      const relativePath = path.join(VIRTUAL_DIRECTORY_FOLDER, THUMBNAIL_FOLDER, thumbnailFileName)

      // 优先级0: 如果是常规图像格式，直接使用 Sharp 以获得最佳稳定性和速度
      if (imageExtensions.includes(ext)) {
        const sharpSuccess = await this.generateThumbnailWithSharp(filePath, thumbnailAbsPath, thumbnailSize)
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
      const nativeSuccess = await this.generateThumbnailNative(filePath, thumbnailAbsPath, thumbnailSize)

      if (nativeSuccess) {
        return {
          success: true,
          relativePath,
          absolutePath: thumbnailAbsPath,
          method: 'native'
        }
      }

      // 优先级2:尝试Fallback方法(仅Office/PDF)
      logger.info(LogCategory.FILE_PROCESSOR, `[缩略图服务] Native方法失败或不支持, 尝试Fallback方法`)
      const fallbackSuccess = await this.generateThumbnailFallback(filePath, thumbnailAbsPath, fileId)

      if (fallbackSuccess) {
        return {
          success: true,
          relativePath,
          absolutePath: thumbnailAbsPath,
          method: 'fallback'
        }
      }

      // 两种方法都失败
      return {
        success: false,
        error: t('所有缩略图生成方法都失败')
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, `[缩略图服务] 生成缩略图异常:`, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
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
      const thumbnailDir = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER, THUMBNAIL_FOLDER)

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
}

// 导出单例
export const thumbnailService = new ThumbnailService()

