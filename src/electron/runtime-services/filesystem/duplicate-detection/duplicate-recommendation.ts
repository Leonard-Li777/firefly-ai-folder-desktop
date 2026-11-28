import { DuplicateGroup } from '@firefly/types'
import { t } from '@app/languages'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'

/**
 * 动态多语言格式化查重组描述文本
 */
export function formatStrategyDescription(strategy: string, count: number): string {
  switch (strategy) {
    case 'exact_hash':
    case 'exact':
    case 'duplicates':
      return `${t('100% 完全精确一致文件')} (${count})`
    case 'image_phash':
    case 'image':
    case 'similar_images':
      return `${t('视觉感知相似图像')} (${count})`
    case 'audio_hash':
    case 'audio':
    case 'same_music':
      return `${t('同源/声学相似音频文件')} (${count})`
    case 'video_phash':
    case 'video':
    case 'similar_videos':
      return `${t('同源/画面相似视频文件')} (${count})`
    case 'bad_extensions':
      return `${t('扩展名不匹配文件')} (${count})`
    case 'empty_folders':
    case 'empty_folder':
      return `${t('空文件夹')} (${count})`
    case 'big_files':
    case 'big_file':
      return `${t('占用空间超大文件')} (${count})`
    case 'empty_files':
    case 'empty_file':
      return `${t('0 字节空文件')} (${count})`
    case 'temporary_files':
    case 'temporary':
      return `${t('临时与残留缓存文件')} (${count})`
    case 'invalid_symlinks':
    case 'invalid_symlink':
      return `${t('无效或断裂的软链接')} (${count})`
    case 'broken_files':
    case 'broken_file':
      return `${t('损坏或无法解码的文件')} (${count})`
    case 'bad_names':
    case 'bad_name':
      return `${t('包含异常/不合规字符的文件名')} (${count})`
    case 'exif_remover':
      return `${t('可清除 Exif 隐私信息的文件')} (${count})`
    case 'video_optimizer':
      return `${t('可转码/优化的高效能视频')} (${count})`
    default:
      return `${t('多模态特征识别组')} (${count})`
  }
}

/**
 * 获取当前系统与配置中不可被清理的受保护排除项名单 (严格依据 IGNORE_RULES 中的 isCzkawka 配置)
 */
export function getProtectedExcludedItems(): string[] {
  const rawProtectedItems: string[] = [
    '.VirtualDirectory',
    '.thumbnail',
    'desktop.ini',
    'thumbs.db',
    '.DS_Store',
    '.localized',
    '.git',
    '.ssh',
    '.vscode',
    '.idea',
    'node_modules',
    '__pycache__',
    '.venv',
    'venv',
    '.cache',
    'vendor',
    '.bundle',
    '.pnpm-store',
    '.npm',
    '.yarn',
    'coverage',
    '.nyc_output',
    'bootmgr',
    'bootnxt',
    'pagefile.sys',
    'hiberfil.sys',
    'swapfile.sys',
    '$RECYCLE.BIN',
    'System Volume Information',
    'Config.Msi',
    '$WinREAgent',
    'Recovery',
    '$GetCurrent',
    'DumpStack.log.tmp'
  ]

  try {
    const userRules = ConfigOrchestrator.getInstance().getValue<any[]>('IGNORE_RULES') || []
    for (const rule of userRules) {
      if (!rule.isActive || !rule.value) continue
      const val = String(rule.value).trim()
      if (!val) continue

      // 显式配置了 isCzkawka 字段
      if (rule.isCzkawka === true) {
        if (!rawProtectedItems.includes(val)) {
          rawProtectedItems.push(val)
        }
      } else if (rule.isCzkawka === false) {
        // 若用户或系统显式标记 isCzkawka = false，则从保护名单剔除
        const idx = rawProtectedItems.indexOf(val)
        if (idx !== -1) {
          rawProtectedItems.splice(idx, 1)
        }
      } else {
        // 老数据兼容：未设置 isCzkawka 时，非待清理扩展名/构建目录的目录与文件规则默认纳入保护
        const isCleanTarget = [
          '.tmp',
          '.log',
          '.bak',
          '.old',
          '.dmp',
          'dist',
          'build',
          'out',
          'target'
        ].some(t => val.toLowerCase().includes(t))
        if ((rule.type === 'directory' || rule.type === 'file') && !isCleanTarget) {
          if (!rawProtectedItems.includes(val)) {
            rawProtectedItems.push(val)
          }
        }
      }
    }
  } catch {}

  // 将原始规则项格式化为 czkawka 所要求的双向通配符格式（确保目录、子目录与文件名均能命中）
  const formattedPatterns = new Set<string>()
  for (const item of rawProtectedItems) {
    if (!item) continue
    if (item.includes('*')) {
      formattedPatterns.add(item)
    } else {
      // 对于目录和文件模式，生成标准跨平台通配符表达式
      formattedPatterns.add(`*${item}*`)
      formattedPatterns.add(`*/${item}/*`)
      formattedPatterns.add(`*\\${item}\\*`)
      formattedPatterns.add(`*/${item}`)
      formattedPatterns.add(`*\\${item}`)
    }
  }

  return Array.from(formattedPatterns)
}

