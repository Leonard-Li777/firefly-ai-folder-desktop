import React, { useState, useMemo, useEffect } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Badge } from '../../../ui/badge'
import { DimensionGroup, DimensionTag, BatchTagOperation } from '@firefly/types'
import {
  isExtensionDimension,
  isPanDimension as checkIsPanDimension,
  filterDimensionTags
} from '@firefly/shared'
import { toast } from '../../../common/Toast'

export { isExtensionDimension }

interface BatchTagViewProps {
  files: any[]
  dimensionGroups: DimensionGroup[]
  panDimensionIds?: number[]
  onSaveTags: (changes: BatchTagOperation) => Promise<void>
  onDeleteTagGlobally: (dimensionId: number, tagName: string) => Promise<boolean>
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

export const BatchTagView: React.FC<BatchTagViewProps> = ({
  files,
  dimensionGroups = [],
  panDimensionIds = [4, 28],
  onSaveTags,
  onDeleteTagGlobally,
  isSaving = false,
  inspectedFile = null,
  onClearInspectedFile
}) => {
  const totalFilesCount = files.length

  // 每个已有标签的状态映射: `${dimensionId}::${tagValue}` -> TagActionState
  const [tagStates, setTagStates] = useState<Record<string, TagActionState>>({})
  // 新建标签列表: dimensionId -> string[]
  const [newTagNames, setNewTagNames] = useState<Record<number, string[]>>({})
  // 正在内嵌输入的维度ID
  const [activeInputDimId, setActiveInputDimId] = useState<number | null>(null)
  const [inputVal, setInputVal] = useState('')
  // 搜索关键字
  const [searchQuery, setSearchQuery] = useState('')
  // 异步获取的全量预设维度定义（包含当前文件集合未拥有的所有预设标签）
  const [fullPresetGroups, setFullPresetGroups] = useState<DimensionGroup[]>([])

  // 挂载时拉取全量预设维度与标签数据
  useEffect(() => {
    let isMounted = true
    const loadFullDimensions = async () => {
      try {
        const res = await window.electronAPI?.analyzedDirectory?.getDimensionGroups({
          includeAllPresetTags: true,
          excludeExtensionDimension: true
        })
        if (isMounted && res?.groups && res.groups.length > 0) {
          setFullPresetGroups(res.groups)
        }
      } catch (err) {
        console.warn('[BatchTagView] 加载全量预设维度失败，使用传入的维度数据:', err)
      }
    }
    loadFullDimensions()
    return () => {
      isMounted = false
    }
  }, [])

  // 合并全量预设维度与传入维度，保证如作品来源、内容尺度等维度所有预设标签完整展现
  const effectiveDimensionGroups = useMemo(() => {
    const sourceGroups = fullPresetGroups.length > 0 ? fullPresetGroups : dimensionGroups
    // 过滤排除扩展名维度（纯 ID 集合与 Level 3 判断，多语言安全）
    const nonExtGroups = sourceGroups.filter(g => !isExtensionDimension(g))

    return nonExtGroups.map(group => {
      // 过滤排除首部或尾部的预设扩展名触发标签
      const rawTags = group.tags || []
      const allowedTagValues = new Set(
        filterDimensionTags({ id: group.id, tags: rawTags.map(t => t.tagValue) })
      )
      const validTags = rawTags.filter(
        t => allowedTagValues.has(t.tagValue) && !isExtensionTag(t.tagValue)
      )
      return {
        ...group,
        tags: validTags
      }
    })
  }, [fullPresetGroups, dimensionGroups])

  // 判断是否为泛维度（使用共享纯 ID 集合判定）
  const isPanDimension = (group: DimensionGroup) => {
    return checkIsPanDimension(group, panDimensionIds)
  }

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

  // 计算每个标签在当前待整理文件集中的拥有数量
  const tagFileCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const f of files) {
      const fileTagSet = new Set<string>()

      if (Array.isArray(f.dimensionTags)) {
        for (const dt of f.dimensionTags) {
          const val = dt?.tag ?? dt?.tagValue ?? dt?.name
          if (val) fileTagSet.add(String(val).trim())
        }
      }

      if (Array.isArray(f.tags)) {
        for (const t of f.tags) {
          if (typeof t === 'string') {
            fileTagSet.add(t.trim())
          } else if (t && typeof t === 'object') {
            const val = t.tagValue || t.tagName || t.name || t.value || t.tag
            if (val) fileTagSet.add(String(val).trim())
          }
        }
      }

      fileTagSet.forEach(tagVal => {
        counts[tagVal] = (counts[tagVal] || 0) + 1
      })
    }
    return counts
  }, [files])

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
    return { addCount, removeCount, totalChanges: addCount + removeCount }
  }, [tagStates, newTagNames])

  // 处理标签点击三态循环 (Initial -> Add All -> Remove All -> Initial)
  const handleToggleTag = (tagKey: string) => {
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
  }

  // 重置全部标签变更
  const handleResetAllChanges = () => {
    setTagStates({})
    setNewTagNames({})
    toast.info(t('已重置所有未保存的标签变更'))
  }

  // 快速全选某维度下的全部标签为全部附加
  const handleBatchSetDimensionTags = (group: DimensionGroup, targetState: TagActionState) => {
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
  }

  // 提交新建标签
  const handleAddNewTag = (dimensionId: number) => {
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
  }

  // 删除新建标签
  const handleRemoveNewTag = (dimensionId: number, name: string) => {
    setNewTagNames(prev => ({
      ...prev,
      [dimensionId]: (prev[dimensionId] || []).filter(n => n !== name)
    }))
  }

  // 全局即时删除标签
  const handleDeleteExistingTag = async (dimId: number, tagName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const success = await onDeleteTagGlobally(dimId, tagName)
    if (success) {
      toast.success(t('已全局删除标签「{name}」', { name: tagName }))
    }
  }

  // 汇总变更并提交
  const handleSave = async () => {
    const fileIds = files.map(f => f.id).filter(Boolean)
    const addTags: Array<{ dimensionId: number; dimensionName: string; tagName: string }> = []
    const removeTags: Array<{ dimensionId: number; dimensionName: string; tagName: string }> = []
    const newTags: Array<{ dimensionId: number; dimensionName: string; tagName: string }> = []

    for (const [tagKey, state] of Object.entries(tagStates)) {
      const [dimIdStr, tagValue] = tagKey.split('::')
      const dimId = Number(dimIdStr)
      const group = effectiveDimensionGroups.find(g => g.id === dimId)
      const dimName = group?.name || '内容标签'

      if (state === 'add_all') {
        addTags.push({ dimensionId: dimId, dimensionName: dimName, tagName: tagValue })
      } else if (state === 'remove_all') {
        removeTags.push({ dimensionId: dimId, dimensionName: dimName, tagName: tagValue })
      }
    }

    for (const [dimIdStr, names] of Object.entries(newTagNames)) {
      const dimId = Number(dimIdStr)
      const group = effectiveDimensionGroups.find(g => g.id === dimId)
      const dimName = group?.name || '内容标签'
      for (const name of names) {
        newTags.push({ dimensionId: dimId, dimensionName: dimName, tagName: name })
      }
    }

    await onSaveTags({
      fileIds,
      addTags,
      removeTags,
      newTags
    })
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

  const inspectedFileItem = Array.isArray(inspectedFile) ? inspectedFile[0] : inspectedFile

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* 1. 选中文件聚焦联动状态条 (Inspector Banner) */}
      {inspectedFileItem && (
        <div className="px-4 py-2.5 bg-primary/10 border-b border-primary/20 flex items-center justify-between gap-3 text-xs shrink-0 transition-all duration-200 animate-in fade-in slide-in-from-top-1">
          <div className="flex items-center gap-2 min-w-0 overflow-hidden">
            <div className="w-6 h-6 rounded-lg bg-primary/20 text-primary flex items-center justify-center shrink-0">
              <MaterialIcon icon="visibility" className="text-sm" />
            </div>
            <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
              <span className="text-muted-foreground shrink-0">{t('当前选中文件:')}</span>
              <span
                className="font-bold text-foreground truncate max-w-[240px] sm:max-w-[320px]"
                title={inspectedFileItem.smartName || inspectedFileItem.name}
              >
                {inspectedFileItem.smartName || inspectedFileItem.name}
              </span>
            </div>
            <Badge variant="outline" className="bg-background/80 text-primary border-primary/30 text-[10px] h-4.5 px-1.5 shrink-0 font-medium">
              <MaterialIcon icon="check_circle" className="text-[11px] mr-1 text-primary" />
              {t('已高亮展示该文件的标签')}
            </Badge>
          </div>

          {onClearInspectedFile && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onClearInspectedFile}
              className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground shrink-0 gap-1 rounded-lg cursor-pointer"
              title={t('清除选定文件高亮')}
            >
              <MaterialIcon icon="close" className="text-xs" />
              <span>{t('取消聚焦')}</span>
            </Button>
          )}
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
              className="h-7.5 px-2.5 text-xs text-muted-foreground hover:text-foreground rounded-xl shrink-0 gap-1"
              title={t('重置所有未保存的标签变更')}
            >
              <MaterialIcon icon="restart_alt" className="text-xs" />
              <span>{t('重置')}</span>
            </Button>
          )}
        </div>
      </div>

      {/* 3. 横向标签流列表区 */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {filteredDimensionGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-2">
            <MaterialIcon icon="search_off" className="text-3xl text-muted-foreground/50" />
            <p className="text-xs font-semibold text-foreground/80">{t('未找到匹配的维度或标签')}</p>
            <p className="text-[11px] text-muted-foreground">{t('请尝试更换搜索词或新建标签')}</p>
          </div>
        ) : (
          filteredDimensionGroups.map(group => {
            const isPan = isPanDimension(group)
            const groupTags = group.tags || []
            const groupNewTags = newTagNames[group.id] || []

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

                {/* 横向同级标签流 */}
                <div className="flex flex-wrap gap-2.5 items-center">
                  {/* 仅泛维度首位提供：新建标签 + 按钮 */}
                  {isPan &&
                    (activeInputDimId === group.id ? (
                      <div className="inline-flex items-center gap-1 bg-background border border-primary rounded-xl px-2 py-0.5 shadow-xs animate-in zoom-in-95 duration-150">
                        <Input
                          value={inputVal}
                          onChange={e => setInputVal(e.target.value)}
                          placeholder={t('输入新标签名')}
                          className="h-6.5 text-xs w-32 border-none focus-visible:ring-0 p-0"
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleAddNewTag(group.id)
                            if (e.key === 'Escape') setActiveInputDimId(null)
                          }}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5.5 w-5.5 text-primary hover:bg-primary/10 rounded-md cursor-pointer"
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

                  {/* 已有标签列表 */}
                  {groupTags.map((tag: DimensionTag) => {
                    const tagKey = `${group.id}::${tag.tagValue}`
                    const count = tagFileCounts[tag.tagValue] || 0
                    const ratio = totalFilesCount > 0 ? count / totalFilesCount : 0
                    const state = tagStates[tagKey] || 'initial'

                    // 判断是否被当前聚焦选中的文件拥有
                    const isOwnedByInspected =
                      Boolean(inspectedFileItem) &&
                      (inspectedTagSet.has(tag.tagValue.trim().toLowerCase()) ||
                        inspectedTagSet.has(`${group.id}::${tag.tagValue.trim().toLowerCase()}`) ||
                        inspectedTagSet.has(`${group.name.trim().toLowerCase()}::${tag.tagValue.trim().toLowerCase()}`))

                    // 状态与覆盖率
                    const isAllAttached = state === 'add_all'
                    const isAllRemoved = state === 'remove_all'
                    const isFullyOwned = ratio >= 1 && state === 'initial'
                    const isPartial = ratio > 0 && ratio < 1 && state === 'initial'

                    return (
                      <div
                        key={tagKey}
                        onClick={() => handleToggleTag(tagKey)}
                        className={cn(
                          'group relative overflow-hidden inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium cursor-pointer',
                          'border transition-all duration-200 select-none shadow-2xs',
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
                          // 当前聚焦文件拥有时的突出展示（单 border，无 ring 双边框）
                          isOwnedByInspected &&
                            'border-primary bg-primary/15 text-primary font-bold shadow-xs z-10',
                          // 有聚焦文件但未被拥有时的柔和淡化
                          inspectedFileItem && !isOwnedByInspected && 'opacity-40 hover:opacity-100 transition-opacity'
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
                            className="absolute inset-y-0 left-0 bg-primary/20 transition-all duration-300 pointer-events-none rounded-xl"
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
                        <span className="relative z-10">{tag.tagValue}</span>

                        {/* 当前选中文件拥有时的 Badge 标识 */}
                        {isOwnedByInspected && (
                          <span className="relative z-10 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-primary text-primary-foreground text-[9px] font-bold shadow-xs">
                            <MaterialIcon icon="check" className="text-[10px]" />
                            <span>{t('拥有')}</span>
                          </span>
                        )}

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
                                  : 'bg-background/80 text-muted-foreground border border-border/40'
                          )}
                        >
                          {isAllAttached
                            ? `${totalFilesCount}/${totalFilesCount}`
                            : isAllRemoved
                              ? `0/${totalFilesCount}`
                              : `${count}/${totalFilesCount}`}
                        </span>

                        {/* 仅泛维度的标签在 hover 时渲染删除 X 按钮 */}
                        {isPan && (
                          <button
                            type="button"
                            title={t('全局删除该标签')}
                            onClick={e => handleDeleteExistingTag(group.id, tag.tagValue, e)}
                            className={cn(
                              'relative z-10 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity p-0.5 rounded cursor-pointer ml-0.5',
                              isAllAttached || isFullyOwned ? 'hover:text-white/80' : ''
                            )}
                          >
                            <MaterialIcon icon="close" className="text-[11px]" />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 4. 底部操作区 */}
      <div className="p-3 border-t border-border/50 bg-muted/10 flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">
          {changeStats.totalChanges > 0
            ? t('当前有 {count} 项未保存变更，点击「保存打标」同步', { count: changeStats.totalChanges })
            : t('配置完成后点击「保存打标」同步更新数据库')}
        </span>
        <Button
          id="btn-save-tags-trigger"
          size="sm"
          onClick={handleSave}
          disabled={isSaving}
          className="h-8 px-4 text-xs font-bold gap-1.5 bg-primary hover:bg-primary/90 shadow-xs cursor-pointer rounded-xl"
        >
          <MaterialIcon
            icon={isSaving ? 'sync' : 'save'}
            className={cn('text-sm', isSaving && 'animate-spin')}
          />
          <span>{isSaving ? t('正在保存...') : t('保存打标')}</span>
        </Button>
      </div>
    </div>
  )
}
