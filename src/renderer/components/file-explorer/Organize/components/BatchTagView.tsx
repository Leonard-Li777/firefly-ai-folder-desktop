import React, { useState, useMemo, useEffect, useCallback } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Badge } from '../../../ui/badge'
import { DimensionGroup, DimensionTag, BatchTagOperation } from '@firefly/types'
import {
  isExtensionDimension,
  isFileTypeDimension,
  isRuleSubdivisionDimension,
  isPanDimension as checkIsPanDimension,
  filterDimensionTags
} from '@firefly/shared'
import { toast } from '../../../common/Toast'
import { SplitPane } from '../../../common/SplitPane'

export { isExtensionDimension }

interface BatchTagViewProps {
  files: any[]
  dimensionGroups: DimensionGroup[]
  panDimensionIds?: number[]
  onSaveTags: (changes: BatchTagOperation) => Promise<void>
  onDeleteTagGlobally?: (dimensionId: number, tagName: string) => Promise<boolean>
  isSaving?: boolean
  inspectedFile?: any | null
  onClearInspectedFile?: () => void
}

type TagActionState = 'initial' | 'add_all' | 'remove_all'

/**
 * 判断是否为扩展名相关标签（以点开头的扩展名标签，如 .jpg, .pdf 等）
 */
export const isExtensionTag = (tagName: string) => {
  if (!tagName) return false
  const trimmed = tagName.trim()
  return trimmed.startsWith('.')
}

/**
 * 单个标签胶囊组件 (React.memo)
 * 仅在其自身状态或聚焦拥有状态变化时重绘，杜绝点击文件时全量 1000+ 标签无效重绘与动画卡顿
 */
