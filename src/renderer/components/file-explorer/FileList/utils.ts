import { FileCategory, isCategory, formatDateTime } from '@firefly/shared'
import { t } from '@app/languages'

/**
 * 判断是否为图片文件
 */
export const isImageFile = (ext?: string): boolean => {
  if (!ext) return false
  return isCategory(ext, FileCategory.IMAGE)
}

/**
 * 格式化日期
 */
export const formatDate = (date?: string | number | Date): string => {
  return formatDateTime(date)
}

/**
 * 获取相对路径（父目录路径）
 */
export const getRelativePath = (path: string): string => {
  if (!path) return ''
  const normalizedPath = window.electronAPI?.utils?.normalizePath?.(path) || path
  const separator = window.electronAPI?.utils?.pathSeparator || '/'
  const parts = normalizedPath.split(separator)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join(separator)
}

/**
 * 判断文件或目录是否为物理丢失/失效状态
 */
export const checkIsLost = (item: any, fileItem?: any): boolean => {
  if (item && typeof item === 'object' && item.status === 0) return true
  if (fileItem && typeof fileItem === 'object' && fileItem.status === 0) return true
  return false
}

/**
 * 判断是否为最小单元目录
 */
export const checkIsUnit = (item: any, fileItem?: any): boolean => {
  if (item && typeof item === 'object') {
    if (item.isUnit || item.is_unit === 1 || item.type === 'unit') return true
  }
  if (fileItem && typeof fileItem === 'object') {
    if (fileItem.isUnit || fileItem.is_unit === 1 || fileItem.type === 'unit') return true
  }
  return false
}

/**
 * 获取最小单元分类标签文案
 */
export const getUnitTypeLabel = (unitType?: string): string => {
  if (!unitType) return t('最小单元')
  const lower = unitType.toLowerCase()
  switch (lower) {
    case 'system_dir':
      return t('系统/配置')
    case 'software_app':
      return t('软件应用')
    case 'cache_storage':
      return t('缓存/LFS')
    case 'environment_dir':
      return t('虚拟环境')
    case 'design_project':
      return t('设计工程')
    case 'game_package':
      return t('游戏/MOD')
    case 'dataset_model':
      return t('数据集/模型')
    case 'album':
      return t('音频专辑')
    case 'series':
      return t('文件系列')
    default:
      if (lower.startsWith('project')) return t('工程项目')
      return unitType
  }
}

// ============================================================
// 最小单元类型 → UI 主题映射（图标、颜色、徽标样式）
// ============================================================

export interface UnitTypeTheme {
  /** Material Icons 图标名 */
  icon: string
  /** Tailwind 主色名（用于文字/边框） */
  color: string
  /** Tailwind 深色主题主色名 */
  darkColor: string
  /** 背景浅色 */
  bg: string
  /** 深色主题背景 */
  darkBg: string
  /** 边框色 */
  border: string
  /** 深色主题边框色 */
  darkBorder: string
  /** 左侧强调条样式类 */
  accentBar: string
}

