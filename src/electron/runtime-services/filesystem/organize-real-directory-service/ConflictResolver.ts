import fs from 'node:fs'
import path from 'node:path'
import {
  FileOperation,
  FileConflict,
  ConflictResolutionOptions
} from '@firefly/types/organize-types'
import { LogCategory, logger } from '@firefly/shared'

export class ConflictResolver {
  detectConflicts(fileOperations: FileOperation[]): FileConflict[] {
    const conflicts: FileConflict[] = []

    for (const op of fileOperations) {
      if (fs.existsSync(op.newPath)) {
        try {
          if (!fs.existsSync(op.oldPath)) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '检测冲突时发现源文件不存在，无法比较', {
              operation: op
            })
            continue
          }
          const existingStats = fs.statSync(op.newPath)
          const newStats = fs.statSync(op.oldPath)

          if (existingStats.ino === newStats.ino && existingStats.dev === newStats.dev) {
            continue
          }

          conflicts.push({
            targetPath: op.newPath,
            existingFile: {
              path: op.newPath,
              size: existingStats.size,
              modifiedAt: existingStats.mtime
            },
            newFile: {
              path: op.oldPath,
              size: newStats.size,
              modifiedAt: newStats.mtime
            },
            conflictType: 'name'
          })
        } catch (error: any) {
          logger.error(LogCategory.FILE_ORGANIZATION, '检测冲突时出错', {
            operation: op,
            error: error.message
          })
        }
      }
    }

    return conflicts
  }

  generateNewPath(originalPath: string, pattern: 'number' | 'timestamp' | 'source'): string {
    const dir = path.dirname(originalPath)
    const ext = path.extname(originalPath)
    const basename = path.basename(originalPath, ext)

    switch (pattern) {
      case 'number': {
        let counter = 1
        let newPath = originalPath
        while (fs.existsSync(newPath)) {
          newPath = path.join(dir, `${basename} (${counter})${ext}`)
          counter++
        }
        return newPath
      }
      case 'timestamp': {
        const timestamp =
          new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] +
          '_' +
          new Date().toISOString().split('T')[1].split('.')[0].replace(/:/g, '')
        return path.join(dir, `${basename}_${timestamp}${ext}`)
      }
      case 'source': {
        const sourceDir = path.basename(path.dirname(originalPath))
        return path.join(dir, `${basename}_${sourceDir}${ext}`)
      }
      default:
        return originalPath
    }
  }

  async resolveConflicts(
    fileOperations: FileOperation[],
    conflicts: FileConflict[],
    resolution: ConflictResolutionOptions,
    createBackup: (path: string) => string
  ): Promise<FileOperation[]> {
    try {
      logger.info(LogCategory.FILE_ORGANIZATION, '应用冲突解决方案', {
        conflictCount: conflicts.length,
        action: resolution.action,
        applyToAll: resolution.applyToAll
      })

      const resolvedOperations = [...fileOperations]

      if (resolution.applyToAll) {
        for (const conflict of conflicts) {
          const operation = resolvedOperations.find(op => op.newPath === conflict.targetPath)
          if (operation) {
            switch (resolution.action) {
              case 'rename':
                operation.newPath = this.generateNewPath(
                  operation.newPath,
                  resolution.renamePattern || 'number'
                )
                break
              case 'skip': {
                const index = resolvedOperations.indexOf(operation)
                resolvedOperations.splice(index, 1)
                break
              }
              case 'overwrite': {
                const backupPath = createBackup(conflict.existingFile.path)
                logger.info(LogCategory.FILE_ORGANIZATION, '备份现有文件', {
                  original: conflict.existingFile.path,
                  backup: backupPath
                })
                break
              }
            }
          }
        }
      }
      return resolvedOperations
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '应用冲突解决方案失败', {
        error: error.message
      })
      throw error
    }
  }
}