/**
 * 解析分辨率字符串为像素总面积
 */
export function parseResolution(resStr?: string): number {
  if (!resStr) return 0
  const str = resStr.trim()
  const match = str.match(/(\d+)\s*[xX*×]\s*(\d+)/)
  if (match) {
    return parseInt(match[1], 10) * parseInt(match[2], 10)
  }
  if (/^4k$/i.test(str)) return 3840 * 2160
  if (/^2k$/i.test(str)) return 2560 * 1440
  if (/^1080p?$/i.test(str)) return 1920 * 1080
  if (/^720p?$/i.test(str)) return 1280 * 720
  return 0
}

/**
 * 格式化字节大小为可读字符串
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  if (i === 0) return `${bytes} B`
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

/**
 * 应用智能推荐保留规则
 */
export function applySmartRecommendKeep(groups: DuplicateGroup[], rule: string): DuplicateGroup[] {
  for (const group of groups) {
    if (!group.files || group.files.length === 0) continue

    let bestIndex = 0

    for (let i = 1; i < group.files.length; i++) {
      const curr = group.files[i]
      const best = group.files[bestIndex]

      const currRes = parseResolution(curr.resolution)
      const bestRes = parseResolution(best.resolution)
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

      if (rule === 'highest_resolution' || rule === 'best_resolution') {
        if (currRes !== bestRes) {
          if (currRes > bestRes) bestIndex = i
        } else if (currQuality !== bestQuality && (currQuality > 0 || bestQuality > 0)) {
          if (currQuality > bestQuality) bestIndex = i
        } else if (currSize !== bestSize) {
          if (currSize > bestSize) bestIndex = i
        } else if (currCreateTime !== bestCreateTime) {
          if (currCreateTime < bestCreateTime) bestIndex = i
        }
      } else if (rule === 'highest_quality' || rule === 'quality_score') {
        if (currQuality !== bestQuality && (currQuality > 0 || bestQuality > 0)) {
          if (currQuality > bestQuality) bestIndex = i
        } else if (currRes !== bestRes) {
          if (currRes > bestRes) bestIndex = i
        } else if (currSize !== bestSize) {
          if (currSize > bestSize) bestIndex = i
        } else if (currCreateTime !== bestCreateTime) {
          if (currCreateTime < bestCreateTime) bestIndex = i
        }
      } else if (rule === 'newest_modified' || rule === 'latest_modified') {
        if (currModTime !== bestModTime) {
          if (currModTime > bestModTime) bestIndex = i
        } else if (currSize !== bestSize) {
          if (currSize > bestSize) bestIndex = i
        }
      } else if (rule === 'oldest_created' || rule === 'earliest_created') {
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

    // 单体清理/修复/优化类策略：空文件、视频优化、异常文件名、临时缓存、空文件夹、断裂软链接、损坏文件
    // 这些指标发现的文件自身即是待处理目标，因此默认全部选中
    const isStandaloneAllSelectStrategy =
      group.strategy === 'empty_files' ||
      group.strategy === 'empty_folders' ||
      group.strategy === 'temporary_files' ||
      group.strategy === 'invalid_symlinks' ||
      group.strategy === 'broken_files' ||
      group.strategy === 'bad_names' ||
      group.strategy === 'video_optimizer'

    if (isStandaloneAllSelectStrategy) {
      group.files.forEach(f => {
        f.isRecommendedKeep = false
        f.selectedForDelete = true
      })
      group.recommendedKeepFingerprint = undefined
      continue
    }

    // 超大文件 (big_files)、Exif隐私清理 (exif_remover)、错误扩展名 (bad_extensions) 策略安全保护：默认全部保留，不勾选
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

    // 多模态/哈希/语义查重组：标记最佳保留项（1项保留，其余勾选为待删除）
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
  return groups
}
