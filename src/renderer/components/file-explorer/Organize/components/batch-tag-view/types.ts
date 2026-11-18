import type React from 'react'
import { BatchTagOperation, BatchTagResult, DimensionGroup } from '@firefly/types'

/**
 * 分类维度层级嵌套分组结构
 */
export interface HierarchicalDimensionGroup {
  /** 根维度组（如文件用途、文件来源、文件质量等） */
  root: DimensionGroup
  /** 下属子维度组列表（如安全等级、处理状态等） */
  children: DimensionGroup[]
  /** 聚合指标：当前根维度及所有子维度下的标签总数 */
  totalTagsCount: number
  /** 聚合指标：当前待整理文件中是否有文件命中了该根或其子维度标签 */
  hasActiveFileHits: boolean
}

export interface BatchTagViewProps {
  files: any[]
  dimensionGroups: DimensionGroup[]
  // S3 规格 §5.5：透传 BatchTagResult，否则 §5.4 的覆盖提示拿不到 overriddenCount；
  // 保存失败必须 reject（调用方靠 catch 实现「不重置工作台」）
  onSaveTags: (changes: BatchTagOperation) => Promise<BatchTagResult | void>
  onDeleteTagGlobally?: (dimensionId: number, tagName: string) => Promise<boolean>
  isSaving?: boolean
  inspectedFile?: any | null
  onClearInspectedFile?: () => void
}

export type TagActionState = 'initial' | 'add_all' | 'remove_all'

/**
 * 单个标签胶囊组件 (React.memo)
 * 仅在其自身状态或聚焦拥有状态变化时重绘，杜绝点击文件时全量 1000+ 标签无效重绘与动画卡顿
 */
export interface TagPillProps {
  dimId: number
  tagName: string
  tagKey: string
  count: number
  totalFilesCount: number
  state: TagActionState
  isOwnedByInspected: boolean
  isPan: boolean
  onToggle: (tagKey: string) => void
  onDelete?: (dimId: number, tagName: string, e: React.MouseEvent) => void
}

/**
 * 单个维度分组卡片组件 (React.memo)
 * 仅在其自身标签、三态状态或被聚焦文件命中的标签变化时重绘，避免全量维度树重绘
 */
export interface DimensionGroupCardProps {
  group: DimensionGroup
  isPan: boolean
  groupNewTags: string[]
  isInputActive: boolean
  isInspecting?: boolean
  inputVal: string
  tagStates: Record<string, TagActionState>
  tagFileCounts: Record<string, number>
  totalFilesCount: number
  inspectedTagSet: Set<string>
  hasInspected: boolean
  onToggleTag: (tagKey: string) => void
  onDeleteExistingTag: (dimId: number, tagName: string, e: React.MouseEvent) => void
  onBatchSetTags: (group: DimensionGroup, state: TagActionState) => void
  onStartAddNewTag: (dimId: number) => void
  onCancelAddNewTag: () => void
  onInputChange: (val: string) => void
  onSubmitAddNewTag: (dimId: number) => void
  onRemoveNewTag: (dimId: number, name: string) => void
}

/**
 * 分类维度树形层级嵌套卡片组件 (React.memo)
 * 根维度卡片 -> 直属标签 -> 树形引导线 -> 子维度分组卡片 (如安全等级、处理状态)
 * 支持平滑折叠/展开、直属标签与子维度独立批量全附/恢复、命中高亮徽章
 */
export interface HierarchicalDimensionCardProps {
  item: HierarchicalDimensionGroup
  isExpanded: boolean
  onToggleExpand: (rootKey: string) => void
  tagStates: Record<string, TagActionState>
  tagFileCounts: Record<string, number>
  totalFilesCount: number
  inspectedTagSet: Set<string>
  hasInspected: boolean
  onToggleTag: (tagKey: string) => void
  onBatchSetTags: (group: DimensionGroup, state: TagActionState) => void
}
