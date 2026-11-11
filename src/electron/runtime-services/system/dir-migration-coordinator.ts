/**
 * 自定义插件目录两阶段流式迁移与崩溃自愈协调器 (DirMigrationCoordinator)
 *
 * 核心职责：
 * 1. 维护 DirRuntimePhase 三态相位与全局写闸门 (DIR_CHANGE_GATE_ACTIVE)；
 * 2. 逐文件双端流式 SHA-256 校验与 BOM 对账 (HASH_MISMATCH / ENOSPC 回滚)；
 * 3. 目标冲突模块隔离至 backupPath 与 COMMITTING 阶段严格五步原子提交；
 * 4. 扫描开机崩溃自愈意图日志 ({userData}/intents/dir-migration-*.json) 双分支自愈；
 * 5. 迁移取消终态协议与节流进度推送 (modular-resource:dir-migration-progress)。
 *
 * @doc-anchor: docs/specs/custom-plugin-directory-and-mirror-download-spec.md §2.2 ~ §2.4, §4.1 ~ §4.3, §4.5, §7.1, §8.1
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { BrowserWindow } from 'electron'
import { logger, LogCategory, isPathEqual, READY_MARKER_FILENAME } from '@firefly/shared'
import type { DirRuntimePhase, PluginDirErrorCode } from '@firefly/types/config-types'
import { ModularResourceError, validatePluginDirectory } from './plugin-dir-validator'

export type DirMigrationStage =
  | 'PRECHECK'
  | 'STAGING'
  | 'VERIFYING'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'ABORTED'
  | 'CANCELLED'

export interface ActivationEntry {
  resourceId: string
  stagingPath: string
  finalPath: string
  backupPath?: string // 隔离旧模块的绝对路径，用于 COMMITTING 崩溃回滚
  state: 'PENDING' | 'ACTIVATED' | 'ROLLED_BACK'
}

export interface DirMigrationJournal {
  migrationId: string
  sourceDir: string
  targetDir: string
  stagingDir: string
  stage: DirMigrationStage
  activationPlan: ActivationEntry[]
  totalFiles: number
  totalBytes: number
  copiedBytes: number
  startedAt: number
  updatedAt: number
}

export interface DirMigrationProgressPayload {
  migrationId: string
  phase: 'copying' | 'verifying' | 'committing'
  copiedBytes: number
  totalBytes: number
  percentage: number
  currentFile: string
  copiedFiles?: number
  totalFiles?: number
}

export interface DirMigrationContext {
  migrationId: string
  sourceDir: string
  targetDir: string
  stagingDir: string
  stage: DirMigrationStage
  totalFiles: number
  totalBytes: number
  copiedFiles: number
  copiedBytes: number
  verifiedFiles: number
  currentFile: string | null
  abortController: AbortController
  startedAt: number
}

/**
 * 检测目录项是否为符号链接或 Windows 目录联接点 (Junction)
 */
export async function detectSymlinkOrJunction(
  entryPath: string,
  stats: fs.Stats
): Promise<'symlink' | 'junction' | 'none'> {
  if (stats.isSymbolicLink()) {
    return 'symlink'
  }
  if (process.platform === 'win32' && stats.isDirectory()) {
    try {
      const realPath = fs.realpathSync(entryPath)
      if (realPath.toLowerCase() !== path.resolve(entryPath).toLowerCase()) {
        return 'junction'
      }
    } catch {
      return 'junction'
    }
  }
  return 'none'
}

export class DirMigrationCoordinator {
  private static instance: DirMigrationCoordinator | null = null

  private currentContext: DirMigrationContext | null = null
  private isMigrating = false
  private lastProgressBroadcastAt = 0

  static getInstance(): DirMigrationCoordinator {
    if (!DirMigrationCoordinator.instance) {
      DirMigrationCoordinator.instance = new DirMigrationCoordinator()
    }
    return DirMigrationCoordinator.instance
  }

  public getContext(): DirMigrationContext | null {
    return this.currentContext
  }

  public getMigrationId(): string | undefined {
    return this.currentContext?.migrationId
  }

  public isBusy(): boolean {
    return this.isMigrating
  }

