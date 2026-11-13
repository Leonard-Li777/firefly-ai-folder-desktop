/**
 * 存量明文旧缓存清理与历史版本淘汰服务 (PluginCleanupService)
 * 遵循 docs/specs/plugin-asset-encryption-spec.md §3.2.1 / §5.3 / §8 (Ticket 09)
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  logger,
  LogCategory,
  readCurrentJsonSync,
  ALL_BUILTIN_SHARED_RESOURCE_IDS,
  deriveTargetLocalPath
} from '@firefly/shared'

export interface CleanupResult {
  removedDirs: string[]
  removedFiles: string[]
  pendingDeletions: string[]
}

export const LEGACY_PLAINTEXT_DIRS = new Set([
  'embeddinggemma-2-onnx',
  'sensevoice-onnx',
  'moss-tts',
  'm5-tts',
  'chinese-clip',
  'mobile-clip',
  'nsfw-mobilenetv2',
  'nsfw-l3',
  'bekko-a8m',
  'pocket-cpu-int8-onnx',
  'sherpa-onnx-runtime'
])

export class PluginCleanupService {
  /**
   * 启动期冷扫存量明文目录与未引用的历史过期密文容器
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
        const dirName = entry.name
        const fullDirPath = path.join(sharedDir, dirName)

        // 2. 检测旧版明文目录：直接命中已知明文库，或目录下包含明文 .onnx 且无 current.json
        if (
          LEGACY_PLAINTEXT_DIRS.has(dirName) ||
          (await this.isUnmanagedPlaintextOnnxDir(fullDirPath))
        ) {
          try {
            await fs.promises.rm(fullDirPath, { recursive: true, force: true })
            result.removedDirs.push(dirName)
            logger.info(LogCategory.SYSTEM, `[PluginCleanup] 成功清除存量明文旧目录: ${dirName}`)
          } catch (err: any) {
            logger.warn(
              LogCategory.SYSTEM,
              `[PluginCleanup] 清理明文旧目录 ${dirName} 遭遇占用，登记重试:`,
              err?.message
            )
            await this.enqueuePendingDelete(pendingDeleteFile, fullDirPath)
            result.pendingDeletions.push(fullDirPath)
          }
          continue
        }

        // 3. 匿名槽位目录清理：若存在 current.json，保留活跃版本 + 最多 1 个历史版本，淘汰超额历史容器
        await this.pruneObsoleteVersionsInSlotDir(fullDirPath, pendingDeleteFile, result)
      }
    } catch (scanErr) {
      logger.warn(LogCategory.SYSTEM, '[PluginCleanup] 扫描 _shared 目录时发生非致命异常:', scanErr)
    }

    return result
  }

  /**
   * 判断是否为未受管的明文 ONNX 目录（含 .onnx 且无 current.json）
   * 严禁误伤已受管的合法规范共享子目录（如 emb-391b9a03, asr-f3b8224c 等）或已打标记的目录
   */
  private static async isUnmanagedPlaintextOnnxDir(dirPath: string): Promise<boolean> {
    try {
      const dirName = path.basename(dirPath)

      // 1. 绝对不能误删已受管的规范共享资源目录 (如 emb-391b9a03, asr-f3b8224c, tts-e43ab9e3 等)
      const isCanonical = ALL_BUILTIN_SHARED_RESOURCE_IDS.some(id => {
        const canonicalRel = deriveTargetLocalPath(id)
        return canonicalRel ? path.basename(canonicalRel) === dirName : false
      })
      if (isCanonical) {
        return false
      }

      // 2. 若存在任何就绪、核验或清单标记，说明是受管物化资源，绝对严禁当作孤儿垃圾删除
      if (
        fs.existsSync(path.join(dirPath, '.ready.json')) ||
        fs.existsSync(path.join(dirPath, '.verified')) ||
        fs.existsSync(path.join(dirPath, 'manifest.json')) ||
        fs.existsSync(path.join(dirPath, 'current.json'))
      ) {
        return false
      }

      const files = await fs.promises.readdir(dirPath)
      return files.some(f => f.endsWith('.onnx'))
    } catch {
      return false
    }
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
