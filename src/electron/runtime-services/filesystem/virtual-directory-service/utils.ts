import { LogCategory, logger, ResourceLocator } from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import fs from 'fs-extra'
import path from 'node:path'

export const VIRTUAL_DIRECTORY_ROOT = '.VirtualDirectory'

export async function copyReadmeFile(virtualDirPath: string): Promise<void> {
  try {
    const userLanguage = ConfigOrchestrator.getInstance().getValue('DEFAULT_LANGUAGE') || 'zh-CN'
    const readmeFileName = `ReadMe_${userLanguage}.txt`
    const sourceReadmePath = ResourceLocator.resolveResourcePath(
      path.join('.VirtualDirectory', readmeFileName)
    )
    const targetReadmePath = path.join(virtualDirPath, readmeFileName)

    if (await fs.pathExists(sourceReadmePath)) {
      await fs.copy(sourceReadmePath, targetReadmePath)
    }
  } catch (error) {
    logger.error(LogCategory.VIRTUAL_DIRECTORY, `复制虚拟目录说明文件失败:`, error)
  }
}