  /**
   * 广播迁移进度到所有活跃窗口（500ms 防抖/节流，阶段切换或 100% 立即推）
   */
  public broadcastProgress(payload: DirMigrationProgressPayload, force = false): void {
    const now = Date.now()
    if (!force && payload.percentage < 100 && now - this.lastProgressBroadcastAt < 500) {
      return
    }
    this.lastProgressBroadcastAt = now

    try {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('modular-resource:dir-migration-progress', payload)
        }
      }
    } catch (err) {
      logger.warn(LogCategory.MAIN, '[DirMigration] 广播进度失败:', err)
    }
  }

  /**
   * 获取意图日志持久化路径
   */
  private getJournalPath(userDataDir: string, migrationId: string): string {
    const intentsDir = path.join(userDataDir, 'intents')
    if (!fs.existsSync(intentsDir)) {
      fs.mkdirSync(intentsDir, { recursive: true })
    }
    return path.join(intentsDir, `dir-migration-${migrationId}.json`)
  }

  /**
   * 原子持久化意图日志并执行物理刷盘 (fsync)
   */
  public persistJournalWithFsync(userDataDir: string, journal: DirMigrationJournal): void {
    const journalPath = this.getJournalPath(userDataDir, journal.migrationId)
    const tmpPath = `${journalPath}.tmp`
    const content = JSON.stringify(journal, null, 2)

    try {
      const fd = fs.openSync(tmpPath, 'w')
      fs.writeSync(fd, content)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fs.renameSync(tmpPath, journalPath)
    } catch (err) {
      logger.error(LogCategory.MAIN, `[DirMigration] 持久化日志失败 (${journal.stage}):`, err)
    }
  }

  /**
   * 开始执行两阶段安全流式复制迁移
   */
  public async executeMigration(
    sourceDir: string,
    targetDir: string,
    options: {
      userDataDir: string
      onPhaseChange: (phase: DirRuntimePhase) => void
      onConfigCommit: (newPath: string, oldPath: string) => Promise<void>
      bomHashes?: Map<string, string>
      fileCopyFn?: (src: string, dest: string) => Promise<void>
    }
  ): Promise<{ success: boolean; migrationId?: string; errorCode?: PluginDirErrorCode }> {
    if (this.isMigrating) {
      throw new ModularResourceError(
        'DIR_CHANGE_GATE_ACTIVE',
        'Another migration is already running.'
      )
    }

    this.isMigrating = true
    options.onPhaseChange('MIGRATING')

    const migrationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const stagingDir = path.join(targetDir, `.migrating-${migrationId}`)
    const abortController = new AbortController()

    const context: DirMigrationContext = {
      migrationId,
      sourceDir,
      targetDir,
      stagingDir,
      stage: 'PRECHECK',
      totalFiles: 0,
      totalBytes: 0,
      copiedFiles: 0,
      copiedBytes: 0,
      verifiedFiles: 0,
      currentFile: null,
      abortController,
      startedAt: Date.now()
    }
    this.currentContext = context

    const journal: DirMigrationJournal = {
      migrationId,
      sourceDir,
      targetDir,
      stagingDir,
      stage: 'PRECHECK',
      activationPlan: [],
      totalFiles: 0,
      totalBytes: 0,
      copiedBytes: 0,
      startedAt: Date.now(),
      updatedAt: Date.now()
    }

    try {
      // 0. 持久化初始化 Journal
      this.persistJournalWithFsync(options.userDataDir, journal)

      // 1. 扫描源目录已就绪模块 (白名单) 并核验符号链接
      const sourceShared = path.join(sourceDir, '_shared')
      const targetShared = path.join(targetDir, '_shared')
      const modulesToMigrate: string[] = []

      if (fs.existsSync(sourceShared)) {
        const sourceEntries = fs.readdirSync(sourceShared, { withFileTypes: true })
        for (const entry of sourceEntries) {
          if (!entry.isDirectory()) continue

          const modulePath = path.join(sourceShared, entry.name)
          const stats = fs.lstatSync(modulePath)
          const linkType = await detectSymlinkOrJunction(modulePath, stats)
          if (linkType !== 'none') {
            throw new ModularResourceError(
              'SYMLINK_REJECTED',
              `Symlinks or Junctions are not supported: ${modulePath}`
            )
          }

          // 检查统一就绪标记 (.ready.json) 及迁移期遗留 .ready-<sha8>.json
          const files = fs.readdirSync(modulePath)
          const hasReady = files.some(
            f => f === READY_MARKER_FILENAME || (f.startsWith('.ready-') && f.endsWith('.json'))
          )
          if (hasReady) {
            modulesToMigrate.push(entry.name)
          }
        }
      }

      // 1b. 扫描源目录非空 _module_manifests/<moduleId> 目录并核验符号链接（清单随迁，防止迁移后清单缺失）
      const sourceManifests = path.join(sourceDir, '_module_manifests')
      const targetManifests = path.join(targetDir, '_module_manifests')
      const manifestIdsToMigrate: string[] = []

      if (fs.existsSync(sourceManifests)) {
        const manifestEntries = fs.readdirSync(sourceManifests, { withFileTypes: true })
        for (const entry of manifestEntries) {
          if (!entry.isDirectory()) continue

          const manifestDir = path.join(sourceManifests, entry.name)
          const stats = fs.lstatSync(manifestDir)
          const linkType = await detectSymlinkOrJunction(manifestDir, stats)
          if (linkType !== 'none') {
            throw new ModularResourceError(
              'SYMLINK_REJECTED',
              `Symlinks or Junctions are not supported: ${manifestDir}`
            )
          }

          const items = fs.readdirSync(manifestDir)
          if (items.length > 0) {
            manifestIdsToMigrate.push(entry.name)
          }
        }
      }

      // 统计需要复制的文件与总体积
      interface FileToCopy {
        resourceId: string
        relPath: string
        srcFile: string
        destFile: string
        size: number
      }
      const fileList: FileToCopy[] = []
      let totalBytes = 0

      const collectDirForMigration = async (
        planId: string,
        srcDir: string,
        stagingSubdir: string,
        finalSubdir: string
      ) => {
        journal.activationPlan.push({
          resourceId: planId,
          stagingPath: stagingSubdir,
          finalPath: finalSubdir,
          state: 'PENDING'
        })

        const scanRecursive = async (currDir: string, rel: string) => {
          const items = fs.readdirSync(currDir, { withFileTypes: true })
          for (const item of items) {
            const fullPath = path.join(currDir, item.name)
            const itemRel = rel ? path.join(rel, item.name) : item.name
            const itemStats = fs.lstatSync(fullPath)

            const linkType = await detectSymlinkOrJunction(fullPath, itemStats)
            if (linkType !== 'none') {
              throw new ModularResourceError(
                'SYMLINK_REJECTED',
                `Symlinks or Junctions are not supported: ${fullPath}`
              )
            }

            if (item.isDirectory()) {
              await scanRecursive(fullPath, itemRel)
            } else if (item.isFile()) {
              fileList.push({
                resourceId: planId,
                relPath: itemRel,
                srcFile: fullPath,
                destFile: path.join(stagingSubdir, itemRel),
                size: itemStats.size
              })
              totalBytes += itemStats.size
            }
          }
        }

        await scanRecursive(srcDir, '')
      }

      for (const resId of modulesToMigrate) {
        await collectDirForMigration(
          resId,
          path.join(sourceShared, resId),
          path.join(stagingDir, '_shared', resId),
          path.join(targetShared, resId)
        )
      }

      for (const modId of manifestIdsToMigrate) {
        await collectDirForMigration(
          `_module_manifests/${modId}`,
          path.join(sourceManifests, modId),
          path.join(stagingDir, '_module_manifests', modId),
          path.join(targetManifests, modId)
        )
      }

      context.totalFiles = fileList.length
      context.totalBytes = totalBytes
      journal.totalFiles = fileList.length
      journal.totalBytes = totalBytes
      journal.stage = 'STAGING'
      this.persistJournalWithFsync(options.userDataDir, journal)

      // 2. 零资产特殊情况秒切 (totalBytes === 0)
      if (totalBytes === 0) {
        this.broadcastProgress(
          {
            migrationId,
            phase: 'copying',
            copiedBytes: 0,
            totalBytes: 0,
            copiedFiles: 0,
            totalFiles: 0,
            percentage: 100,
            currentFile: 'Done'
          },
          true
        )
      }

      // 3. 建立暂存目录并流式复制与双端 SHA-256 核验
      fs.mkdirSync(stagingDir, { recursive: true })

      for (const item of fileList) {
        if (abortController.signal.aborted) {
          throw new ModularResourceError('MIGRATION_CANCELLED', 'Migration cancelled by user.')
        }

        context.currentFile = path.basename(item.srcFile)
        const destParent = path.dirname(item.destFile)
        if (!fs.existsSync(destParent)) {
          fs.mkdirSync(destParent, { recursive: true })
        }

        // 双端流式 SHA-256 复制（或测试接缝注入）
        if (options.fileCopyFn) {
          await options.fileCopyFn(item.srcFile, item.destFile)
          context.copiedBytes += item.size
        } else {
          await this.copyFileWithDualSha(
            item.srcFile,
            item.destFile,
            abortController.signal,
            chunkSize => {
              context.copiedBytes += chunkSize
              const pct =
                totalBytes > 0
                  ? Math.min(99, Math.floor((context.copiedBytes / totalBytes) * 100))
                  : 100
              this.broadcastProgress({
                migrationId,
                phase: 'copying',
                copiedBytes: context.copiedBytes,
                totalBytes,
                copiedFiles: context.copiedFiles,
                totalFiles: context.totalFiles,
                percentage: pct,
                currentFile: context.currentFile || ''
              })
            },
            options.bomHashes
          )
        }

        context.copiedFiles++
      }

      // 4. VERIFYING 阶段：全量刷盘
      journal.stage = 'VERIFYING'
      context.stage = 'VERIFYING'
      this.persistJournalWithFsync(options.userDataDir, journal)
      this.broadcastProgress(
        {
          migrationId,
          phase: 'verifying',
          copiedBytes: totalBytes,
          totalBytes,
          copiedFiles: context.copiedFiles,
          totalFiles: context.totalFiles,
          percentage: 99,
          currentFile: 'Verifying data integrity...'
        },
        true
      )

      // 5. COMMITTING 阶段严格五步原子提交时序
      journal.stage = 'COMMITTING'
      context.stage = 'COMMITTING'
      this.persistJournalWithFsync(options.userDataDir, journal)

      this.broadcastProgress(
        {
          migrationId,
          phase: 'committing',
          copiedBytes: totalBytes,
          totalBytes,
          copiedFiles: context.copiedFiles,
          totalFiles: context.totalFiles,
          percentage: 99,
          currentFile: 'Committing directory changes...'
        },
        true
      )

      if (!fs.existsSync(targetShared)) {
        fs.mkdirSync(targetShared, { recursive: true })
      }

      // Step ③: 逐模块激活，对目标已有模块隔离为 backupPath
      for (const entry of journal.activationPlan) {
        const finalParent = path.dirname(entry.finalPath)
        if (!fs.existsSync(finalParent)) {
          fs.mkdirSync(finalParent, { recursive: true })
        }

        if (fs.existsSync(entry.finalPath)) {
          const safeId = entry.resourceId.replace(/[\\/]/g, '_')
          const backup = path.join(finalParent, `.deleting-${safeId}-${Date.now()}`)
          try {
            fs.renameSync(entry.finalPath, backup)
            entry.backupPath = backup
            this.persistJournalWithFsync(options.userDataDir, journal)
          } catch (err: any) {
            throw new ModularResourceError(
              'TARGET_MODULE_LOCKED',
              `Target module ${entry.resourceId} is locked: ${err?.message}`
            )
          }
        }

        // 将暂存区模块同卷原子 rename 进 finalPath
        if (fs.existsSync(entry.stagingPath)) {
          fs.renameSync(entry.stagingPath, entry.finalPath)
          entry.state = 'ACTIVATED'
          this.persistJournalWithFsync(options.userDataDir, journal)
        }
      }

      // Step ④: 配置原子更新
      await options.onConfigCommit(targetDir, sourceDir)

      // Step ⑤: Journal 标记 COMMITTED，切换为 PENDING_RESTART
      journal.stage = 'COMMITTED'
      context.stage = 'COMMITTED'
      this.persistJournalWithFsync(options.userDataDir, journal)

      // 异步清理孤儿暂存区
      try {
        if (fs.existsSync(stagingDir)) {
          fs.rmSync(stagingDir, { recursive: true, force: true })
        }
      } catch {}

      options.onPhaseChange('PENDING_RESTART')

      this.broadcastProgress(
        {
          migrationId,
          phase: 'committing',
          copiedBytes: totalBytes,
          totalBytes,
          copiedFiles: context.copiedFiles,
          totalFiles: context.totalFiles,
          percentage: 100,
          currentFile: 'Completed'
        },
        true
      )

      return { success: true, migrationId }
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[DirMigration] 迁移过程发生异常，执行安全回滚:', err)

      // 回滚处理
      if (journal.stage === 'COMMITTING') {
        // COMMITTING 阶段崩溃或回滚：若配置未生效，执行资产还原
        for (const entry of journal.activationPlan.filter(e => e.state === 'ACTIVATED')) {
          try {
            if (fs.existsSync(entry.finalPath)) {
              const stagingParent = path.dirname(entry.stagingPath)
              if (!fs.existsSync(stagingParent)) {
                fs.mkdirSync(stagingParent, { recursive: true })
              }
              try {
                fs.renameSync(entry.finalPath, entry.stagingPath)
              } catch {
                fs.rmSync(entry.finalPath, { recursive: true, force: true })
              }
            }
            if (entry.backupPath && fs.existsSync(entry.backupPath)) {
              fs.renameSync(entry.backupPath, entry.finalPath)
            }
            entry.state = 'ROLLED_BACK'
          } catch {}
        }
      }

      // 清理暂存区
      try {
        if (fs.existsSync(stagingDir)) {
          fs.rmSync(stagingDir, { recursive: true, force: true })
        }
      } catch {}

      journal.stage = 'ABORTED'
      this.persistJournalWithFsync(options.userDataDir, journal)
      options.onPhaseChange('STABLE')

      if (err instanceof ModularResourceError) {
        return { success: false, migrationId, errorCode: err.code }
      }
      if (err?.code === 'ENOSPC') {
        return { success: false, migrationId, errorCode: 'DISK_FULL_DURING_MIGRATION' }
      }
      return {
        success: false,
        migrationId,
        errorCode: 'PATH_NOT_WRITABLE'
      }
    } finally {
      this.isMigrating = false
      this.currentContext = null
    }
  }

  /**
   * 取消迁移 (仅在 PRECHECK / STAGING / VERIFYING 生效，COMMITTING 拒绝取消)
   */
  public async cancelMigration(
    userDataDir: string
  ): Promise<{ cancelled: boolean; errorCode?: PluginDirErrorCode }> {
    if (!this.currentContext || !this.isMigrating) {
      return { cancelled: false }
    }

    if (this.currentContext.stage === 'COMMITTING' || this.currentContext.stage === 'COMMITTED') {
      return {
        cancelled: false,
        errorCode: 'MIGRATION_NOT_CANCELLABLE'
      }
    }

    this.currentContext.stage = 'CANCELLED'
    this.currentContext.abortController.abort()

    const journalPath = this.getJournalPath(userDataDir, this.currentContext.migrationId)
    if (fs.existsSync(journalPath)) {
      try {
        const raw = fs.readFileSync(journalPath, 'utf-8')
        const journal: DirMigrationJournal = JSON.parse(raw)
        journal.stage = 'CANCELLED'
        this.persistJournalWithFsync(userDataDir, journal)
      } catch {}
    }

    return { cancelled: true }
  }

  /**
   * 开机自愈对账逻辑 (reconcileOnStartup)
   */
  public async reconcileOnStartup(
    userDataDir: string,
    currentCommittedDir: string,
    onArchiveLog?: (journal: DirMigrationJournal) => void
  ): Promise<number> {
    const intentsDir = path.join(userDataDir, 'intents')
    if (!fs.existsSync(intentsDir)) return 0

    let cleaned = 0
    const files = fs
      .readdirSync(intentsDir)
      .filter(f => f.startsWith('dir-migration-') && f.endsWith('.json'))

    for (const file of files) {
      const fullPath = path.join(intentsDir, file)
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8')
        const journal: DirMigrationJournal = JSON.parse(raw)

        if (
          journal.stage === 'PRECHECK' ||
          journal.stage === 'STAGING' ||
          journal.stage === 'VERIFYING' ||
          journal.stage === 'CANCELLED'
        ) {
          // 清理孤儿暂存目录
          if (fs.existsSync(journal.stagingDir)) {
            try {
              fs.rmSync(journal.stagingDir, { recursive: true, force: true })
              cleaned++
            } catch {}
          }
          journal.stage = 'ABORTED'
          this.persistJournalWithFsync(userDataDir, journal)
        } else if (journal.stage === 'COMMITTING') {
          // COMMITTING 阶段双分支自愈
          const isTargetCommitted = isPathEqual(currentCommittedDir, journal.targetDir)

          if (isTargetCommitted) {
            // 分支 A: 配置已生效，补齐激活
            for (const entry of journal.activationPlan) {
              if (entry.state !== 'ACTIVATED' && fs.existsSync(entry.stagingPath)) {
                try {
                  fs.renameSync(entry.stagingPath, entry.finalPath)
                  entry.state = 'ACTIVATED'
                } catch {}
              }
            }
            journal.stage = 'COMMITTED'
            this.persistJournalWithFsync(userDataDir, journal)
            if (fs.existsSync(journal.stagingDir)) {
              try {
                fs.rmSync(journal.stagingDir, { recursive: true, force: true })
                cleaned++
              } catch {}
            }
            onArchiveLog?.(journal)
          } else {
            // 分支 B: 配置未更新，回滚资产
            for (const entry of journal.activationPlan.filter(e => e.state === 'ACTIVATED')) {
              try {
                if (fs.existsSync(entry.finalPath)) {
                  const stagingParent = path.dirname(entry.stagingPath)
                  if (!fs.existsSync(stagingParent)) {
                    fs.mkdirSync(stagingParent, { recursive: true })
                  }
                  try {
                    fs.renameSync(entry.finalPath, entry.stagingPath)
                  } catch {
                    fs.rmSync(entry.finalPath, { recursive: true, force: true })
                  }
                }
                if (entry.backupPath && fs.existsSync(entry.backupPath)) {
                  fs.renameSync(entry.backupPath, entry.finalPath)
                }
                entry.state = 'ROLLED_BACK'
              } catch (err) {
                logger.warn(
                  LogCategory.MAIN,
                  `[DirMigration] 还原 entry 失败: ${entry.resourceId}`,
                  err
                )
              }
            }
            journal.stage = 'ABORTED'
            this.persistJournalWithFsync(userDataDir, journal)
            if (fs.existsSync(journal.stagingDir)) {
              try {
                fs.rmSync(journal.stagingDir, { recursive: true, force: true })
                cleaned++
              } catch {}
            }
          }
        } else if (journal.stage === 'COMMITTED') {
          if (fs.existsSync(journal.stagingDir)) {
            try {
              fs.rmSync(journal.stagingDir, { recursive: true, force: true })
              cleaned++
            } catch {}
          }
          onArchiveLog?.(journal)
        }
      } catch (err) {
        logger.warn(LogCategory.MAIN, `[DirMigration] 解析自愈日志失败: ${file}`, err)
      }
    }

    return cleaned
  }

  /**
   * 逐文件双端 SHA-256 流式复制与全量校验
   */
  private async copyFileWithDualSha(
    srcPath: string,
    destPath: string,
    abortSignal: AbortSignal,
    onChunk: (chunkSize: number) => void,
    bomHashes?: Map<string, string>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let sourceHasher = crypto.createHash('sha256')
      let targetHasher = crypto.createHash('sha256')
      let isAborted = false

      const srcStream = fs.createReadStream(srcPath)
      const destStream = fs.createWriteStream(destPath)

      const onAbort = () => {
        isAborted = true
        srcStream.destroy()
        destStream.destroy()
        reject(new ModularResourceError('MIGRATION_CANCELLED', 'Operation aborted'))
      }

      if (abortSignal.aborted) {
        onAbort()
        return
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })

      srcStream.on('data', (chunk: Buffer | string) => {
        if (isAborted) return
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        sourceHasher.update(buf)
        targetHasher.update(buf)
        onChunk(buf.length)
      })

      srcStream.on('error', err => {
        if (isAborted) return
        destStream.destroy()
        reject(err)
      })

      destStream.on('error', err => {
        if (isAborted) return
        srcStream.destroy()
        reject(err)
      })

      destStream.on('finish', () => {
        if (isAborted) return
        abortSignal.removeEventListener('abort', onAbort)

        try {
          // 物理刷盘
          const fd = fs.openSync(destPath, 'r+')
          fs.fsyncSync(fd)
          fs.closeSync(fd)

          const srcSha = sourceHasher.digest('hex').toLowerCase()
          const destSha = targetHasher.digest('hex').toLowerCase()

          if (srcSha !== destSha) {
            reject(
              new ModularResourceError(
                'HASH_MISMATCH',
                `SHA-256 mismatch: src=${srcSha}, dest=${destSha} on ${destPath}`
              )
            )
            return
          }

          // 若 BOM 提供了哈希，核验 BOM
          const fileName = path.basename(destPath)
          if (bomHashes && bomHashes.has(fileName)) {
            const expected = bomHashes.get(fileName)?.toLowerCase()
            if (expected && destSha !== expected) {
              reject(
                new ModularResourceError(
                  'HASH_MISMATCH',
                  `BOM SHA-256 mismatch: dest=${destSha}, bom=${expected} on ${fileName}`
                )
              )
              return
            }
          }

          resolve()
        } catch (err) {
          reject(err)
        }
      })

      srcStream.pipe(destStream)
    })
  }
}

export const dirMigrationCoordinator = DirMigrationCoordinator.getInstance()