interface TagPillProps {
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

const TagPill: React.FC<TagPillProps> = React.memo(
  ({
    dimId,
    tagName,
    tagKey,
    count,
    totalFilesCount,
    state,
    isOwnedByInspected,
    isPan,
    onToggle,
    onDelete
  }) => {
    const ratio = totalFilesCount > 0 ? count / totalFilesCount : 0

    // 状态与覆盖率
    const isAllAttached = state === 'add_all'
    const isAllRemoved = state === 'remove_all'
    const isFullyOwned = ratio >= 1 && state === 'initial'
    const isPartial = ratio > 0 && ratio < 1 && state === 'initial'

    return (
      <div className="group relative inline-flex">
        <div
          onClick={() => onToggle(tagKey)}
          className={cn(
            'relative overflow-hidden inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium cursor-pointer',
            'border select-none shadow-2xs transition-colors duration-150',
            // 状态高亮
            isAllAttached
              ? 'border-emerald-600 bg-emerald-600 text-white font-semibold shadow-xs'
              : isAllRemoved
                ? 'border-destructive/60 bg-destructive/15 text-destructive line-through opacity-85'
                : isFullyOwned
                  ? 'border-primary bg-primary text-primary-foreground font-semibold shadow-xs'
                  : isPartial
                    ? 'border-primary/40 text-foreground hover:border-primary/70'
                    : 'border-border/60 bg-card hover:border-border text-foreground/80',
            // 当前聚焦文件拥有时的突出展示（保持尺寸绝对恒定，无 scale 形变与新增徽章，杜绝布局回流）
            isOwnedByInspected
              ? 'border-primary bg-primary/20 text-primary font-semibold shadow-sm ring-1 ring-primary/40 !opacity-100 z-10'
              : 'group-[.tags-has-inspected]/taggrid:opacity-40 group-[.tags-has-inspected]/taggrid:hover:opacity-100'
          )}
          style={
            isPartial && !isOwnedByInspected
              ? {
                  backgroundColor: `rgba(var(--primary-rgb, 59, 130, 246), ${0.08 + ratio * 0.25})`
                }
              : undefined
          }
        >
          {/* 部分拥有时的背景进度条 (覆盖率比值) */}
          {isPartial && (
            <div
              className="absolute inset-y-0 left-0 bg-primary/20 pointer-events-none rounded-xl"
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          )}

          {/* 三态状态前置小图标 */}
          {isAllAttached && (
            <MaterialIcon icon="add_circle" className="text-xs text-white shrink-0 relative z-10" />
          )}
          {isAllRemoved && (
            <MaterialIcon icon="do_not_disturb_on" className="text-xs text-destructive shrink-0 relative z-10" />
          )}

          {/* 标签名称 */}
          <span className="relative z-10">{tagName}</span>

          {/* 数量与比例统计徽章 */}
          <span
            className={cn(
              'relative z-10 text-[10px] tabular-nums font-mono px-1 rounded',
              isAllAttached
                ? 'bg-black/20 text-white'
                : isAllRemoved
                  ? 'bg-destructive/20 text-destructive'
                  : isFullyOwned
                    ? 'bg-black/20 text-white'
                    : isOwnedByInspected
                      ? 'bg-primary/20 text-primary font-semibold'
                      : 'bg-background/80 text-muted-foreground border border-border/40'
            )}
          >
            {isAllAttached
              ? `${totalFilesCount}/${totalFilesCount}`
              : isAllRemoved
                ? `0/${totalFilesCount}`
                : `${count}/${totalFilesCount}`}
          </span>
        </div>

        {/* 仅泛维度的标签在 hover 时浮动到右上角（一半在胶囊外），不占用胶囊内部空间 */}
        {isPan && onDelete && (
          <button
            type="button"
            title={t('删除该标签')}
            onClick={e => onDelete(dimId, tagName, e)}
            className={cn(
              'absolute -top-1.5 -right-1.5 z-20 w-5 h-5 rounded-full',
              'bg-destructive text-destructive-foreground shadow-xs border border-background',
              'opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 transition-all duration-150',
              'flex items-center justify-center cursor-pointer hover:bg-destructive/90 hover:scale-110'
            )}
          >
            <MaterialIcon icon="close" className="text-[10px]" />
          </button>
        )}
      </div>
    )
  }
)

TagPill.displayName = 'TagPill'

export const BatchTagView: React.FC<BatchTagViewProps> = ({
  files,
  dimensionGroups = [],
  panDimensionIds = [4, 28],
  onSaveTags,
  isSaving = false,
  inspectedFile = null,
  onClearInspectedFile
}) => {
  const totalFilesCount = files.length

  // 每个已有标签的状态映射: `${dimensionId}::${tagValue}` -> TagActionState
  const [tagStates, setTagStates] = useState<Record<string, TagActionState>>({})
  // 新建标签列表: dimensionId -> string[]
  const [newTagNames, setNewTagNames] = useState<Record<number, string[]>>({})
  // 标记待删除的已有泛维度标签集合: Set of `${dimensionId}::${tagValue}`
  const [deletedTagKeys, setDeletedTagKeys] = useState<Set<string>>(() => new Set())
  // 正在内嵌输入的维度ID
  const [activeInputDimId, setActiveInputDimId] = useState<number | null>(null)
  const [inputVal, setInputVal] = useState('')
  // 搜索关键字
  const [searchQuery, setSearchQuery] = useState('')
  // 异步获取的全量预设维度定义（包含当前文件集合未拥有的所有预设标签）
  const [fullPresetGroups, setFullPresetGroups] = useState<DimensionGroup[]>([])

  // 拉取全量预设维度与标签数据
  const loadFullDimensions = useCallback(async () => {
    try {
      const res = await window.electronAPI?.analyzedDirectory?.getDimensionGroups({
        includeAllPresetTags: true,
        excludeExtensionDimension: true
      })
      if (res?.groups && res.groups.length > 0) {
        setFullPresetGroups(res.groups)
      }
    } catch (err) {
      console.warn('[BatchTagView] 加载全量预设维度失败，使用传入的维度数据:', err)
    }
  }, [])

  // 挂载时拉取全量预设维度与标签数据
  useEffect(() => {
    loadFullDimensions()
  }, [loadFullDimensions])

  // 监听全局标签更新广播（如删除标签或保存变更后自动同步）
  useEffect(() => {
    const handleTagsChanged = () => {
      loadFullDimensions()
    }
    window.addEventListener('tags-updated', handleTagsChanged)
    window.addEventListener('tags:updated', handleTagsChanged)
    return () => {
      window.removeEventListener('tags-updated', handleTagsChanged)
      window.removeEventListener('tags:updated', handleTagsChanged)
    }
  }, [loadFullDimensions])

  // 1. 单次快速循环：统计待整理文件中各标签的覆盖计数，并汇总各维度的自定义标签（避免重复多重扫描）
  const { tagFileCounts, fileCustomTags } = useMemo(() => {
    const counts: Record<string, number> = {}
    const customTagsByDim = new Map<number, Set<string>>()

    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const fileTagSet = new Set<string>()

      if (Array.isArray(f.dimensionTags)) {
        for (let j = 0; j < f.dimensionTags.length; j++) {
          const dt = f.dimensionTags[j]
          const dimId = dt?.dimensionId ?? dt?.dimension
          const val = dt?.tagValue ?? dt?.tag ?? dt?.name
          if (val) {
            const strVal = String(val).trim()
            fileTagSet.add(strVal)
            if (dimId) {
              const numDimId = Number(dimId)
              let dimSet = customTagsByDim.get(numDimId)
              if (!dimSet) {
                dimSet = new Set<string>()
                customTagsByDim.set(numDimId, dimSet)
              }
              dimSet.add(strVal)
            }
          }
        }
      }

      if (Array.isArray(f.tags)) {
        for (let j = 0; j < f.tags.length; j++) {
          const t = f.tags[j]
          if (typeof t === 'string') {
            fileTagSet.add(t.trim())
          } else if (t && typeof t === 'object') {
            const val = t.tagValue || t.tagName || t.name || t.value || t.tag
            const dimId = t.dimensionId || t.dimension
            if (val) {
              const strVal = String(val).trim()
              fileTagSet.add(strVal)
              if (dimId) {
                const numDimId = Number(dimId)
                let dimSet = customTagsByDim.get(numDimId)
                if (!dimSet) {
                  dimSet = new Set<string>()
                  customTagsByDim.set(numDimId, dimSet)
                }
                dimSet.add(strVal)
              }
            }
          }
        }
      }

      fileTagSet.forEach(tagVal => {
        counts[tagVal] = (counts[tagVal] || 0) + 1
      })
    }

    return { tagFileCounts: counts, fileCustomTags: customTagsByDim }
  }, [files])

