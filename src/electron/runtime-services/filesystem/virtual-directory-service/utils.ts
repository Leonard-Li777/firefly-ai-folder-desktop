import { LogCategory, logger, ResourceLocator } from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import fs from 'fs-extra'
import path from 'node:path'

export const VIRTUAL_DIRECTORY_ROOT = '.VirtualDirectory'

/** Windows 物理设备保留名（含扩展名形式，如 CON.txt） */
const WINDOWS_RESERVED_NAME_REGEX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 批量整理目录名安全清洗（规格 §5.4）
 *
 * - 过滤 Windows 9 大非法字符 `\ / : * ? " < > |`（替换为短横线）
 * - 拦截设备保留名并追加下划线后缀
 * - 清除首尾空格与末尾句点
 * - 最大长度严格截断为 64 字符
 * - 清洗后为空时返回 fallback
 */
export function sanitizeFolderName(
  name: string,
  fallback: string = '未命名' // locale-invariant-ok: 清洗失败的通用目录名兜底
): string {
  let sanitized = (name || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    // 反引号与全角冒号同样会在导出/同步链路引发兼容问题，一并移除
    .replace(/[`：]/g, '')
    .replace(/[\x00-\x1F]/g, '')
    .trim()
    .replace(/[\s.]+$/g, '')

  if (!sanitized) return fallback

  if (WINDOWS_RESERVED_NAME_REGEX.test(sanitized)) {
    sanitized = `${sanitized}_`
  }

  const chars = Array.from(sanitized)
  if (chars.length > 64) {
    sanitized = chars.slice(0, 64).join('').replace(/[\s.]+$/g, '')
  }

  return sanitized || fallback
}

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
