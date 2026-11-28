import { DuplicateGroup } from '@firefly/types'
import { t } from '@app/languages'
import { RecommendRule, StrategyCategory, StrategyDefinition } from './types'

/** 操作执行后按单体存留规则（>0 保留，否则移除组）判定的策略列表 */
export const STANDALONE_GROUP_FILTER_STRATEGIES: ReadonlySet<string> = new Set([
  'empty_files',
  'empty_folders',
  'big_files',
  'temporary_files',
  'invalid_symlinks',
  'broken_files',
  'bad_extensions',
  'bad_names',
  'exif_remover',
  'video_optimizer'
])

/** 应用保留规则时默认全选待处理的单体清理类策略 */
const STANDALONE_ALL_SELECT_STRATEGIES: ReadonlySet<string> = new Set([
  'empty_files',
  'empty_folders',
  'temporary_files',
  'invalid_symlinks',
  'broken_files',
  'bad_names',
  'video_optimizer'
])

/** 动态构造策略分类列表（确保语言切换后重新求值） */
export function getStrategyCategories(): StrategyCategory[] {
  return [
    { key: 'multimodal', name: t('多模态与内容查重'), icon: 'fingerprint' },
    { key: 'cleanup', name: t('目录与空项清理'), icon: 'folder_delete' },
    { key: 'anomaly', name: t('异常与失效文件'), icon: 'report_problem' },
    { key: 'optimize', name: t('优化转换与隐私'), icon: 'tune' }
  ]
}

/** 动态构造 16 大核心策略定义表（按分类组织） */
export function getStrategyDefinitions(ffprobeAvailable: boolean): StrategyDefinition[] {
  return [
    { key: 'exact_hash', label: t('精确内容一致'), icon: 'fingerprint', category: 'multimodal' },
    { key: 'image_phash', label: t('相似图片'), icon: 'image', category: 'multimodal' },
    { key: 'audio_hash', label: t('相似音乐'), icon: 'audiotrack', category: 'multimodal' },
    {
      key: 'video_phash',
      label: t('相似视频'),
      icon: 'videocam',
      category: 'multimodal',
      warning: t('查找耗时较长'),
      description: t('需安装外部 ffprobe 依赖'),
      disabled: !ffprobeAvailable
    },
    {
      key: 'text_simhash',
      label: t('文档语义相似'),
      icon: 'article',
      category: 'multimodal',
      disabled: true
    },
    {
      key: 'filename_heuristic',
      label: t('副本衍生文件'),
      icon: 'copy_all',
      category: 'multimodal',
      disabled: true
    },

    { key: 'empty_folders', label: t('空文件夹'), icon: 'folder_open', category: 'cleanup' },
    {
      key: 'big_files',
      label: t('超大文件'),
      icon: 'save',
      category: 'cleanup',
      description: t('发现单文件体积大于或等于 10MB 的超大文件')
    },
    { key: 'empty_files', label: t('空文件'), icon: 'insert_drive_file', category: 'cleanup' },
    { key: 'temporary_files', label: t('临时缓存'), icon: 'auto_delete', category: 'cleanup' },

    { key: 'invalid_symlinks', label: t('断裂软链接'), icon: 'link_off', category: 'anomaly' },
    { key: 'broken_files', label: t('损坏文件'), icon: 'broken_image', category: 'anomaly' },
    { key: 'bad_extensions', label: t('错误扩展名'), icon: 'extension_off', category: 'anomaly' },
    { key: 'bad_names', label: t('异常文件名'), icon: 'edit_attributes', category: 'anomaly' },

    {
      key: 'exif_remover',
      label: t('Exif隐私清理'),
      icon: 'privacy_tip',
      category: 'optimize',
      description: t(
        '扫描图片中携带的 Exif 元数据（如 GPS 定位、拍摄器材、时间等隐私），清理后将另存为无隐私副本至 .VirtualDirectory/.cleaned_exif 目录，完全保留原文件。'
      )
    },
    {
      key: 'video_optimizer',
      label: t('视频优化转换'),
      icon: 'smart_display',
      category: 'optimize',
      warning: t('优化过程耗时较长'),
      description: t(
        '采用 AV1/HEVC 高能效编码转码压缩视频，优化后将另存为高清轻量副本至 .VirtualDirectory/.video_optimizer 目录，完全保留原文件。'
      ),
      disabled: !ffprobeAvailable
    }
  ]
}

function parseResolutionPixels(resStr?: string): number {
  if (!resStr) return 0
  const match = resStr.match(/(\d+)\s*[xX*×]\s*(\d+)/)
  return match ? parseInt(match[1], 10) * parseInt(match[2], 10) : 0
}

