import React, { useState, useMemo } from 'react'
import { cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import {
  TAG_PROVENANCE_GROUPS,
  isTagProvenanceGroup,
  type TagProvenanceGroup
} from '@firefly/shared'

interface TagItem {
  /** 标签业务软主键 code（如 builtin.jpg / dim.6.design / omw.*），删除时透传给主进程解析 */
  id: number | string
  name: string
  /** 该标签自身的置信度 (0.0 ~ 1.0)，用于组内排序与 hover 提示 */
  confidence?: number
}

interface TagGroupView {
  group: string
  tags: TagItem[]
}

interface AnalysisResult {
  path: string
  /** 标签来源分组（ADR-0045）：读取接口新增的平行字段，与既有 dimensionTags 语义正交 */
  tagGroups?: TagGroupView[]
  groupingConfidence?: number
  qualityConfidence?: number
}

interface TagListProps {
  analysisResult: AnalysisResult
  getTagColor: (index: number) => string
  onTagDeleted?: () => void
}

interface CategorizedTag extends TagItem {
  colorIndex: number
  /** 归一化后的置信度，保证排序与均值计算不出现 undefined */
  normalizedConfidence: number
}

interface RenderedTagGroup {
  id: TagProvenanceGroup
  title: string
  /** 该组平均置信度的百分数（算术平均，四舍五入取整） */
  confidencePercent: number
  tags: CategorizedTag[]
}

/**
 * 属性面板标签列表
 *
 * 依据 ADR-0045「标签来源分组」：按标签的**产生出处**分五组展示，
 * 组按平均置信度降序、组内按各自置信度降序、空组隐藏，hover 单标签显示其自身置信度。
 *
 * 该概念与「组织轴」（标签在标签树中的结构位置）正交，故本组件**不再**依据维度 ID / 维度名
 * 推断分组（旧实现的 `Number(dimension)` 推断自 DAO 改为字符串 code 后已静默失效）。
 */
export const TagList: React.FC<TagListProps> = ({ analysisResult, getTagColor, onTagDeleted }) => {
  const [deletingTagId, setDeletingTagId] = useState<number | string | null>(null)
  const [hoveredTagId, setHoveredTagId] = useState<number | string | null>(null)

  const tagGroups = useMemo<RenderedTagGroup[]>(() => {
    // 组标题在渲染期动态求值：严禁模块级静态缓存 t()，否则语言切换后不刷新
    const titles: Record<TagProvenanceGroup, string> = {
      fact: t('事实标签'),
      fused: t('融合标签'),
      visual: t('视觉标签'),
      ai: t('AI 引擎标签'),
      user: t('用户标签')
    }

    const rawGroups = Array.isArray(analysisResult?.tagGroups) ? analysisResult.tagGroups : []
    let colorIndex = 0

    const groups: RenderedTagGroup[] = []
    for (const rawGroup of rawGroups) {
      if (!rawGroup || !isTagProvenanceGroup(rawGroup.group)) continue
      if (!Array.isArray(rawGroup.tags) || rawGroup.tags.length === 0) continue

      const tags: CategorizedTag[] = [...rawGroup.tags]
        .map(tag => ({
          ...tag,
          normalizedConfidence: typeof tag.confidence === 'number' ? tag.confidence : 1.0
        }))
        // 组内按各自置信度降序
        .sort((a, b) => b.normalizedConfidence - a.normalizedConfidence)
        .map(tag => ({ ...tag, colorIndex: colorIndex++ }))

      const average = tags.reduce((acc, tag) => acc + tag.normalizedConfidence, 0) / tags.length

      groups.push({
        id: rawGroup.group,
        title: titles[rawGroup.group],
        confidencePercent: Math.round(average * 100),
        tags
      })
    }

    // 组按平均置信度降序；同均值时按稳定枚举顺序兜底，保证渲染确定
    return groups.sort((a, b) => {
      if (b.confidencePercent !== a.confidencePercent) {
        return b.confidencePercent - a.confidencePercent
      }
      return TAG_PROVENANCE_GROUPS.indexOf(a.id) - TAG_PROVENANCE_GROUPS.indexOf(b.id)
    })
  }, [analysisResult])

  const totalTagsCount = useMemo(
    () => tagGroups.reduce((acc, g) => acc + g.tags.length, 0),
    [tagGroups]
  )

  const handleDelete = async (tagId: number | string, e: React.MouseEvent) => {
    e.stopPropagation()
    setDeletingTagId(tagId)
    try {
      const result = await (window as any).electronAPI!.deleteFileTag(analysisResult.path, tagId)
      if (result?.success) {
        toast.success(t('标签已删除'))
        onTagDeleted?.()
      } else {
        toast.error(result?.error || t('删除失败'))
      }
    } catch {
      toast.error(t('删除失败'))
    } finally {
      setDeletingTagId(null)
    }
  }

  // 目录画像或非文件分析结果不渲染文件标签列表，避免错误提示“暂无标签”
  if (
    !analysisResult ||
    (analysisResult as any).contextAnalysis !== undefined ||
    (analysisResult as any).fileCount !== undefined ||
    !('tagGroups' in analysisResult)
  ) {
    return null
  }

  if (totalTagsCount === 0) {
    return (
      <div className="border-t border-border pt-4 mb-6">
        <span className="text-xs text-muted-foreground italic">
          {t('标准分析模式无标签，请选其它分析模式，并重新分析')}
        </span>
      </div>
    )
  }

  return (
    <div className="border-t border-border pt-3 mb-4 space-y-2.5">
      {tagGroups.map(group => (
        <div key={group.id} className="flex items-center justify-between gap-2">
          {/* 左侧标签列表（组标题 + 组内标签） */}
          <div className="flex-1 flex flex-wrap gap-1.5 items-center min-w-0">
            <span className="text-[10px] font-semibold text-muted-foreground/70 shrink-0 mr-0.5">
              {group.title}
            </span>
            {group.tags.map(tag => (
              <span
                key={tag.id}
                // 原生提示：hover 显示该标签自身置信度（复用既有「置信度」词条）
                title={`${t('置信度')} ${Math.round(tag.normalizedConfidence * 100)}%`}
                className={cn(
                  'group relative text-xs px-2.5 py-1 rounded-full font-medium cursor-default transition-opacity',
                  deletingTagId === tag.id && 'opacity-50 pointer-events-none',
                  getTagColor(tag.colorIndex)
                )}
                onMouseEnter={() => setHoveredTagId(tag.id)}
                onMouseLeave={() => setHoveredTagId(null)}
              >
                {tag.name}
                <button
                  className={cn(
                    'absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-muted-foreground/60 text-background text-[12px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted-foreground',
                    hoveredTagId !== tag.id && 'opacity-0'
                  )}
                  onClick={e => handleDelete(tag.id, e)}
                  disabled={deletingTagId === tag.id}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          {/* 右侧垂直置信度：上方突出大号百分比数值，下方置信度小字 */}
          <div className="flex flex-col items-center justify-center shrink-0 select-none pl-2 pr-1 self-center">
            <div className="flex items-baseline leading-none">
              <span className="text-xs font-bold text-foreground/80 leading-none">
                {group.confidencePercent}
              </span>
              <span className="text-[10px] font-semibold text-muted-foreground/70 leading-none ml-[1px]">
                %
              </span>
            </div>
            <span className="text-[9px] font-medium text-muted-foreground/50 leading-none tracking-tight mt-0.5 whitespace-nowrap">
              {t('置信度')}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