const unitTypeThemes: Record<string, UnitTypeTheme> = {
  system_dir: {
    icon: 'settings',
    color: 'text-slate-600',
    darkColor: 'dark:text-slate-300',
    bg: 'bg-slate-50/60',
    darkBg: 'dark:bg-slate-950/20',
    border: 'border-slate-300/50',
    darkBorder: 'dark:border-slate-700/50',
    accentBar: 'border-l-4 border-l-slate-400 dark:border-l-slate-500'
  },
  software_app: {
    icon: 'apps',
    color: 'text-blue-600',
    darkColor: 'dark:text-blue-300',
    bg: 'bg-blue-50/60',
    darkBg: 'dark:bg-blue-950/20',
    border: 'border-blue-300/50',
    darkBorder: 'dark:border-blue-700/50',
    accentBar: 'border-l-4 border-l-blue-400 dark:border-l-blue-500'
  },
  cache_storage: {
    icon: 'storage',
    color: 'text-orange-600',
    darkColor: 'dark:text-orange-300',
    bg: 'bg-orange-50/60',
    darkBg: 'dark:bg-orange-950/20',
    border: 'border-orange-300/50',
    darkBorder: 'dark:border-orange-700/50',
    accentBar: 'border-l-4 border-l-orange-400 dark:border-l-orange-500'
  },
  environment_dir: {
    icon: 'dns',
    color: 'text-teal-600',
    darkColor: 'dark:text-teal-300',
    bg: 'bg-teal-50/60',
    darkBg: 'dark:bg-teal-950/20',
    border: 'border-teal-300/50',
    darkBorder: 'dark:border-teal-700/50',
    accentBar: 'border-l-4 border-l-teal-400 dark:border-l-teal-500'
  },
  design_project: {
    icon: 'palette',
    color: 'text-purple-600',
    darkColor: 'dark:text-purple-300',
    bg: 'bg-purple-50/60',
    darkBg: 'dark:bg-purple-950/20',
    border: 'border-purple-300/50',
    darkBorder: 'dark:border-purple-700/50',
    accentBar: 'border-l-4 border-l-purple-400 dark:border-l-purple-500'
  },
  game_package: {
    icon: 'sports_esports',
    color: 'text-rose-600',
    darkColor: 'dark:text-rose-300',
    bg: 'bg-rose-50/60',
    darkBg: 'dark:bg-rose-950/20',
    border: 'border-rose-300/50',
    darkBorder: 'dark:border-rose-700/50',
    accentBar: 'border-l-4 border-l-rose-400 dark:border-l-rose-500'
  },
  dataset_model: {
    icon: 'memory',
    color: 'text-indigo-600',
    darkColor: 'dark:text-indigo-300',
    bg: 'bg-indigo-50/60',
    darkBg: 'dark:bg-indigo-950/20',
    border: 'border-indigo-300/50',
    darkBorder: 'dark:border-indigo-700/50',
    accentBar: 'border-l-4 border-l-indigo-400 dark:border-l-indigo-500'
  },
  album: {
    icon: 'album',
    color: 'text-green-600',
    darkColor: 'dark:text-green-300',
    bg: 'bg-green-50/60',
    darkBg: 'dark:bg-green-950/20',
    border: 'border-green-300/50',
    darkBorder: 'dark:border-green-700/50',
    accentBar: 'border-l-4 border-l-green-400 dark:border-l-green-500'
  },
  series: {
    icon: 'collections_bookmark',
    color: 'text-yellow-600',
    darkColor: 'dark:text-yellow-300',
    bg: 'bg-yellow-50/60',
    darkBg: 'dark:bg-yellow-950/20',
    border: 'border-yellow-300/50',
    darkBorder: 'dark:border-yellow-700/50',
    accentBar: 'border-l-4 border-l-yellow-400 dark:border-l-yellow-500'
  }
}

/**
 * 根据 unitType 获取对应的 UI 主题配置
 */
export const getUnitTheme = (unitType?: string): UnitTypeTheme => {
  if (!unitType) return unitTypeThemes.series // fallback
  const lower = unitType.toLowerCase()
  if (lower.startsWith('project')) {
    return {
      icon: 'code',
      color: 'text-cyan-600',
      darkColor: 'dark:text-cyan-300',
      bg: 'bg-cyan-50/60',
      darkBg: 'dark:bg-cyan-950/20',
      border: 'border-cyan-300/50',
      darkBorder: 'dark:border-cyan-700/50',
      accentBar: 'border-l-4 border-l-cyan-400 dark:border-l-cyan-500'
    }
  }
  return (
    unitTypeThemes[lower] || {
      icon: 'inventory_2',
      color: 'text-amber-600',
      darkColor: 'dark:text-amber-300',
      bg: 'bg-amber-50/60',
      darkBg: 'dark:bg-amber-950/20',
      border: 'border-amber-300/50',
      darkBorder: 'dark:border-amber-700/50',
      accentBar: 'border-l-4 border-l-amber-400 dark:border-l-amber-500'
    }
  )
}

/**
 * 格式化置信度为百分比字符串
 */
export const formatConfidence = (confidence?: number): string => {
  if (confidence === undefined || confidence === null) return ''
  return `${Math.round(confidence * 100)}%`
}

/**
 * 构建最小单元的完整 tooltip 文本
 */
export const getUnitTooltip = (
  unitLabel: string,
  unitReason?: string,
  unitConfidence?: number
): string => {
  const parts: string[] = [`[${unitLabel}]`]
  if (unitReason) parts.push(unitReason)
  if (unitConfidence !== undefined && unitConfidence !== null) {
    parts.push(`${t('置信度')}: ${formatConfidence(unitConfidence)}`)
  }
  return parts.join(' | ')
}

/**
 * 渲染最小单元徽标的 className（不含内联样式冲突的类）
 */
export const getUnitBadgeClass = (theme: UnitTypeTheme): string => {
  return [
    'inline-flex items-center gap-1 text-[10px] font-semibold',
    theme.color,
    theme.darkColor,
    'bg-white/90 dark:bg-gray-900/90',
    'px-1.5 py-0.5 rounded-md',
    'border shadow-sm backdrop-blur-sm',
    theme.border,
    theme.darkBorder
  ].join(' ')
}