  // 2. 合并全量预设维度、传入维度以及当前待整理文件中已拥有的自定义标签（排除被用户在工作台标记删除的标签）
  const effectiveDimensionGroups = useMemo(() => {
    const isDeletedTag = (dimId: number, tagVal: string) => {
      const valStr = String(tagVal).trim()
      return (
        deletedTagKeys.has(`${dimId}::${valStr}`) ||
        deletedTagKeys.has(`${dimId}::${valStr.toLowerCase()}`)
      )
    }

    const dimMap = new Map<number, DimensionGroup>()

    // 1. 载入全量预设维度定义
    for (const g of fullPresetGroups) {
      dimMap.set(g.id, {
        ...g,
        tags: g.tags ? g.tags.filter(t => !isDeletedTag(g.id, t.tagValue)) : []
      })
    }

    // 2. 合并传入的 dimensionGroups（包含数据库中已存的自定义标签）
    for (const g of dimensionGroups) {
      if (dimMap.has(g.id)) {
        const existing = dimMap.get(g.id)!
        const existingTagValues = new Set((existing.tags || []).map(t => t.tagValue.toLowerCase()))
        for (const t of g.tags || []) {
          if (!isDeletedTag(g.id, t.tagValue) && !existingTagValues.has(t.tagValue.toLowerCase())) {
            existing.tags = [...(existing.tags || []), t]
            existingTagValues.add(t.tagValue.toLowerCase())
          }
        }
      } else {
        dimMap.set(g.id, {
          ...g,
          tags: g.tags ? g.tags.filter(t => !isDeletedTag(g.id, t.tagValue)) : []
        })
      }
    }

    // 3. 将待整理文件中收集到的自定义标签高效合并
    fileCustomTags.forEach((tagSet, dimId) => {
      const g = dimMap.get(dimId)
      if (g) {
        const existingTagValues = new Set((g.tags || []).map(t => t.tagValue.toLowerCase()))
        tagSet.forEach(strVal => {
          if (!isDeletedTag(dimId, strVal) && !existingTagValues.has(strVal.toLowerCase())) {
            g.tags = [
              ...(g.tags || []),
              {
                dimensionId: g.id,
                dimensionName: g.name,
                tagValue: strVal,
                fileCount: tagFileCounts[strVal] || 1,
                level: g.level || 2
              }
            ]
            existingTagValues.add(strVal.toLowerCase())
          }
        })
      }
    })

    // 4. 过滤排除扩展名维度、文件类型维度以及由标签找补程序处理的规则细分维度
    const nonExtGroups = Array.from(dimMap.values()).filter(
      g =>
        !isExtensionDimension(g) &&
        !isFileTypeDimension(g) &&
        g.id !== 1 &&
        !isRuleSubdivisionDimension(g)
    )

    return nonExtGroups.map(group => {
      // 过滤排除首部或尾部的预设扩展名触发标签
      const rawTags = group.tags || []
      const allowedTagValues = new Set(
        filterDimensionTags({ id: group.id, tags: rawTags.map(t => t.tagValue) })
      )
      const validTags = rawTags.filter(
        t =>
          !isDeletedTag(group.id, t.tagValue) &&
          allowedTagValues.has(t.tagValue) &&
          !isExtensionTag(t.tagValue)
      )

      // 如果是泛维度，预先排序好 tags，避免每次组件渲染都重复执行 Array.sort
      const isPan = checkIsPanDimension(group, panDimensionIds)
      if (isPan) {
        validTags.sort((a, b) => {
          const countA = tagFileCounts[a.tagValue] ?? a.fileCount ?? 0
          const countB = tagFileCounts[b.tagValue] ?? b.fileCount ?? 0
          return countB - countA
        })
      }

      return {
        ...group,
        tags: validTags
      }
    })
  }, [fullPresetGroups, dimensionGroups, fileCustomTags, tagFileCounts, deletedTagKeys, panDimensionIds])

  // 判断是否为泛维度（使用共享纯 ID 集合判定）
  const isPanDimension = useCallback(
    (group: DimensionGroup) => {
      return checkIsPanDimension(group, panDimensionIds)
    },
    [panDimensionIds]
  )

  // 提取选中聚焦文件所拥有的所有标签集合（兼容数组或单个对象、各种字段名与维度ID）
  const inspectedTagSet = useMemo(() => {
    const set = new Set<string>()
    if (!inspectedFile) return set
    const target = Array.isArray(inspectedFile) ? inspectedFile[0] : inspectedFile
    if (!target) return set

    // 1. dimensionTags
    if (Array.isArray(target.dimensionTags)) {
      for (const dt of target.dimensionTags) {
        const dimId = dt?.dimension ?? dt?.dimensionId
        const val = dt?.tag ?? dt?.tagValue ?? dt?.name
        if (val) {
          const valStr = String(val).trim().toLowerCase()
          set.add(valStr)
          if (dimId) set.add(`${dimId}::${valStr}`)
        }
      }
    }

    // 2. tags
    if (Array.isArray(target.tags)) {
      for (const t of target.tags) {
        if (typeof t === 'string') {
          set.add(t.trim().toLowerCase())
        } else if (t && typeof t === 'object') {
          const val = t.tagValue || t.tagName || t.name || t.value || t.tag
          const dimId = t.dimensionId || t.dimension
          if (val) {
            const valStr = String(val).trim().toLowerCase()
            set.add(valStr)
            if (dimId) set.add(`${dimId}::${valStr}`)
            if (t.dimensionName) {
              set.add(`${String(t.dimensionName).trim().toLowerCase()}::${valStr}`)
            }
          }
        }
      }
    }
    return set
  }, [inspectedFile])

  const inspectedFileItem = Array.isArray(inspectedFile) ? inspectedFile[0] : inspectedFile

