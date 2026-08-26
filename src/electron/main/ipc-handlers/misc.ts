import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'node:module'
import { ipcMain, app, shell, BrowserWindow, clipboard } from 'electron'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { databaseService } from '../../runtime-services/database/database-service'
import { logger, LogCategory, ResourceLocator, getMimeTypeByExtension } from '@firefly/shared'
import { omniService } from '../../runtime-services/system/omni-service'
import { SystemIdentityService } from '../../runtime-services/system/system-identity-service'
import { LicenseService, LicenseStatus } from '../../runtime-services/system/license-service'
import { cloudAnalysisService } from '@firefly/server'
import { userTierService } from '../../runtime-services/user-tier/user-tier-service'
import { invitationService } from '../../runtime-services/invitation/invitation-service'
import { libreOfficeDetector } from '../../runtime-services/system/libreoffice-detector'
import {
  ModelDownloadManagerIPCHandler,
  registerFfmpegIpcHandlers
} from '../../runtime-services/ipc'
import { registerOllamaIPCHandlers } from '../../runtime-services/ipc/ollama-ipc-handler'
import { AIEngineFactory } from '../../runtime-services/ai/adapters/ai-engine-factory'
import { t } from '@app/languages'
import { coreEngine, fileCleanupService } from '../state'
import { initializeHardwareDetection as initializeHardwareDetectionFn } from '../initialization'
import { loadIgnoreRules } from '../../runtime-services/analysis/analysis-ignore-service'

