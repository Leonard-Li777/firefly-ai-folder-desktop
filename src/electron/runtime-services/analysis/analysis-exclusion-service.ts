/**
 * AI 分析排除规则服务 (Analysis Exclusion Service)
 * 负责加载和应用系统硬排除与用户排除规则
 *
 * 规则存储：使用统一配置系统 (ConfigOrchestrator)
 */

import type { IIgnoreRule } from '@firefly/types/settings-types'
import {
  filterExcludedFilesByRules,
  filterIgnoredFilesByRules,
  logger,
  LogCategory,
  shouldExcludeFileByRules,
  shouldIgnoreFileByRules
} from '@firefly/shared'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { defaultUnifiedConfig } from '../../config/config.default'

/**
 * 获取系统预设的排除规则
 */
export function getSystemExclusionRules(): IIgnoreRule[] {
  try {
    const rules = (defaultUnifiedConfig.analysis?.IGNORE_RULES ?? []) as IIgnoreRule[]
    return Array.isArray(rules) ? rules.filter(r => r.isSystem) : []
  } catch (error) {
    logger.error(LogCategory.SETTING, '[ExclusionRules] 获取系统排除规则失败:', error)
    return []
  }
}

/**
 * 加载排除规则配置（从统一配置）
 */
export function loadExclusionRules(): IIgnoreRule[] {
  try {
    // 1. 从统一配置中获取当前保存的规则（包括已持久化的用户规则和系统规则）
    let rules = ConfigOrchestrator.getInstance().getValue<IIgnoreRule[]>('IGNORE_RULES')

    // 2. 获取系统默认规则作为参考和兜底
    const systemRules = getSystemExclusionRules()

    // 3. 如果当前配置中没有规则（undefined、null 或空数组），则使用系统默认规则
    if (!Array.isArray(rules) || rules.length === 0) {
      logger.info(LogCategory.SETTING, '[ExclusionRules] 配置中没有规则，使用系统默认规则')
      return systemRules
    }

    // 4. 确保所有系统内置规则始终存在（防止配置损坏导致内置规则丢失）
    const currentRuleIds = new Set(rules.map(r => r.id))
    const missingSystemRules = systemRules.filter(sr => !currentRuleIds.has(sr.id))

    if (missingSystemRules.length > 0) {
      logger.info(LogCategory.SETTING, '[ExclusionRules] 检测到缺失的系统规则，已自动补充', {
        missingCount: missingSystemRules.length
      })
      rules = [...rules, ...missingSystemRules]
    }

    return rules
  } catch (error) {
    logger.error(LogCategory.SETTING, '[ExclusionRules] 加载排除规则失败:', error)
    return getSystemExclusionRules()
  }
}

/**
 * 检查文件是否应该被排除
 */
export function shouldExcludeFile(
  filePath: string,
  fileName: string,
  rules: IIgnoreRule[]
): boolean {
  return shouldExcludeFileByRules(filePath, fileName, rules)
}

/**
 * 过滤文件列表，移除应被排除的文件
 */
export function filterExcludedFiles(
  files: Array<{ path: string; name: string }>,
  rules: IIgnoreRule[]
): Array<{ path: string; name: string }> {
  return filterExcludedFilesByRules(files, rules)
}

// 向下兼容旧命名别名
export const getSystemIgnoreRules = getSystemExclusionRules
export const loadIgnoreRules = loadExclusionRules
export const shouldIgnoreFile = shouldExcludeFile
export const filterIgnoredFiles = filterExcludedFiles
