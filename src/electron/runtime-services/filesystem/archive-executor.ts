/**
 * 物理文件归档执行器 (Archive Executor)
 * 遵循 Spec v1.1 §4.3 与 Issue 12b 规范：
 * 统一收敛所有物理文件移动/重命名操作，强制前置 assertPathWithinRoot 安全网关，
 * 并提供完备的撤销快照 (Undo) 与数据库路径同步机制
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  logger,
  LogCategory,
  assertPathWithinRoot,
  resolveUniquePath,
  SecurityViolationError
} from '@firefly/shared'
import { databaseService } from '../database/database-service'

export interface ArchiveExecutionItem {
  fileId: number
  sourcePath: string
  targetPath: string
}

export interface ArchiveExecutionResult {
  succeeded: Array<{ fileId: number; oldPath: string; newPath: string }>
  failed: Array<{ fileId: number; sourcePath: string; targetPath: string; error: string }>
}

export interface ArchiveUndoRecord {
  fileId?: number
  oldPath: string
  newPath: string
}

export class ArchiveExecutor {
  constructor(private workspaceRoot: string) {}

  /**
   * 批量物理执行归档计划
   *
   * 流程保证：
   * 1. 强制断言：所有 targetPath 必须通过 assertPathWithinRoot 网关，任何逃逸行为立即阻断并记录失败
   * 2. 冲突解决：若目标物理路径已存在，通过 resolveUniquePath 自动递增编号 (_1, _2)，绝不覆盖现有文件
   * 3. 原子重命名：创建目标目录并执行物理重命名
   * 4. 数据库同步：级联更新 databaseService 中记录的路径
   */
  async execute(items: ArchiveExecutionItem[]): Promise<ArchiveExecutionResult> {
    const succeeded: ArchiveExecutionResult['succeeded'] = []
    const failed: ArchiveExecutionResult['failed'] = []

    logger.info(
      LogCategory.FILE_ORGANIZATION,
      `[归档执行器] 开始批量执行物理文件归档 (工作区: ${this.workspaceRoot}, 总数: ${items.length})`
    )

    for (const item of items) {
      try {
        // 1. 物理执行安全网关绝对前置双向断言 (源路径与目标路径均严禁越出工作区)
        const safeSource = await assertPathWithinRoot(this.workspaceRoot, item.sourcePath)
        const safeTarget = await assertPathWithinRoot(this.workspaceRoot, item.targetPath)

        // 2. 验证源文件存在性
        if (!fs.existsSync(safeSource)) {
          failed.push({
            fileId: item.fileId,
            sourcePath: item.sourcePath,
            targetPath: item.targetPath,
            error: `源文件不存在: ${safeSource}`
          })
          continue
        }

        // 3. 目标路径防重名冲突处理
        const finalTarget = resolveUniquePath(safeTarget)

        // 4. 若源路径与目标路径完全相同，跳过物理移动
        if (path.resolve(safeSource) === path.resolve(finalTarget)) {
          succeeded.push({
            fileId: item.fileId,
            oldPath: safeSource,
            newPath: finalTarget
          })
          continue
        }

        // 5. 确保目标目录已递归创建
        const targetDir = path.dirname(finalTarget)
        if (!fs.existsSync(targetDir)) {
          await fs.promises.mkdir(targetDir, { recursive: true })
        }

        // 6. 执行物理文件重命名 / 移动
        await fs.promises.rename(safeSource, finalTarget)

        // 7. 级联同步数据库中的文件路径
        try {
          await databaseService.updateFilePath(safeSource, finalTarget)
        } catch (dbErr) {
          logger.warn(
            LogCategory.FILE_ORGANIZATION,
            `[归档执行器] 更新数据库文件路径时产生告警: ${safeSource} -> ${finalTarget}`,
            dbErr
          )
        }

        succeeded.push({
          fileId: item.fileId,
          oldPath: safeSource,
          newPath: finalTarget
        })
      } catch (err: any) {
        const errorMsg =
          err instanceof SecurityViolationError
            ? `[安全阻断] ${err.message}`
            : err?.message || String(err)

        logger.error(
          LogCategory.FILE_ORGANIZATION,
          `[归档执行器] 文件物理归档失败: ${item.sourcePath} -> ${item.targetPath}`,
          err
        )

        failed.push({
          fileId: item.fileId,
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
          error: errorMsg
        })
      }
    }

    logger.info(
      LogCategory.FILE_ORGANIZATION,
      `[归档执行器] 批量物理文件归档完成 (成功: ${succeeded.length}, 失败: ${failed.length})`
    )

    return { succeeded, failed }
  }

  /**
   * 一键撤销物理文件移动
   * 按照逆序将新文件还原至原路径，并同步数据库
   */
  async undo(records: ArchiveUndoRecord[]): Promise<{ success: number; failed: number }> {
    let success = 0
    let failed = 0

    // 逆序回退
    const reversed = [...records].reverse()

    for (const record of reversed) {
      try {
        // 双向安全断言：待还原目标路径与历史源路径均必须受控于工作区
        const safeOriginalPath = await assertPathWithinRoot(this.workspaceRoot, record.oldPath)
        const safeCurrentPath = await assertPathWithinRoot(this.workspaceRoot, record.newPath)

        if (!fs.existsSync(safeCurrentPath)) {
          logger.warn(
            LogCategory.FILE_ORGANIZATION,
            `[归档撤销] 目标文件已不存在，跳过回退: ${safeCurrentPath}`
          )
          failed++
          continue
        }

        const originalDir = path.dirname(safeOriginalPath)
        if (!fs.existsSync(originalDir)) {
          await fs.promises.mkdir(originalDir, { recursive: true })
        }

        await fs.promises.rename(safeCurrentPath, safeOriginalPath)

        try {
          await databaseService.updateFilePath(safeCurrentPath, safeOriginalPath)
        } catch (dbErr) {
          logger.warn(
            LogCategory.FILE_ORGANIZATION,
            `[归档撤销] 更新数据库文件路径告警: ${safeCurrentPath} -> ${safeOriginalPath}`,
            dbErr
          )
        }

        success++
      } catch (err) {
        logger.error(
          LogCategory.FILE_ORGANIZATION,
          `[归档撤销] 还原文件失败: ${record.newPath} -> ${record.oldPath}`,
          err
        )
        failed++
      }
    }

    return { success, failed }
  }
}
