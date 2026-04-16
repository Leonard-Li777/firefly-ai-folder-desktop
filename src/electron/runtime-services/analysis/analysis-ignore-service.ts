/**
 * AI分析忽略规则服务
 * 负责加载和应用文件忽略规则
 * 
 * 规则存储：使用统一配置系统（ConfigOrchestrator）
 */

import type { IIgnoreRule } from '@yonuc/types/settings-types'
import { filterIgnoredFilesByRules, logger, LogCategory, shouldIgnoreFileByRules } from '@yonuc/shared'
import { configService } from '../config/config-service'
import { defaultUnifiedConfig } from '../../config/config.default'

/**
 * 获取系统预设的忽略规则
 */
export function getSystemIgnoreRules(): IIgnoreRule[] {
  try {
    const rules = (defaultUnifiedConfig.analysis?.IGNORE_RULES ?? []) as IIgnoreRule[]
    return Array.isArray(rules) ? rules.filter(r => r.isSystem) : []
  } catch (error) {
    logger.error(LogCategory.SETTING, '[IgnoreRules] 获取系统忽略规则失败:', error)
    return []
  }
}

/**
 * 加载忽略规则配置（从统一配置）
 */
export function loadIgnoreRules(): IIgnoreRule[] {
  try {
    // 1. 从统一配置中获取当前保存的规则（包括已持久化的用户规则和系统规则）
    let rules = configService.getValue<IIgnoreRule[]>('IGNORE_RULES')
    
    // 2. 获取系统默认规则作为参考和兜底
    const systemRules = getSystemIgnoreRules()

    // 3. 如果当前配置中没有规则（undefined、null 或空数组），则使用系统默认规则
    if (!Array.isArray(rules) || rules.length === 0) {
      logger.info(LogCategory.SETTING, '[IgnoreRules] 配置中没有规则，使用系统默认规则')
      return systemRules
    }

    // 4. 确保所有系统内置规则始终存在（防止配置损坏导致内置规则丢失）
    const currentRuleIds = new Set(rules.map(r => r.id))
    const missingSystemRules = systemRules.filter(sr => !currentRuleIds.has(sr.id))
    
    if (missingSystemRules.length > 0) {
      logger.info(LogCategory.SETTING, '[IgnoreRules] 检测到缺失的系统规则，已自动补充', {
        missingCount: missingSystemRules.length
      })
      rules = [...rules, ...missingSystemRules]
    }

    return rules
  } catch (error) {
    logger.error(LogCategory.SETTING, '[IgnoreRules] 加载忽略规则失败:', error)
    // 发生严重错误时，尝试返回系统默认规则
    return getSystemIgnoreRules()
  }
}

/**
 * 检查文件是否应该被忽略
 */
export function shouldIgnoreFile(filePath: string, fileName: string, rules: IIgnoreRule[]): boolean {
  return shouldIgnoreFileByRules(filePath, fileName, rules)
}

/**
 * 过滤文件列表，移除应被忽略的文件
 */
export function filterIgnoredFiles(
  files: Array<{ path: string; name: string }>,
  rules: IIgnoreRule[]
): Array<{ path: string; name: string }> {
  return filterIgnoredFilesByRules(files, rules)
}