export function registerMiscIPCHandlers() {
  ipcMain.handle('app:relaunch', async () => {
    logger.info(LogCategory.IPC, '准备重启应用...')
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.destroy()
      }
    })
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('show-item-in-folder', async (event, filePath: string) => {
    try {
      logger.info(LogCategory.MAIN, '[Main] 在资源管理器中定位文件:', filePath)
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (error) {
      logger.error(LogCategory.MAIN, '[Main] 定位文件失败:', error)
      throw error
    }
  })

  ipcMain.handle('copy-file-to-clipboard', async (event, filePath: string) => {
    try {
      logger.info(LogCategory.MAIN, '[Main] 复制文件到剪贴板:', filePath)
      const normalizedPath =
        process.platform === 'win32' ? path.win32.normalize(filePath) : filePath
      clipboard.write({ filenames: [normalizedPath], text: normalizedPath } as any)
      return { success: true }
    } catch (error) {
      logger.error(LogCategory.MAIN, '[Main] 复制文件失败:', error)
      throw error
    }
  })

  ipcMain.handle('copy-files-to-clipboard', async (event, filePaths: string[]) => {
    try {
      logger.info(LogCategory.MAIN, '[Main] 复制多个文件到剪贴板:', filePaths)
      if (!filePaths || filePaths.length === 0) return { success: false }
      const normalizedPaths =
        process.platform === 'win32' ? filePaths.map(p => path.win32.normalize(p)) : filePaths
      clipboard.write({ filenames: normalizedPaths, text: normalizedPaths.join('\n') } as any)
      return { success: true }
    } catch (error) {
      logger.error(LogCategory.MAIN, '[Main] 复制多个文件失败:', error)
      throw error
    }
  })

  ipcMain.handle('units/get-by-file', async (event, fileId: number) => {
    return await databaseService.getUnitsForFile(fileId)
  })
  ipcMain.handle('units/get-by-path', async (event, filePath: string) => {
    return await databaseService.getUnitsForPath(filePath)
  })

  ipcMain.handle('get-file-analysis-result', async (event, filePath: string) => {
    try {
      // 入参非空守卫：渲染进程可能在文件路径就绪前发起查询，
      // 空路径直接返回 null，避免触发无效数据库查询与告警日志
      if (!filePath) return null
      logger.debug(LogCategory.MAIN, '[IPC] 获取文件分析结果请求:', { filePath })
      let result = await databaseService.getFileAnalysisResult(filePath)

      // 即时元数据补充防护：如果数据库没有该文件记录或者 metadata 为空，但物理文件实际存在，
      // 则统一通过 Omni 引擎提取 Exif/媒体/格式元数据，保证详情面板中元数据 Tab 永远有内容呈现
      if (fs.existsSync(filePath)) {
        if (!result) {
          try {
            const stats = fs.statSync(filePath)
            const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
            const mimeType = getMimeTypeByExtension(ext)
            const metaFull = await omniService.extractMetadataFull(filePath)
            result = {
              path: filePath,
              name: path.basename(filePath),
              size: stats.size,
              type: ext.toUpperCase(),
              mimeType,
              createdAt: stats.birthtime,
              modifiedAt: stats.mtime,
              accessedAt: stats.atime,
              isAnalyzed: false,
              category: {
                label: ext,
                mime_type: mimeType,
                description: `${ext.toUpperCase()} File`
              },
              metadata: metaFull
            }
          } catch (e) {
            logger.warn(LogCategory.MAIN, '动态提取未入库文件元数据失败:', e)
          }
        } else {
          // 深度元数据补充：如果数据库已有 metadata，但缺乏 Exif/媒体详细属性（如仅有 raw_smart_name/naming_template 等简易字段），
          // 则即时通过 Omni 提取并深度合并 Exif 字段，绝不丢失真实图片尺寸、相机、分辨率与媒体属性
          const meta = result.metadata || {}
          const hasExifDetail =
            Boolean(
              meta.Make ||
              meta.Model ||
              meta.ImageWidth ||
              meta.ImageSize ||
              meta.Megapixels ||
              meta.MIMEType ||
              meta.camera ||
              meta.exif ||
              meta.imageSize ||
              meta.ExposureTime ||
              meta.FNumber ||
              meta.duration ||
              meta.audio ||
              meta.video
            )
          if (!hasExifDetail) {
            try {
              const metaFull = await omniService.extractMetadataFull(filePath)
              if (metaFull && Object.keys(metaFull).length > 0) {
                result.metadata = {
                  ...metaFull,
                  ...meta // 保留数据库中记录的智能命名模板与 raw_smart_name
                }
              }
            } catch (e) {
              logger.warn(LogCategory.MAIN, '深度合并文件 Exif 元数据失败:', e)
            }
          }
        }
      }

      return result
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 获取文件分析结果失败:', error)
      throw error
    }
  })

  ipcMain.handle('delete-file-tag', async (event, filePath: string, tagId: number) => {
    try {
      const db = databaseService.db
      if (!db) throw new Error('数据库未初始化')
      const fileRow = db
        .prepare('SELECT file_fingerprint FROM workspace_files WHERE path = ?')
        .get(filePath) as { file_fingerprint: string } | undefined
      if (!fileRow) return { success: false, error: '文件不存在' }
      db.prepare('DELETE FROM file_tag_relations WHERE file_fingerprint = ? AND tag_id = ?').run(
        fileRow.file_fingerprint,
        tagId
      )
      databaseService.syncFTSTags(fileRow.file_fingerprint)
      return { success: true }
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 删除标签失败:', error)
      return { success: false, error: String(error) }
    }
  })



  // 预览即时图片转码
  ipcMain.handle('preview/get-temp-image', async (event, filePath: string) => {
    try {
      logger.info(LogCategory.MAIN, '[IPC] 预览即时图片转码请求:', { filePath })
      const db = databaseService.db
      if (!db) throw new Error('数据库未连接')
      const workspaceFile = (await db
        .prepare(
          `
        SELECT wf.file_fingerprint, wf.name, wf.workspace_id
        FROM workspace_files wf
        WHERE wf.path = ?
      `
        )
        .get(filePath)) as any

      if (!workspaceFile) {
        throw new Error(t('未在工作空间找到该文件信息'))
      }

      const rootDir = await databaseService.getWorkspaceDirectoryById(workspaceFile.workspace_id)
      if (!rootDir) {
        throw new Error(t('未找到所属的工作区目录'))
      }

      const { thumbnailService } =
        await import('../../runtime-services/filesystem/thumbnail-service')
      const result = await thumbnailService.getOrGenerateOriginalTranscodedImage(
        filePath,
        workspaceFile.file_fingerprint,
        workspaceFile.name,
        rootDir.path
      )
      return result
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 预览即时图片转码失败:', error)
      return { success: false, error: String(error) }
    }
  })

  // 预览读取限流文本
  ipcMain.handle('preview/read-text-limit', async (event, filePath: string, limit = 100000) => {
    try {
      const stats = await fs.promises.stat(filePath)
      const size = stats.size

      // 纯文本预览最大读取字节数（约100KB）：文件超过该大小时只截取前 100KB，
      // 避免对大文件整体读取与解码导致预览卡顿
      const MAX_TEXT_PREVIEW_BYTES = 104857

      const fd = await fs.promises.open(filePath, 'r')
      const readBytes = Math.min(size, MAX_TEXT_PREVIEW_BYTES)
      const buffer = Buffer.alloc(readBytes)
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0)
      await fd.close()

      const subBuffer = buffer.subarray(0, bytesRead)

      const jschardet = await import('jschardet')
      const iconv = await import('iconv-lite')

      let encoding = 'utf-8'
      try {
        const detected = jschardet.default.detect(subBuffer.toString('binary'))
        if (detected && detected.confidence > 0.8) {
          encoding = detected.encoding.toLowerCase()
        }
      } catch (e) {
        logger.warn(LogCategory.MAIN, '检测编码失败，默认utf-8:', e)
      }

      let text = iconv.default.decode(subBuffer, encoding)

      let isTruncated = false
      if (text.length > limit) {
        text = text.substring(0, limit)
        isTruncated = true
      } else if (size > subBuffer.length) {
        isTruncated = true
      }

      return { success: true, text, isTruncated, size }
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 读取预览文本失败:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('get-directory-analysis-result', async (event, dirPath: string) => {
    return await databaseService.getDirectoryAnalysisResult(dirPath)
  })

  ipcMain.handle('get-user-home-path', async () => os.homedir())
  ipcMain.handle('join-path', async (event, basePath: string, relativePath: string) =>
    path.join(basePath, relativePath)
  )

  // 获取系统/文件关联图标（用于无缩略图时展示），主进程缓存避免重复读取
  const fileIconCache = new Map<string, string>()
  const FILE_ICON_CACHE_MAX = 500

  // 延迟加载原生模块的 require（与当前模块同目录解析），
  // 不使用动态 import()：Electron 主进程在并发场景下首次动态 import() 原生模块
  // 可能触发 Chromium "Must be called on Chrome_UIThread" 崩溃，require 无此问题
  const iconModuleRequire = createRequire(import.meta.url)

  // extract-file-icon 原生模块（Windows 专属，N-API），延迟加载避免主进程启动时加载
  // undefined 表示尚未加载，null 表示不可用（非 Windows / 加载失败）
  let extractFileIconModule: IconExtractor | null | undefined

  type IconExtractor = (filePath: string, size?: 16 | 32 | 64 | 256) => Buffer

  /**
   * 延迟加载 extract-file-icon 原生模块，用于提取 256x256 高清文件关联图标。
   * 模块由 electron-vite 标记为 external，运行时从 node_modules 加载。
   * 返回 null 表示模块不可用（非 Windows / 未安装 / 加载失败）。
   */
  const getFileIconExtractor = (): IconExtractor | null => {
    if (extractFileIconModule !== undefined) return extractFileIconModule
    if (process.platform !== 'win32') {
      extractFileIconModule = null
      return null
    }
    try {
      // 兼容 CJS interop 的两种形态（直接函数 / { default: fn }）
      const mod = iconModuleRequire('extract-file-icon') as unknown
      const fn = (mod as { default?: unknown })?.default ?? mod
      extractFileIconModule = (typeof fn === 'function' ? fn : null) as IconExtractor | null
    } catch (error) {
      logger.warn(LogCategory.MAIN, '[IPC] extract-file-icon 加载失败，回退系统原生图标', error)
      extractFileIconModule = null
    }
    return extractFileIconModule
  }

  /**
   * 解析 Windows 快捷方式（.lnk）指向的实际目标路径。
   * 若解析失败或目标不存在，回退到原始 .lnk 路径。
   */
  const resolveShortcutTarget = (filePath: string): string => {
    if (process.platform !== 'win32') return filePath
    try {
      const details = shell.readShortcutLink(filePath)
      let target = details?.target
      // 个别快捷方式 target 可能被引号包裹，去掉首尾引号
      if (typeof target === 'string' && target.startsWith('"') && target.endsWith('"')) {
        target = target.slice(1, -1)
      }
      if (target && fs.existsSync(target)) return target
    } catch {
      // 解析失败（如 Store/UWP 快捷方式）时回退到 .lnk 本身
    }
    return filePath
  }

  ipcMain.handle('get-file-icon', async (event, filePath: string, size?: string) => {
    // 临时调试日志：定位崩溃与图标请求的相对位置
    logger.debug(
      LogCategory.MAIN,
      `[IPC] get-file-icon 调用: ${filePath} size=${size ?? 'undefined'}`
    )
    try {
      // 空路径/非字符串路径直接返回 null，避免空路径传入原生模块（extract-file-icon）
      // 触发底层野指针或崩溃
      if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') return null
      const iconSize = ['small', 'normal', 'large'].includes(size || '')
        ? (size as 'small' | 'normal' | 'large')
        : 'small'
      // .lnk 快捷方式先解析目标路径，取目标文件的专属图标（而非通用的快捷方式图标）
      const targetPath = filePath.toLowerCase().endsWith('.lnk')
        ? resolveShortcutTarget(filePath)
        : filePath
      // 防御性校验：解析后的目标路径若仍为空，直接返回，不进入原生模块调用
      if (!targetPath || targetPath.trim() === '') return null
      const cacheKey = `${targetPath}:${iconSize}`
      if (fileIconCache.has(cacheKey)) return fileIconCache.get(cacheKey)

      // Windows 下优先使用 extract-file-icon 提取 256x256 高清 PNG 图标，
      // 若模块不可用或提取失败则降级为 Electron 原生 app.getFileIcon
      let dataUrl: string | null = null
      if (process.platform === 'win32') {
        const extractor = getFileIconExtractor()
        if (extractor) {
          try {
            const startedAt = Date.now()
            const pngBuffer = extractor(targetPath, 256)
            // 临时调试日志：记录高清提取耗时与结果
            logger.debug(
              LogCategory.MAIN,
              `[IPC] extract-file-icon 提取: ${targetPath} bytes=${pngBuffer?.length ?? 0} 耗时=${Date.now() - startedAt}ms`
            )
            if (pngBuffer && pngBuffer.length > 0) {
              dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`
            }
          } catch (error) {
            logger.warn(
              LogCategory.MAIN,
              `[IPC] extract-file-icon 提取图标失败，降级原生 API: ${targetPath}`,
              error
            )
          }
        }
      }

      if (!dataUrl) {
        const icon = await app.getFileIcon(targetPath, { size: iconSize })
        if (!icon || icon.isEmpty()) return null
        dataUrl = icon.toDataURL()
      }

      fileIconCache.set(cacheKey, dataUrl)
      // 简单 LRU 淘汰：缓存超限时删除最早的一项
      if (fileIconCache.size > FILE_ICON_CACHE_MAX) {
        const firstKey = fileIconCache.keys().next().value
        if (firstKey) fileIconCache.delete(firstKey)
      }
      return dataUrl
    } catch (error) {
      logger.warn(LogCategory.MAIN, `[IPC] 获取文件图标失败: ${filePath}`, error)
      return null
    }
  })

  ipcMain.handle('reset-file-analysis', async (event, fileId: string) => {
    try {
      const { fileAnalysisService } = await import('@firefly/core-engine')
      fileAnalysisService.removeFromQueue(fileId)
      await databaseService.resetFileAnalysis(fileId)
      return { success: true }
    } catch (error) {
      logger.error(LogCategory.MAIN, `重置文件分析失败: ${fileId}`, error)
      return { success: false, message: t('未知错误') }
    }
  })

  // 文件清理相关
  ipcMain.handle('file-cleanup/delete-file', async (event, fileId: string) => {
    if (!fileCleanupService) throw new Error(t('文件清理服务未初始化'))
    return await fileCleanupService.deleteFileAndCleanup(Number(fileId))
  })
  ipcMain.handle('file-cleanup/batch-delete-files', async (event, fileIds: string[]) => {
    if (!fileCleanupService) throw new Error(t('文件清理服务未初始化'))
    return await fileCleanupService.batchDeleteFiles(fileIds.map(id => Number(id)))
  })

  ipcMain.handle('empty-folder/scan', async (event, workspaceDirectoryPath: string) => {
    const { EmptyFolderScanner } = await import('@firefly/core-engine')
    if (!databaseService.db) throw new Error(t('数据库未连接'))
    const scanner = new EmptyFolderScanner(databaseService.db)
    const ignoreRules = loadIgnoreRules()
    return await scanner.scanEmptyFolders(workspaceDirectoryPath, ignoreRules as any)
  })
  ipcMain.handle('empty-folder/delete', async (event, folderPaths: string[]) => {
    const { EmptyFolderScanner } = await import('@firefly/core-engine')
    if (!databaseService.db) throw new Error(t('数据库未连接'))
    const scanner = new EmptyFolderScanner(databaseService.db)
    return await scanner.deleteEmptyFolders(folderPaths)
  })

  registerFfmpegIpcHandlers()

  ipcMain.handle('get-machine-id', async () => SystemIdentityService.getInstance().getMachineId())
  ipcMain.handle('license/get-status', async () => {
    return LicenseService.getInstance().checkLicenseStatus(true)
  })
  ipcMain.handle('license/check-online', async () => {
    try {
      await initializeHardwareDetectionFn(true)
      if (cloudAnalysisService.isDeviceRegistered())
        LicenseService.getInstance().setOnlineAuthorized(true)
      const result = await LicenseService.getInstance().checkLicenseStatus(true)
      if (result.status === LicenseStatus.AUTHORIZED)
        await ConfigOrchestrator.getInstance().updateValue('MACHINE_REGISTERED', true)
      return result
    } catch (e) {
      return { status: LicenseStatus.UNAUTHORIZED, error: t('网络连接失败') }
    }
  })
  ipcMain.handle('license/get-invitation-code', async () =>
    LicenseService.getInstance().getInvitationCode()
  )
  ipcMain.handle('license/get-base64-code', async () =>
    LicenseService.getInstance().getBase64Code()
  )
  ipcMain.handle('license/activate', async (_event, licenseCode: string) =>
    LicenseService.getInstance().activate(licenseCode)
  )

  ipcMain.handle('userTier/getProfile', async () => {
    return await userTierService.getProfile()
  })
  ipcMain.handle('userTier/syncFromCloud', async () => {
    const machineId = SystemIdentityService.getInstance().getMachineId()
    await userTierService.syncLocalCacheAndNotify(machineId)
    return await userTierService.getProfile()
  })

  ipcMain.handle('userTier/getConsumptionDetails', async () => {
    return await userTierService.getConsumptionDetails()
  })

  ipcMain.handle('userTier/checkQuota', async (_, operation) => {
    return await userTierService.checkQuota(operation)
  })

  ipcMain.handle(
    'userTier/spendFirecores',
    async (_event, firecores: number, type?: string, metadata?: Record<string, any>) => {
      return await userTierService.spendFirecores(
        firecores,
        (type as any) || 'spend_unlock_analysis',
        metadata
      )
    }
  )

  ipcMain.handle('open-file-with-default-app', async (event, filePath: string) => {
    const result = await shell.openPath(filePath)
    if (result) throw new Error(result)
    return { success: true }
  })
  ipcMain.handle('open-path-in-explorer', async (event, dirPath: string) => {
    const result = await shell.openPath(dirPath)
    if (result) throw new Error(result)
    return { success: true }
  })

  ipcMain.handle('preprocess-text-file', async (_event, filePath: string) => {
    try {
      const stat = await fs.promises.stat(filePath)
      const MAX_SIZE = 1024 * 1024 // 1MB
      let buffer: Buffer
      if (stat.size > MAX_SIZE) {
        const fd = await fs.promises.open(filePath, 'r')
        buffer = Buffer.alloc(MAX_SIZE)
        await fd.read(buffer, 0, MAX_SIZE, 0)
        await fd.close()
        logger.info(LogCategory.MAIN, `[预处理] 文件超过1MB，已截取前1MB: ${filePath}`)
      } else {
        buffer = await fs.promises.readFile(filePath)
      }

      const isUtf8 = (() => {
        try {
          const decoder = new TextDecoder('utf-8', { fatal: true })
          decoder.decode(buffer)
          return true
        } catch {
          return false
        }
      })()

      if (isUtf8 && stat.size <= MAX_SIZE) {
        return filePath
      }

      const encodingsToTry = [
        'utf-8',
        'gbk',
        'shift-jis',
        'euc-jp',
        'iso-2022-jp',
        'big5',
        'euc-kr'
      ]
      let decoded = ''
      let usedEncoding = ''
      for (const enc of encodingsToTry) {
        try {
          const decoder = new TextDecoder(enc, { fatal: true })
          decoded = decoder.decode(buffer)
          usedEncoding = enc
          if (enc === 'utf-8' && decoded.includes('\uFFFD')) {
            decoded = ''
            continue
          }
          break
        } catch {
          continue
        }
      }

      if (!decoded) {
        const fallbackDecoder = new TextDecoder('utf-8', { fatal: false })
        decoded = fallbackDecoder.decode(buffer)
        usedEncoding = 'utf-8'
      }

      const tempDir = app.getPath('temp')
      const ext = path.extname(filePath)
      const baseName = path.basename(filePath, ext)
      const tempFilePath = path.join(tempDir, `${baseName}_preview_${Date.now()}${ext}`)
      await fs.promises.writeFile(tempFilePath, decoded, 'utf-8')
      logger.info(
        LogCategory.MAIN,
        `[预处理] 文本预览文件已处理（编码: ${usedEncoding}）: ${filePath} -> ${tempFilePath}`
      )
      return tempFilePath
    } catch (error) {
      logger.error(LogCategory.MAIN, `[预处理] 文本文件预处理失败: ${filePath}`, error)
      return filePath
    }
  })
  ipcMain.handle('delete-preprocessed-file', async (_event, filePath: string) => {
    try {
      const tempDir = app.getPath('temp')
      if (filePath.startsWith(tempDir) && filePath.includes('_preview_')) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
          logger.info(LogCategory.MAIN, `[预处理] 已成功清理预览临时文件: ${filePath}`)
        }
      }
      return { success: true }
    } catch (error) {
      logger.error(LogCategory.MAIN, `[预处理] 清理预览临时文件失败: ${filePath}`, error)
      return { success: false, error: String(error) }
    }
  })
  ipcMain.handle('detect-libreoffice', async () => {
    try {
      return await libreOfficeDetector.detectLibreOffice()
    } catch (e) {
      return { installed: false, error: String(e) }
    }
  })
  ipcMain.handle('open-external', async (event, url: string) => {
    try {
      const parsedUrl = new URL(url)
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
        return { success: false, error: t('仅允许 http: 和 https: 协议') }
      await shell.openExternal(url)
      return { success: true }
    } catch (e) {
      return { success: false, error: t('无效的 URL') }
    }
  })

  ipcMain.handle('get-resources-path', async () => {
    return ResourceLocator.getBaseResourceDir()
  })

  ipcMain.handle('core-engine-enqueue-file', async (event, input: any) => {
    if (!coreEngine) throw new Error(t('核心引擎未初始化'))
    return await coreEngine.enqueueFile(input)
  })
  ipcMain.handle('core-engine-enqueue-files', async (event, inputs: any[]) => {
    if (!coreEngine) throw new Error(t('核心引擎未初始化'))
    return await coreEngine.enqueueFiles(inputs)
  })
  ipcMain.handle('core-engine-analyze-now', async (event, fileId: number) => {
    if (!coreEngine) throw new Error(t('核心引擎未初始化'))
    return await coreEngine.analyzeNow(fileId)
  })
  ipcMain.handle('core-engine-start-queue', async () => {
    if (!coreEngine) throw new Error(t('核心引擎未初始化'))
    await coreEngine.startQueue()
  })
  ipcMain.handle('core-engine-stop-queue', async () => {
    if (!coreEngine) throw new Error(t('核心引擎未初始化'))
    await coreEngine.stopQueue()
  })
  ipcMain.handle('core-engine-get-queue-snapshot', () => coreEngine?.getQueueSnapshot())
  ipcMain.handle('core-engine-get-dimensions', async (event, language: string) =>
    coreEngine?.getDimensions(language as any)
  )
  ipcMain.handle('core-engine-approve-dimension-expansion', async (event, id: number) =>
    coreEngine?.approveDimensionExpansion(id)
  )
  ipcMain.handle(
    'core-engine-reject-dimension-expansion',
    async (event, id: number, reason: string) => coreEngine?.rejectDimensionExpansion(id, reason)
  )
  ipcMain.handle('core-engine-get-pending-expansions', async () =>
    coreEngine?.getPendingDimensionExpansions()
  )
  ipcMain.handle('core-engine-is-initialized', () => coreEngine?.isInitialized() || false)

  ipcMain.on('renderer-error', (event, errorInfo) => {
    logger.error(LogCategory.RENDERER, '渲染进程出错:', errorInfo)
  })
  ipcMain.on('open-download-page', () => {
    shell.openExternal('https://aifolder.iocn.cn/download').catch(e => {
      logger.warn(LogCategory.MAIN, '[IPC] 打开下载页面失败:', e)
    })
  })

  const currentEngine = AIEngineFactory.getAdapter().engineName
  logger.info(LogCategory.MAIN, `[IPC] 当前 AI 引擎: ${currentEngine}`)

  try {
    ModelDownloadManagerIPCHandler.getInstance()
    logger.info(LogCategory.MAIN, '[IPC] 模型下载管理 IPC 处理程序注册完成')
  } catch (error: any) {
    logger.error(LogCategory.MAIN, '[IPC] 模型下载管理 IPC 处理程序注册失败:', error)
  }

  if (currentEngine === 'ollama') {
    try {
      registerOllamaIPCHandlers()
      logger.info(LogCategory.MAIN, '[IPC] Ollama IPC 处理程序注册完成')
    } catch (error: any) {
      logger.error(LogCategory.MAIN, '[IPC] Ollama IPC 处理程序注册失败:', error)
    }
  }

  if (process.env.IS_INTEGRATION_TEST === 'true') {
    logger.info(LogCategory.MAIN, '[IPC] 集成测试模式：注册数据库直连 IPC 处理程序')
    ipcMain.handle('database/execute-get', async (event, sql: string, params: any[]) => {
      const db = databaseService.db
      if (!db) throw new Error(t('数据库未初始化'))
      const stmt = db.prepare(sql)
      return stmt.get(...params)
    })
    ipcMain.handle('database/execute-all', async (event, sql: string, params: any[]) => {
      const db = databaseService.db
      if (!db) throw new Error(t('数据库未初始化'))
      const stmt = db.prepare(sql)
      return stmt.all(...params)
    })
    ipcMain.handle('database/execute-run', async (event, sql: string, params: any[]) => {
      const db = databaseService.db
      if (!db) throw new Error(t('数据库未初始化'))
      const stmt = db.prepare(sql)
      return stmt.run(...params)
    })
    ipcMain.handle('cloud-sync/trigger-sync', async () => {
      const { cloudSyncWorker } = await import('../../runtime-services/ai/cloud-sync-worker')
      return await cloudSyncWorker.trySync()
    })
  }
}
