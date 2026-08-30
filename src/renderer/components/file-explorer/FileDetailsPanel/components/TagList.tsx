import React, { useState, useMemo } from 'react'
import { cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import {
  isFileTypeDimension,
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

/**
 * 依据 ADR 0028: 元数据提取字段找补与清洗架构规范 (Metadata Derivation & Tag Reconciliation)
 * 严格定义的系统找补 / 确定性规则派生与元数据回填维度 ID 集合
 */
const SYSTEM_RECONCILIATION_DIMENSION_IDS = new Set<number>([
  1, // 文件类型 (Magika 分类组与扩展名向上映射补全)
  4, // 作者 (从原生元数据 metadata.Author/creator 等找补回填)
  11, // 语言细分 (从原生元数据 metadata.Language 等找补回填)
  16, // 地理位置 (从原生元数据 GPS 经纬度逆地理编码找补回填)
  5, 9, 10, 12, 14, 15, 100, 101, 105, 106, // 规则细分 (文档/文本/数据库/源码/应用数据/压缩包/程序/系统文件/磁盘映像/字体细分)
  102, 103, 104, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, // 各类扩展名维度
  122, // 画质等级 (基于图像/视频物理分辨率确定性找补)
  123, // 内容尺度 (元数据标注找补)
  124, // 打码程度 (元数据标注找补)
  125 // 水印程度 (元数据标注找补)
])

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

        // 2. 依据 ADR 0028 规范判定的系统找补维度（包含作者、语言、地理位置、文件类型、扩展名、画质及规则细分等）
        const isSystemDim =
          isFileTypeDimension({ id: dimIdNum }) ||
          SYSTEM_RECONCILIATION_DIMENSION_IDS.has(dimIdNum) ||
          dimName === '作者' ||
          dimName === 'author' ||
          dimName === '地理位置' ||
          dimName === 'geo location' ||
          dimName === 'location' ||
          dimName === '语言细分' ||
          dimName === '语言' ||
          dimName === 'language'

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
