export type RecommendRule =
  | 'highest_resolution'
  | 'highest_quality'
  | 'newest_modified'
  | 'oldest_created'
  | 'original_name'

/** 清理/查重策略定义项 */
export interface StrategyDefinition {
  key: string
  label: string
  icon: string
  category: 'multimodal' | 'cleanup' | 'anomaly' | 'optimize'
  warning?: string
  /** 策略暂不可用（置灰显示，禁用勾选与筛选） */
  disabled?: boolean
  /** 悬停时展示的详细说明（原生 title 提示） */
  description?: string
}

/** 策略分类定义 */
export interface StrategyCategory {
  key: 'multimodal' | 'cleanup' | 'anomaly' | 'optimize'
  name: string
  icon: string
}

/** 清理分析统计汇总 */
export interface DuplicateStatistics {
  totalGroups: number
  redundantCount: number
  keepCount: number
  freedBytes: string
  rawFreedBytes: number
}

/** 已勾选待处理项目的分类统计 */
export interface SelectedActionSummary {
  trashCount: number
  renameCount: number
  extFixCount: number
  exifCleanCount: number
  videoOptCount: number
  totalCount: number
  hasTrash: boolean
  hasNonTrash: boolean
  isPureTrash: boolean
  isPureNonTrash: boolean
  isSingleNonTrash: boolean
  singleNonTrashType: 'rename' | 'extFix' | 'exif' | 'videoOpt' | null
  distinctActionTypeCount: number
}

/** 二次确认安全弹窗配置 */
export interface ConfirmDialogConfig {
  title: any
  mainDescription: string
  confirmBtnText: any
  isDestructive: boolean
  showDetailsCard: boolean
}
