import { useSettingsStore } from '../stores/settings-store'
import { t } from '@app/languages'

/**
 * 文件显示设置Hook
 * 从 settings-store 中获取文件显示字段设置,实现响应式更新
 * @param isRealDirectory 是否是真实目录模式,真实目录不显示AI分析相关字段
 */
export function useFileDisplaySettings(isRealDirectory = false) {
  const { config } = useSettingsStore()
  const extraFields = config.fileListExtraFields || ['qualityScore', 'tags']

  /**
   * 检查是否应该显示某个字段
   */
  const shouldShowField = (field: 'qualityScore' | 'description' | 'tags' | 'author' | 'language'): boolean => {
    // 真实目录模式下,不显示任何AI分析相关字段
    if (isRealDirectory) {
      return false
    }
    return extraFields.includes(field)
  }

  /**
   * 获取字段的显示标签
   */
  const getFieldLabel = (field: 'qualityScore' | 'description' | 'tags' | 'author' | 'language'): string => {
    const labels: Record<string, string> = {
      qualityScore: t('质量评分'),
      description: t('描述'),
      tags: t('标签'),
      author: t('作者'),
      language: t('语言')
    }
    return labels[field] || field
  }

  return {
    extraFields,
    shouldShowField,
    getFieldLabel
  }
}