/**
 * 本地降级同步重算各分组推荐保留项与删除勾选状态
 */
export function applyKeepRuleLocally(
  prev: DuplicateGroup[],
  rule: RecommendRule
): DuplicateGroup[] {
  const cloned = prev.map(g => ({
    ...g,
    files: (g.files || []).map(f => ({ ...f }))
  }))
  for (const group of cloned) {
    if (!group.files || group.files.length === 0) continue

    // 单体清理/修复类策略保护
    if (STANDALONE_ALL_SELECT_STRATEGIES.has(group.strategy)) {
      group.files.forEach(f => {
        f.isRecommendedKeep = false
        f.selectedForDelete = true
      })
      group.recommendedKeepFingerprint = undefined
      continue
    }

    if (
      group.strategy === 'big_files' ||
      group.strategy === 'exif_remover' ||
      group.strategy === 'bad_extensions'
    ) {
      group.files.forEach(f => {
        f.isRecommendedKeep = true
        f.selectedForDelete = false
      })
      group.recommendedKeepFingerprint = undefined
      continue
    }

    // 多模态/查重组
    let bestIndex = 0
    for (let i = 1; i < group.files.length; i++) {
      const curr = group.files[i]
      const best = group.files[bestIndex]

      const currRes = parseResolutionPixels(curr.resolution)
      const bestRes = parseResolutionPixels(best.resolution)
      const currQuality = curr.qualityScore || 0
      const bestQuality = best.qualityScore || 0
      const currSize = curr.size || 0
      const bestSize = best.size || 0
      const currModTime = new Date(curr.modifiedAt || 0).getTime() || 0
      const bestModTime = new Date(best.modifiedAt || 0).getTime() || 0
      const currCreateTime = new Date(curr.createdAt || curr.modifiedAt || 0).getTime() || 0
      const bestCreateTime = new Date(best.createdAt || best.modifiedAt || 0).getTime() || 0
      const isCurrCopy = /副本|copy|\(\d+\)|_\d+$/i.test(curr.name)
      const isBestCopy = /副本|copy|\(\d+\)|_\d+$/i.test(best.name)

      if (rule === 'highest_resolution') {
        if (currRes !== bestRes) {
          if (currRes > bestRes) bestIndex = i
        } else if (currQuality !== bestQuality && (currQuality > 0 || bestQuality > 0)) {
          if (currQuality > bestQuality) bestIndex = i
        } else if (currSize !== bestSize) {
          if (currSize > bestSize) bestIndex = i
        } else if (currCreateTime !== bestCreateTime) {
          if (currCreateTime < bestCreateTime) bestIndex = i
        }
      } else if (rule === 'highest_quality') {
        if (currQuality !== bestQuality && (currQuality > 0 || bestQuality > 0)) {
          if (currQuality > bestQuality) bestIndex = i
        } else if (currRes !== bestRes) {
          if (currRes > bestRes) bestIndex = i
        } else if (currSize !== bestSize) {
          if (currSize > bestSize) bestIndex = i
        } else if (currCreateTime !== bestCreateTime) {
          if (currCreateTime < bestCreateTime) bestIndex = i
        }
      } else if (rule === 'newest_modified') {
        if (currModTime !== bestModTime) {
          if (currModTime > bestModTime) bestIndex = i
        } else if (currSize !== bestSize) {
          if (currSize > bestSize) bestIndex = i
        }
      } else if (rule === 'oldest_created') {
        if (currCreateTime !== bestCreateTime) {
          if (currCreateTime < bestCreateTime) bestIndex = i
        } else if (currSize !== bestSize) {
          if (currSize > bestSize) bestIndex = i
        }
      } else if (rule === 'original_name') {
        if (!isCurrCopy && isBestCopy) {
          bestIndex = i
        } else if (isCurrCopy && !isBestCopy) {
          // 保留最佳
        } else if (curr.name.length !== best.name.length) {
          if (curr.name.length < best.name.length) bestIndex = i
        } else if (currCreateTime !== bestCreateTime) {
          if (currCreateTime < bestCreateTime) bestIndex = i
        }
      }
    }

    group.files.forEach((f, idx) => {
      if (idx === bestIndex) {
        f.isRecommendedKeep = true
        f.selectedForDelete = false
      } else {
        f.isRecommendedKeep = false
        f.selectedForDelete = true
      }
    })
    group.recommendedKeepFingerprint = group.files[bestIndex]?.fingerprint
  }
  return cloned
}
