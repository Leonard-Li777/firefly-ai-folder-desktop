import React, { useState } from 'react'
import { cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'

interface TagItem {
  id: number
  name: string
}

interface DimensionTagGroup {
  dimension: string
  level: number
  tags: TagItem[]
}

interface AnalysisResult {
  path: string
  dimensionTags?: DimensionTagGroup[]
}

interface TagListProps {
  analysisResult: AnalysisResult
  getTagColor: (index: number) => string
  onTagDeleted?: () => void
}

export const TagList: React.FC<TagListProps> = ({ analysisResult, getTagColor, onTagDeleted }) => {
  const [deletingTagId, setDeletingTagId] = useState<number | null>(null)
  const [hoveredTagIdx, setHoveredTagIdx] = useState<number | null>(null)

  const flatTags: Array<{ id: number; name: string }> = []
  if (analysisResult?.dimensionTags && Array.isArray(analysisResult.dimensionTags)) {
    analysisResult.dimensionTags.forEach((dimGroup: DimensionTagGroup) => {
      if (dimGroup.tags && Array.isArray(dimGroup.tags)) {
        dimGroup.tags.forEach((tagObj: TagItem) => flatTags.push(tagObj))
      }
    })
  }

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

  return (
    <div className="border-t border-border pt-4 mb-6">
      <div className="flex flex-wrap gap-2">
        {flatTags.length > 0 ? (
          flatTags.map((tag, idx) => (
            <span
              key={tag.id}
              className={cn(
                'group relative text-xs px-3 py-1.5 rounded-full font-medium cursor-default transition-opacity',
                deletingTagId === tag.id && 'opacity-50 pointer-events-none',
                getTagColor(idx)
              )}
              onMouseEnter={() => setHoveredTagIdx(idx)}
              onMouseLeave={() => setHoveredTagIdx(null)}
            >
              {tag.name}
              <button
                className={cn(
                  'absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-muted-foreground/60 text-background text-[12px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted-foreground',
                  hoveredTagIdx !== idx && 'opacity-0'
                )}
                onClick={e => handleDelete(tag.id, e)}
                disabled={deletingTagId === tag.id}
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="text-xs text-muted-foreground italic">{t('暂无标签，请重新分析')}</span>
        )}
      </div>
    </div>
  )
}