  // 提取选中聚焦文件所拥有的结构化标签列表（包含归属维度名称），供顶部状态条集中展示
  const inspectedFileTagsWithDimension = useMemo(() => {
    if (!inspectedFileItem) return []

    // 建立维度 ID 与维度名称字典
    const dimIdToName = new Map<number, string>()
    const tagToDimName = new Map<string, { dimId: number; name: string }>()

    effectiveDimensionGroups.forEach(g => {
      dimIdToName.set(g.id, g.name)
      if (Array.isArray(g.tags)) {
        g.tags.forEach(t => {
          if (t?.tagValue) {
            tagToDimName.set(t.tagValue.trim().toLowerCase(), { dimId: g.id, name: g.name })
          }
        })
      }
    })

    const result: Array<{ dimensionId?: number; dimensionName: string; tagValue: string }> = []
    const seen = new Set<string>()

    const addTag = (dimId: number | undefined, dimName: string | undefined, tagVal: any) => {
      if (!tagVal) return
      const valStr = String(tagVal).trim()
      if (!valStr || isExtensionTag(valStr)) return

      let resolvedDimId = dimId
      let resolvedDimName = dimName
      if (!resolvedDimName && resolvedDimId !== undefined) {
        resolvedDimName = dimIdToName.get(Number(resolvedDimId))
      }
      if (!resolvedDimName) {
        const matched = tagToDimName.get(valStr.toLowerCase())
        if (matched) {
          resolvedDimId = matched.dimId
          resolvedDimName = matched.name
        } else {
          resolvedDimId = 28
          resolvedDimName = t('内容标签')
        }
      }

      const finalDimName = resolvedDimName || t('内容标签')
      const key = `${finalDimName}::${valStr.toLowerCase()}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push({
          dimensionId: resolvedDimId,
          dimensionName: finalDimName,
          tagValue: valStr
        })
      }
    }

    // 1. dimensionTags
    if (Array.isArray(inspectedFileItem.dimensionTags)) {
      for (const dt of inspectedFileItem.dimensionTags) {
        const dimId = dt?.dimensionId ?? dt?.dimension
        const dimName =
          dt?.dimensionName ??
          (typeof dt?.dimension === 'string' && isNaN(Number(dt.dimension))
            ? dt.dimension
            : undefined)
        const val = dt?.tagValue ?? dt?.tag ?? dt?.name ?? dt?.value
        addTag(dimId !== undefined && !isNaN(Number(dimId)) ? Number(dimId) : undefined, dimName, val)
      }
    }

    // 2. tags
    if (Array.isArray(inspectedFileItem.tags)) {
      for (const t of inspectedFileItem.tags) {
        if (typeof t === 'string') {
          addTag(undefined, undefined, t)
        } else if (t && typeof t === 'object') {
          const dimId = t.dimensionId ?? t.dimension
          const dimName =
            t.dimensionName ??
            (typeof t.dimension === 'string' && isNaN(Number(t.dimension))
              ? t.dimension
              : undefined)
          const val = t.tagValue ?? t.tagName ?? t.name ?? t.value ?? t.tag
          addTag(dimId !== undefined && !isNaN(Number(dimId)) ? Number(dimId) : undefined, dimName, val)
        }
      }
    }

    // 3. 排序：按维度名称归类，同维度按标签名称排序
    result.sort((a, b) => {
      if (a.dimensionName !== b.dimensionName) {
        // 让“内容标签”排在最后
        const isAContent = a.dimensionId === 28 || a.dimensionName === t('内容标签')
        const isBContent = b.dimensionId === 28 || b.dimensionName === t('内容标签')
        if (isAContent && !isBContent) return 1
        if (!isAContent && isBContent) return -1
        return a.dimensionName.localeCompare(b.dimensionName, 'zh-CN')
      }
      return a.tagValue.localeCompare(b.tagValue, 'zh-CN')
    })

    return result
  }, [inspectedFileItem, effectiveDimensionGroups])

  // 统计已添加和已移除的变更数量
  const changeStats = useMemo(() => {
    let addCount = 0
    let removeCount = 0
    Object.values(tagStates).forEach(state => {
      if (state === 'add_all') addCount++
      if (state === 'remove_all') removeCount++
    })
    Object.values(newTagNames).forEach(names => {
      addCount += names.length
    })
    if (activeInputDimId !== null && inputVal.trim()) {
      addCount++
    }
    // 统计待删除标签数量（按唯一 key 计数，避免重复）
    const distinctDeletedKeys = new Set<string>()
    deletedTagKeys.forEach(k => {
      const [d, ...rest] = k.split('::')
      distinctDeletedKeys.add(`${d}::${rest.join('::').toLowerCase()}`)
    })
    removeCount += distinctDeletedKeys.size

    return { addCount, removeCount, totalChanges: addCount + removeCount }
  }, [tagStates, newTagNames, activeInputDimId, inputVal, deletedTagKeys])

  // 处理标签点击三态循环 (Initial -> Add All -> Remove All -> Initial)
  const handleToggleTag = useCallback((tagKey: string) => {
    setTagStates(prev => {
      const curr = prev[tagKey] || 'initial'
      let next: TagActionState = 'add_all'
      if (curr === 'initial') next = 'add_all'
      else if (curr === 'add_all') next = 'remove_all'
      else if (curr === 'remove_all') next = 'initial'

      if (next === 'initial') {
        const copy = { ...prev }
        delete copy[tagKey]
        return copy
      }
      return { ...prev, [tagKey]: next }
    })
  }, [])

  // 重置全部标签变更
  const handleResetAllChanges = useCallback(() => {
    setTagStates({})
    setNewTagNames({})
    setDeletedTagKeys(new Set())
    setInputVal('')
    setActiveInputDimId(null)
    toast.info(t('已重置所有未保存的标签变更'))
  }, [])

  // 快速全选某维度下的全部标签为全部附加
  const handleBatchSetDimensionTags = useCallback((group: DimensionGroup, targetState: TagActionState) => {
    setTagStates(prev => {
      const next = { ...prev }
      ;(group.tags || []).forEach(t => {
        const key = `${group.id}::${t.tagValue}`
        if (targetState === 'initial') {
          delete next[key]
        } else {
          next[key] = targetState
        }
      })
      return next
    })
  }, [])

  // 提交新建标签
  const handleAddNewTag = useCallback((dimensionId: number) => {
    const trimmed = inputVal.trim()
    if (!trimmed) {
      setActiveInputDimId(null)
      return
    }
    if (isExtensionTag(trimmed)) {
      toast.warning(t('扩展名由程序自动处理，无需手动新建扩展名标签'))
      return
    }
    setNewTagNames(prev => ({
      ...prev,
      [dimensionId]: [...(prev[dimensionId] || []).filter(n => n !== trimmed), trimmed]
    }))
    setInputVal('')
    setActiveInputDimId(null)
  }, [inputVal])

  // 删除新建标签
  const handleRemoveNewTag = useCallback((dimensionId: number, name: string) => {
    setNewTagNames(prev => ({
      ...prev,
      [dimensionId]: (prev[dimensionId] || []).filter(n => n !== name)
    }))
  }, [])

  // 标记泛维度中的已有标签为待删除（从当前工作台中隐藏并加入移除变更队列）
  const handleDeleteExistingTag = useCallback((dimId: number, tagName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const strVal = tagName.trim()
    const key = `${dimId}::${strVal}`
    const lowerKey = `${dimId}::${strVal.toLowerCase()}`

    setDeletedTagKeys(prev => {
      const next = new Set(prev)
      next.add(key)
      next.add(lowerKey)
      return next
    })

    // 如果该标签此前有三态附加设置，清理之
    setTagStates(prev => {
      const next = { ...prev }
      delete next[key]
      delete next[lowerKey]
      return next
    })

    toast.info(t('已将标签「{name}」标记为待删除，点击保存后生效', { name: tagName }))
  }, [])

  // 汇总变更并提交
  const handleSave = async () => {
    // 1. 优先提取当前正在输入的未提交新建标签（支持用户未敲回车直接点击保存）
    const activeNewTags: Record<number, string[]> = {}
    Object.entries(newTagNames).forEach(([dimIdStr, names]) => {
      activeNewTags[Number(dimIdStr)] = [...names]
    })

    if (activeInputDimId !== null && inputVal.trim()) {
      const trimmed = inputVal.trim()
      if (!isExtensionTag(trimmed)) {
        activeNewTags[activeInputDimId] = [
          ...(activeNewTags[activeInputDimId] || []).filter(n => n !== trimmed),
          trimmed
        ]
      }
      setInputVal('')
      setActiveInputDimId(null)
    }

    const fileIds = files
      .map(f => f?.id ?? f?.fileId ?? f?.workspaceFileId ?? f?.path)
      .filter(Boolean)

    const addTags: Array<{ dimensionId: number; dimensionName: string; tagName: string }> = []
    const removeTags: Array<{ dimensionId: number; dimensionName: string; tagName: string }> = []
    const newTags: Array<{ dimensionId: number; dimensionName: string; tagName: string }> = []
    const processedRemoveKeys = new Set<string>()

    for (const [tagKey, state] of Object.entries(tagStates)) {
      const [dimIdStr, ...tagValueParts] = tagKey.split('::')
      const tagValue = tagValueParts.join('::')
      const dimId = Number(dimIdStr)
      const group = fullPresetGroups.find(g => g.id === dimId) || dimensionGroups.find(g => g.id === dimId)
      const dimName = group?.name || '内容标签'

      if (state === 'add_all') {
        addTags.push({ dimensionId: dimId, dimensionName: dimName, tagName: tagValue })
      } else if (state === 'remove_all') {
        removeTags.push({ dimensionId: dimId, dimensionName: dimName, tagName: tagValue })
        processedRemoveKeys.add(`${dimId}::${tagValue.toLowerCase()}`)
      }
    }

    // 收集通过 X 按钮标记删除的标签
    for (const key of deletedTagKeys) {
      const [dimIdStr, ...tagValueParts] = key.split('::')
      const tagValue = tagValueParts.join('::')
      const dimId = Number(dimIdStr)
      const lowerKey = `${dimId}::${tagValue.toLowerCase()}`
      if (!processedRemoveKeys.has(lowerKey)) {
        processedRemoveKeys.add(lowerKey)
        const group = fullPresetGroups.find(g => g.id === dimId) || dimensionGroups.find(g => g.id === dimId)
        const dimName = group?.name || '内容标签'
        removeTags.push({ dimensionId: dimId, dimensionName: dimName, tagName: tagValue })
      }
    }

    for (const [dimIdStr, names] of Object.entries(activeNewTags)) {
      const dimId = Number(dimIdStr)
      const group = fullPresetGroups.find(g => g.id === dimId) || dimensionGroups.find(g => g.id === dimId)
      const dimName = group?.name || '内容标签'
      for (const name of names) {
        if (name && name.trim()) {
          newTags.push({ dimensionId: dimId, dimensionName: dimName, tagName: name.trim() })
        }
      }
    }

    if (addTags.length === 0 && removeTags.length === 0 && newTags.length === 0) {
      toast.info(t('未检测到任何标签变更'))
      return
    }

    await onSaveTags({
      fileIds,
      addTags,
      removeTags,
      newTags
    })
    await loadFullDimensions()
    setTagStates({})
    setNewTagNames({})
    setDeletedTagKeys(new Set())
  }

  // 过滤后的维度与标签列表
  const filteredDimensionGroups = useMemo(() => {
    if (!searchQuery.trim()) return effectiveDimensionGroups
    const q = searchQuery.trim().toLowerCase()
    return effectiveDimensionGroups
      .map(group => {
        const groupMatches = group.name.toLowerCase().includes(q)
        const matchedTags = (group.tags || []).filter(t => t.tagValue.toLowerCase().includes(q))
        const matchedNewTags = (newTagNames[group.id] || []).filter(n => n.toLowerCase().includes(q))

        if (groupMatches) return group
        if (matchedTags.length > 0 || matchedNewTags.length > 0) {
          return {
            ...group,
            tags: matchedTags
          }
        }
        return null
      })
      .filter(Boolean) as DimensionGroup[]
  }, [effectiveDimensionGroups, searchQuery, newTagNames])

  // 拆分为标准分类维度（左列）与泛维度（右列，内容标签固定置于最后）
  const { standardGroups, panGroups } = useMemo(() => {
    const std: DimensionGroup[] = []
    const pan: DimensionGroup[] = []

    for (const group of filteredDimensionGroups) {
      if (isPanDimension(group)) {
        pan.push(group)
      } else {
        std.push(group)
      }
    }

    // 泛维度标签列：将“内容标签”维度（ID=28 或名称包含“内容标签”）放置到最后
    pan.sort((a, b) => {
      const isAContent = a.id === 28 || a.name === '内容标签' || a.name?.includes('内容标签')
      const isBContent = b.id === 28 || b.name === '内容标签' || b.name?.includes('内容标签')
      if (isAContent && !isBContent) return 1
      if (!isAContent && isBContent) return -1
      return 0
    })

    return { standardGroups: std, panGroups: pan }
  }, [filteredDimensionGroups, isPanDimension])

  const hasInspected = Boolean(inspectedFileItem)

  // 渲染单个维度分组卡片
  const renderDimensionGroupCard = (group: DimensionGroup) => {
    const isPan = isPanDimension(group)
    const groupTags = group.tags || []
    const groupNewTags = newTagNames[group.id] || []
    const groupNameLower = group.name.trim().toLowerCase()

    return (
      <div
        key={group.id}
        className="space-y-3 p-4 rounded-2xl bg-card/60 border border-border/50 shadow-2xs hover:border-border/80 transition-colors"
      >
        {/* 维度头部与快捷全选 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-bold text-foreground/90">{group.name}</span>
            <Badge variant="outline" className="text-[10px] h-4.5 px-1.5 font-normal bg-background/80">
              {t('{count} 个标签', {
                count: groupTags.length + groupNewTags.length
              })}
            </Badge>
            {isPan && (
              <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4 bg-primary/10 text-primary border border-primary/20 font-medium">
                {t('泛维度')}
              </Badge>
            )}
          </div>

          {/* 维度快捷操作 */}
          {groupTags.length > 0 && (
            <div className="flex items-center gap-1 opacity-80 hover:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={() => handleBatchSetDimensionTags(group, 'add_all')}
                className="text-[11px] text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 px-1.5 py-0.5 rounded-md hover:bg-emerald-500/10 transition-colors cursor-pointer"
                title={t('全部附加该维度下的所有标签')}
              >
                {t('全附')}
              </button>
              <span className="text-muted-foreground/30 text-xs">|</span>
              <button
                type="button"
                onClick={() => handleBatchSetDimensionTags(group, 'initial')}
                className="text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded-md hover:bg-muted transition-colors cursor-pointer"
                title={t('恢复该维度默认状态')}
              >
                {t('重置')}
              </button>
            </div>
          )}
        </div>

        {/* 标签流动排布 */}
        <div className={cn("flex flex-wrap gap-2 items-center group/taggrid", hasInspected && "tags-has-inspected")}>
          {/* 仅泛维度允许新建标签 */}
          {isPan &&
            (activeInputDimId === group.id ? (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-background rounded-xl border border-primary/60 shadow-xs animate-in zoom-in-95 duration-150">
                <Input
                  autoFocus
                  value={inputVal}
                  onChange={e => setInputVal(e.target.value)}
                  onBlur={() => {
                    if (inputVal.trim()) {
                      handleAddNewTag(group.id)
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleAddNewTag(group.id)
                    if (e.key === 'Escape') {
                      setInputVal('')
                      setActiveInputDimId(null)
                    }
                  }}
                  placeholder={t('输入新标签名...')}
                  className="h-5.5 text-xs w-28 border-0 bg-transparent p-0 focus-visible:ring-0"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-5.5 w-5.5 text-primary hover:text-primary hover:bg-primary/10 rounded-md cursor-pointer"
                  onClick={() => handleAddNewTag(group.id)}
                >
                  <MaterialIcon icon="check" className="text-xs" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-5.5 w-5.5 text-muted-foreground hover:text-foreground rounded-md cursor-pointer"
                  onClick={() => setActiveInputDimId(null)}
                >
                  <MaterialIcon icon="close" className="text-xs" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setActiveInputDimId(group.id)
                  setInputVal('')
                }}
                className={cn(
                  'inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold',
                  'border border-dashed border-primary/50 hover:border-primary text-primary hover:bg-primary/10',
                  'transition-all duration-200 cursor-pointer shadow-2xs'
                )}
              >
                <MaterialIcon icon="add" className="text-xs" />
                <span>{t('新建标签')}</span>
              </button>
            ))}

          {/* 新建标签徽章 */}
          {groupNewTags.map((name, nIdx) => (
            <span
              key={nIdx}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-500/15 border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 shadow-2xs animate-in zoom-in-95 duration-150"
            >
              <MaterialIcon icon="add_circle" className="text-xs" />
              <span>{name}</span>
              <Badge variant="secondary" className="text-[9px] px-1 py-0 h-3.5 bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 font-normal">
                {t('待添加')}
              </Badge>
              <MaterialIcon
                icon="close"
                onClick={() => handleRemoveNewTag(group.id, name)}
                className="text-xs cursor-pointer hover:text-destructive transition-colors ml-0.5"
              />
            </span>
          ))}

          {/* 已有标签列表 - 使用 React.memo 的 TagPill 极大提升交互性能 */}
          {groupTags.map((tag: DimensionTag) => {
            const tagKey = `${group.id}::${tag.tagValue}`
            const count = tagFileCounts[tag.tagValue] || 0
            const state = tagStates[tagKey] || 'initial'

            const isOwnedByInspected = hasInspected
              ? (() => {
                  const lowerTag = tag.tagValue.trim().toLowerCase()
                  return (
                    inspectedTagSet.has(lowerTag) ||
                    inspectedTagSet.has(`${group.id}::${lowerTag}`) ||
                    inspectedTagSet.has(`${groupNameLower}::${lowerTag}`)
                  )
                })()
              : false

            return (
              <TagPill
                key={tagKey}
                dimId={group.id}
                tagName={tag.tagValue}
                tagKey={tagKey}
                count={count}
                totalFilesCount={totalFilesCount}
                state={state}
                isOwnedByInspected={isOwnedByInspected}
                isPan={isPan}
                onToggle={handleToggleTag}
                onDelete={handleDeleteExistingTag}
              />
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden bg-background">
      {/* 1. 选中文件聚焦联动状态条 (Inspector Banner - 浮动显示，脱离文档流，杜绝页面回流与重绘) */}
      {inspectedFileItem && (
        <div className="absolute top-3 left-4 right-4 z-30 px-4 py-3 bg-card/95 dark:bg-card/90 backdrop-blur-md border border-primary/30 rounded-2xl shadow-xl shadow-black/10 flex flex-col gap-2 text-xs transition-all duration-200 animate-in fade-in slide-in-from-top-2">
          {/* 上部：文件信息、标签统计与取消聚焦操作 */}
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              <div className="w-6 h-6 rounded-lg bg-primary/20 text-primary flex items-center justify-center shrink-0">
                <MaterialIcon icon="visibility" className="text-sm" />
              </div>
              <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                <span className="text-muted-foreground shrink-0">{t('当前选中文件:')}</span>
                <span
                  className="font-bold text-foreground truncate max-w-[240px] sm:max-w-[360px]"
                  title={inspectedFileItem.smartName || inspectedFileItem.name}
                >
                  {inspectedFileItem.smartName || inspectedFileItem.name}
                </span>
              </div>
              <Badge variant="outline" className="bg-background/80 text-primary border-primary/30 text-[10px] h-4.5 px-1.5 shrink-0 font-mono font-medium">
                {t('共 {count} 个标签', { count: inspectedFileTagsWithDimension.length })}
              </Badge>
            </div>

            {onClearInspectedFile && (
              <Button
                size="sm"
                variant="destructive"
                onClick={onClearInspectedFile}
                className="h-7 px-3 text-xs font-semibold rounded-xl shadow-xs shrink-0 gap-1.5 cursor-pointer"
                title={t('清除选定文件高亮')}
              >
                <MaterialIcon icon="close" className="text-sm shrink-0" />
                <span>{t('取消聚焦')}</span>
              </Button>
            )}
          </div>

          {/* 下部：当前选中文件的所有标签（带归属维度名称），支持集中查看 */}
          <div className="flex flex-wrap items-center gap-1.5 max-h-24 overflow-y-auto pr-1">
            {inspectedFileTagsWithDimension.length === 0 ? (
              <span className="text-[11px] text-muted-foreground/80 italic">
                {t('该文件暂无归属标签')}
              </span>
            ) : (
              inspectedFileTagsWithDimension.map((item, idx) => (
                <div
                  key={`${item.dimensionName}::${item.tagValue}::${idx}`}
                  className="inline-flex items-center rounded-lg border border-primary/30 bg-background/90 text-xs overflow-hidden shadow-2xs select-none"
                  title={t('归属维度: {dim}', { dim: item.dimensionName })}
                >
                  {/* 所属维度名称 */}
                  <span className="px-1.5 py-0.5 bg-primary/15 text-primary text-[10px] font-semibold border-r border-primary/20 shrink-0">
                    {item.dimensionName}
                  </span>
                  {/* 标签值 */}
                  <span className="px-2 py-0.5 font-medium text-foreground text-xs">
                    {item.tagValue}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 2. 顶部工具栏与全局状态卡片 */}
      <div className="p-4 border-b border-border/50 bg-muted/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shrink-0">
        <div className="space-y-1 min-w-0">
          <div className="text-xs font-bold text-foreground flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-primary/15 text-primary flex items-center justify-center">
              <MaterialIcon icon="label" className="text-xs" />
            </div>
            <span>{t('批量标签工作台 (目标 {count} 个文件)', { count: totalFilesCount })}</span>
            {changeStats.totalChanges > 0 && (
              <div className="flex items-center gap-1.5 ml-2">
                {changeStats.addCount > 0 && (
                  <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 text-[10px] h-4.5 px-1.5">
                    +{changeStats.addCount} {t('附加')}
                  </Badge>
                )}
                {changeStats.removeCount > 0 && (
                  <Badge className="bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30 text-[10px] h-4.5 px-1.5">
                    -{changeStats.removeCount} {t('移除')}
                  </Badge>
                )}
              </div>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>{t('点击标签三态循环：')}</span>
            <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 font-medium">
              <MaterialIcon icon="add_circle" className="text-[11px]" />
              {t('全部附加')}
            </span>
            <span>➔</span>
            <span className="inline-flex items-center gap-0.5 text-rose-600 dark:text-rose-400 font-medium line-through">
              <MaterialIcon icon="do_not_disturb_on" className="text-[11px]" />
              {t('全部移除')}
            </span>
            <span>➔</span>
            <span className="text-foreground/70">{t('恢复原状')}</span>
          </div>
        </div>

        {/* 快速搜索与重置控制 */}
        <div className="flex items-center gap-2 self-stretch sm:self-auto shrink-0">
          <div className="relative flex-1 sm:w-48">
            <MaterialIcon
              icon="search"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none"
            />
            <Input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('搜索标签或维度...')}
              className="h-7.5 pl-7 pr-7 text-xs bg-background/80 rounded-xl border-border/60 focus-visible:ring-1"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <MaterialIcon icon="close" className="text-xs" />
              </button>
            )}
          </div>

          {changeStats.totalChanges > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleResetAllChanges}
              className="h-7.5 px-2.5 text-xs text-muted-foreground hover:text-foreground rounded-xl shrink-0 gap-1 cursor-pointer"
              title={t('重置所有未保存的标签变更')}
            >
              <MaterialIcon icon="restart_alt" className="text-xs" />
              <span>{t('重置')}</span>
            </Button>
          )}
        </div>
      </div>

      {/* 3. 两列独立滚动与支持调整宽度的 SplitPane (左列：分类维度；右列：泛维度标签) */}
      <div className="flex-1 overflow-hidden min-h-0 relative">
        {filteredDimensionGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-2 h-full">
            <MaterialIcon icon="search_off" className="text-3xl text-muted-foreground/50" />
            <p className="text-xs font-semibold text-foreground/80">{t('未找到匹配的维度或标签')}</p>
            <p className="text-[11px] text-muted-foreground">{t('请尝试更换搜索词或新建标签')}</p>
          </div>
        ) : (
          <SplitPane
            direction="horizontal"
            storageKey="batch-tag-view-split"
            className="h-full w-full"
            sections={[
              {
                id: 'standard-dimensions',
                type: 'flex' as const,
                defaultSize: 1,
                minSize: 260,
                content: (
                  <div className="flex flex-col h-full w-full overflow-hidden bg-background">
                    {/* 左列固定置顶标题栏 */}
                    <div className="px-4 py-2.5 border-b border-border/60 bg-muted/25 shrink-0 flex items-center justify-between gap-2 select-none">
                      <div className="flex items-center gap-2">
                        <MaterialIcon icon="category" className="text-sm text-primary" />
                        <span className="text-xs font-bold text-foreground">{t('分类维度')}</span>
                        <Badge variant="outline" className="text-[10px] h-4.5 px-1.5 font-normal text-muted-foreground bg-background">
                          {standardGroups.length}
                        </Badge>
                      </div>
                    </div>
                    {/* 左列独立滚动区域 */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                      {standardGroups.length === 0 ? (
                        <div className="p-8 text-center text-xs text-muted-foreground bg-muted/10 rounded-2xl border border-dashed border-border/50">
                          {t('无匹配的分类维度')}
                        </div>
                      ) : (
                        standardGroups.map(group => renderDimensionGroupCard(group))
                      )}
                    </div>
                  </div>
                )
              },
              {
                id: 'pan-dimensions',
                type: 'flex' as const,
                defaultSize: 1,
                minSize: 260,
                content: (
                  <div className="flex flex-col h-full w-full overflow-hidden bg-background">
                    {/* 右列固定置顶标题栏 */}
                    <div className="px-4 py-2.5 border-b border-border/60 bg-muted/25 shrink-0 flex items-center justify-between gap-2 select-none">
                      <div className="flex items-center gap-2">
                        <MaterialIcon icon="label" className="text-sm text-primary" />
                        <span className="text-xs font-bold text-foreground">{t('泛维度标签')}</span>
                        <Badge variant="outline" className="text-[10px] h-4.5 px-1.5 font-normal text-muted-foreground bg-background">
                          {panGroups.length}
                        </Badge>
                      </div>
                    </div>
                    {/* 右列独立滚动区域 */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                      {panGroups.length === 0 ? (
                        <div className="p-8 text-center text-xs text-muted-foreground bg-muted/10 rounded-2xl border border-dashed border-border/50">
                          {t('无匹配的泛维度标签')}
                        </div>
                      ) : (
                        panGroups.map(group => renderDimensionGroupCard(group))
                      )}
                    </div>
                  </div>
                )
              }
            ]}
          />
        )}
      </div>

      {/* 隐藏的保存打标触发器，供外部顶栏调用 */}
      <button
        id="btn-save-tags-trigger"
        type="button"
        className="hidden"
        onClick={handleSave}
        disabled={isSaving}
      />
    </div>
  )
}
