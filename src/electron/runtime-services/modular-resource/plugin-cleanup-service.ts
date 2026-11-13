/**
 * 插件版本淘汰与清理服务 (PluginCleanupService)
 *
 * 注：V4 为创世版本，不存在历史上线遗留包；不再执行未受管明文目录的主动全量扫描删除，
 * 避免对本地开发或受管 ONNX 资源造成误删；
 * 本服务专职负责：
 * 1. 匿名密文槽位（带 current.json）在升级换代时的超额不可变容器淘汰（保留最新 1 个历史版本供回滚）；
 * 2. 处理上一轮因 Windows EBUSY 句柄占用而积压在 pending_delete.json 中的安全删除队列。
 */

import * as fs from 'fs'
import * as path from 'path'
import { logger, LogCategory, readCurrentJsonSync } from '@firefly/shared'

export interface CleanupResult {
  removedDirs: string[]
  removedFiles: string[]
  pendingDeletions: string[]
}

/** 兼容保留空 Set，避免外部引用引发未定义异常 */
export const LEGACY_PLAINTEXT_DIRS = new Set<string>()

export class PluginCleanupService {
  /**
   * 启动期对账清理：淘汰超额历史密文容器并处理 EBUSY 积压删除队列
   *
   * @param sharedDir pluginsRootDir 下的 _shared 物理路径
   */
  public static async cleanupLegacyPlaintextAssets(sharedDir: string): Promise<CleanupResult> {
    const result: CleanupResult = {
      removedDirs: [],
      removedFiles: [],
      pendingDeletions: []
    }

    if (!sharedDir || !fs.existsSync(sharedDir)) {
      return result
    }

    const pendingDeleteFile = path.join(sharedDir, 'pending_delete.json')

    // 1. 重试上一轮因 EBUSY/EPERM 积压的删除队列
    await this.processPendingDeletions(pendingDeleteFile, result)

    try {
      const entries = await fs.promises.readdir(sharedDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const fullDirPath = path.join(sharedDir, entry.name)

        // 匿名槽位目录清理：若存在 current.json，保留活跃版本 + 最多 1 个历史版本，淘汰超额历史容器
        await this.pruneObsoleteVersionsInSlotDir(fullDirPath, pendingDeleteFile, result)
      }
    } catch (scanErr) {
      logger.warn(LogCategory.SYSTEM, '[PluginCleanup] 扫描 _shared 目录时发生非致命异常:', scanErr)
    }

    return result
  }

  /**
   * 淘汰同一匿名槽位目录下的历史多余不可变容器 (仅保留当前活跃 + 1 个最新历史版本用于回滚)
   */
  private static async pruneObsoleteVersionsInSlotDir(
    slotDir: string,
    pendingDeleteFile: string,
    result: CleanupResult
  ): Promise<void> {
    const current = readCurrentJsonSync(slotDir)
    if (!current) return

    const activeFiles = new Set<string>()
    if (current.activeFile) activeFiles.add(current.activeFile)
    if (current.activeFiles) {
      Object.values(current.activeFiles).forEach(f => activeFiles.add(f))
    }

    try {
      const files = await fs.promises.readdir(slotDir, { withFileTypes: true })
      const ffpcFiles: { name: string; fullPath: string; mtimeMs: number }[] = []

      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.ffpc')) continue
        if (activeFiles.has(f.name)) continue

        const fullPath = path.join(slotDir, f.name)
        try {
          const st = await fs.promises.stat(fullPath)
          ffpcFiles.push({ name: f.name, fullPath, mtimeMs: st.mtimeMs })
        } catch {
          // ignore stat failure
        }
      }

      // 按时间倒序排序
      ffpcFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)

      // 保留最新的 1 个历史版本，超过的予以淘汰
      const obsoleteFiles = ffpcFiles.slice(1)
      for (const item of obsoleteFiles) {
        try {
          await fs.promises.rm(item.fullPath, { force: true })
          result.removedFiles.push(item.name)
          logger.info(LogCategory.SYSTEM, `[PluginCleanup] 淘汰历史多余密文容器: ${item.name}`)
        } catch (err: any) {
          logger.warn(
            LogCategory.SYSTEM,
            `[PluginCleanup] 淘汰历史容器 ${item.name} 遭遇占用，登记重试:`,
            err?.message
          )
          await this.enqueuePendingDelete(pendingDeleteFile, item.fullPath)
          result.pendingDeletions.push(item.fullPath)
        }
      }
    } catch {
      // 容错处理
    }
  }

  /**
   * 处理待删除积压清单
   */
  private static async processPendingDeletions(
    pendingDeleteFile: string,
    result: CleanupResult
  ): Promise<void> {
    if (!fs.existsSync(pendingDeleteFile)) return

    let pendingList: string[] = []
    try {
      const raw = await fs.promises.readFile(pendingDeleteFile, 'utf-8')
      pendingList = JSON.parse(raw)
      if (!Array.isArray(pendingList)) pendingList = []
    } catch {
      pendingList = []
    }

    const stillPending: string[] = []
    for (const targetPath of pendingList) {
      if (!fs.existsSync(targetPath)) continue
      try {
        const st = await fs.promises.stat(targetPath)
        if (st.isDirectory()) {
          await fs.promises.rm(targetPath, { recursive: true, force: true })
          result.removedDirs.push(path.basename(targetPath))
        } else {
          await fs.promises.rm(targetPath, { force: true })
          result.removedFiles.push(path.basename(targetPath))
        }
        logger.info(LogCategory.SYSTEM, `[PluginCleanup] 自愈清除积压项: ${targetPath}`)
      } catch {
        stillPending.push(targetPath)
      }
    }

    try {
      if (stillPending.length > 0) {
        await fs.promises.writeFile(
          pendingDeleteFile,
          JSON.stringify(stillPending, null, 2),
          'utf-8'
        )
      } else {
        await fs.promises.rm(pendingDeleteFile, { force: true })
      }
    } catch {}
  }

  /**
   * 将因 EBUSY 未能删除的路径入队
   */
  private static async enqueuePendingDelete(
    pendingDeleteFile: string,
    targetPath: string
  ): Promise<void> {
    let pendingList: string[] = []
    try {
      if (fs.existsSync(pendingDeleteFile)) {
        const raw = await fs.promises.readFile(pendingDeleteFile, 'utf-8')
        pendingList = JSON.parse(raw)
        if (!Array.isArray(pendingList)) pendingList = []
      }
    } catch {
      pendingList = []
    }

    if (!pendingList.includes(targetPath)) {
      pendingList.push(targetPath)
    }

    try {
      await fs.promises.writeFile(pendingDeleteFile, JSON.stringify(pendingList, null, 2), 'utf-8')
    } catch {}
  }
}
