import type {
  WorkspaceDirectory,
  WorkspaceConfig,
  HardwareInfo,
  WorkspaceConfigIntent,
  IFilterRule,
  RecommendReasonCode
} from '@firefly/types'
import type { LucideIcon } from 'lucide-react'

export interface WorkspaceSetupWizardProps {
  workspace: WorkspaceDirectory
  hardwareInfo?: HardwareInfo | null
  /**
   * 完成向导后的流转回调
   * @param mode 'complete' 自动完成并进入工作目录；'customize' 切入个性化微调配置
   */
  onFinish: (mode: 'complete' | 'customize', readyConfig: WorkspaceConfig) => void
  /**
   * 跳过向导回调（不绑定工作流，直接退出向导并进入工作目录设置）
   */
  onSkip?: () => void
}

/** 目录嗅探画像统计结构 */
export interface ProfileStats {
  totalSampled: number
  docCount: number
  imageCount: number
  videoCount: number
  otherCount: number
  installerCount?: number
  archiveCount?: number
  shortcutCount?: number
  audioCount?: number
  countsByExt?: Record<string, number>
  extensionCounts?: Record<string, number>
  categoryCounts?: Record<string, number>
  topExtensions: Array<{ ext: string; count: number }>
  durationMs: number
  hitTimeBudget: boolean
}

export interface DirectoryProfileResult {
  detectedIntent: WorkspaceConfigIntent
  confidence: number
  stats: ProfileStats
}

/**
 * 结构化持久化提交错误状态
 */
export interface PolicyCommitErrorState {
  code: 'STORAGE' | 'PERMISSION' | 'CONFLICT' | 'UNKNOWN'
  message: string
  stack?: string
  payload?: unknown
}

/**
 * 规则集合元素：生产预设 (organize-taxonomy-source.ts) 为 IFilterRule 对象，
 * 历史 filter_rules 兼容字段可能为纯字符串
 */
export type WizardRuleEntry = string | IFilterRule

/** 推荐评分映射条目 */
export interface ScoreMapEntry {
  score: number
  matchReason: string
  isTop: boolean
  reasonCode?: RecommendReasonCode
}

/** 当前工作流的包含白名单 */
export interface CurrentWhitelist {
  labels: string[]
  extensions: string[]
}

/** 大白话实测命中数描述（步骤 2 展示） */
export interface FileImpactStats {
  totalFiles: number
  matchedCount: number
  hiddenCount: number
  isWhitelistActive: boolean
  description: string
}

/** 目录画像细分比例条目 */
export interface DistributionSegment {
  key: string
  label: string
  count: number
  colorClass: string
  textClass: string
  Icon: LucideIcon
  pct: number
  widthPct: number
}

/** 目录画像分布（顶部常驻展示） */
export interface DirectoryDistribution {
  totalSampled: number
  segments: DistributionSegment[]
}
