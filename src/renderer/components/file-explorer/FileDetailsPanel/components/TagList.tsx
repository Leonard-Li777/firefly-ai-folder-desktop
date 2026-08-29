import React, { useState, useMemo } from 'react'
import { cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import {
  isFileTypeDimension,
  EXTENSION_DIMENSION_IDS,
  RULE_SUBDIVISION_DIMENSION_IDS,
  isExtensionTag,
  isExtensionTriggerTagName
} from '@firefly/shared'

interface TagItem {
  id: number
  name: string
}

interface DimensionTagGroup {
  dimension: string | number
  level: number
  tags: TagItem[]
}

interface AnalysisResult {
  path: string
  dimensionTags?: DimensionTagGroup[]
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
}

interface TagCategoryGroup {
  id: 'system' | 'other' | 'content'
  title: string
  confidenceValue: number
  tags: CategorizedTag[]
}

export const TagList: React.FC<TagListProps> = ({ analysisResult, getTagColor, onTagDeleted }) => {
  const [deletingTagId, setDeletingTagId] = useState<number | null>(null)
  const [hoveredTagId, setHoveredTagId] = useState<number | null>(null)

  const tagGroups = useMemo<TagCategoryGroup[]>(() => {
    const systemTags: CategorizedTag[] = []
    const otherAiTags: CategorizedTag[] = []
    const contentAiTags: CategorizedTag[] = []

    let globalColorIndex = 0

    if (analysisResult?.dimensionTags && Array.isArray(analysisResult.dimensionTags)) {
      analysisResult.dimensionTags.forEach((dimGroup: DimensionTagGroup) => {
        if (!dimGroup.tags || !Array.isArray(dimGroup.tags)) return

        const dimIdNum = Number(dimGroup.dimension)
        const dimName = String(dimGroup.dimension).toLowerCase().trim()

        // 1. 内容维度（ID 28 或名称包含"内容标签"）
        const isContentDim =
          dimIdNum === 28 ||
          dimName === '内容标签' ||
          dimName === 'content tags' ||
          dimName === '28'

        // 2. 真正的系统找补维度（文件类型 ID 1、规则细分维度、扩展名专属维度 ID 102~117）
        const isSystemDim =
          dimIdNum === 1 ||
          isFileTypeDimension({ id: dimIdNum }) ||
          EXTENSION_DIMENSION_IDS.has(dimIdNum) ||
          RULE_SUBDIVISION_DIMENSION_IDS.has(dimIdNum)

        dimGroup.tags.forEach((tagObj: TagItem) => {
          const categorizedItem: CategorizedTag = {
            ...tagObj,
            colorIndex: globalColorIndex++
          }

          if (
            isSystemDim ||
            isExtensionTag(tagObj.name) ||
            isExtensionTriggerTagName(tagObj.name)
          ) {
            systemTags.push(categorizedItem)
          } else if (isContentDim) {
            contentAiTags.push(categorizedItem)
          } else {
            otherAiTags.push(categorizedItem)
          }
        })
      })
    }

    const groups: TagCategoryGroup[] = [
      {
        id: 'system',
        title: t('系统找补标签'),
        confidenceValue: 90,
        tags: systemTags
      },
      {
        id: 'other',
        title: t('AI 维度标签'),
        confidenceValue: 75,
        tags: otherAiTags
      },
      {
        id: 'content',
        title: t('AI 内容标签'),
        confidenceValue: 60,
        tags: contentAiTags
      }
    ]

    return groups
  }, [analysisResult])

  const totalTagsCount = useMemo(
    () => tagGroups.reduce((acc, g) => acc + g.tags.length, 0),
    [tagGroups]
  )

  const handleDelete = async (tagId: number, e: React.MouseEvent) => {
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

  if (totalTagsCount === 0) {
    return (
      <div className="border-t border-border pt-4 mb-6">
        <span className="text-xs text-muted-foreground italic">{t('暂无标签，请重新分析')}</span>
      </div>
    )
  }

  return (
    <div className="border-t border-border pt-4 mb-6 space-y-3">
      {tagGroups.map(group => {
        if (group.tags.length === 0) return null

        return (
          <div
            key={group.id}
            className="flex items-stretch justify-between gap-2.5 py-0.5"
          >
            {/* 左侧标签列表 */}
            <div className="flex-1 flex flex-wrap gap-2 items-center min-w-0">
              {group.tags.map(tag => (
                <span
                  key={tag.id}
                  className={cn(
                    'group relative text-xs px-3 py-1.5 rounded-full font-medium cursor-default transition-opacity',
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

            {/* 右侧垂直对称线条与置信度：上方加粗数值与下标%，下方置信度小字 */}
            <div className="flex flex-col items-center justify-center shrink-0 select-none pl-1.5 py-0.5 min-w-[24px]">
              <div className="flex-1 w-[1px] bg-border/40 min-h-[6px]" />
              <div className="flex flex-col items-center my-1.5 gap-0.5">
                <div className="flex items-baseline leading-none">
                  <span className="text-[12px] font-bold text-muted-foreground/80 leading-none">
                    {group.confidenceValue}
                  </span>
                  <span className="text-[8px] font-semibold text-muted-foreground/60 leading-none ml-[1px] translate-y-[2px]">
                    %
                  </span>
                </div>
                <span className="text-[9px] font-normal text-muted-foreground/50 leading-none tracking-wider [writing-mode:vertical-rl] whitespace-nowrap mt-0.5">
                  {t('置信度')}
                </span>
              </div>
              <div className="flex-1 w-[1px] bg-border/40 min-h-[6px]" />
            </div>
          </div>
        )
      })}
    </div>
  )
}
