import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import { DimensionGroup, DimensionTag, SelectedTag, UnionMode } from '@firefly/types'
import { MaterialIcon, cn } from '../../lib/utils'
import { DimensionTreeNode } from './AnalyzedDirectory/types'
import { Checkbox } from '../ui/checkbox'
import { t } from '@app/languages'
import {
  makeTagKey,
  parseTagKey,
  buildDimensionTree,
  getVisibleAndHiddenTags,
  getSelectedTagsFromSet,
  resolveTagsToUse,
  getAllKeys,
  migrateTagKeysAcrossScale
} from './dimension-tree-utils'

/**
 * 稳定空数组引用（模块级常量）：
 * 若作为默认参数每次渲染都新建 `[]`，会击穿 handleVisibleAndHiddenTags / visibleGroups 的
 * useMemo 依赖，导致每渲染（含滚动事件）全量重建树与穿透提升 DFS，威胁 60FPS 单帧 <1ms (AC-3)。
 */
const EMPTY_PAN_DIMENSION_IDS: number[] = []

export interface DimensionTreeSidebarProps {
  dimensionGroups: DimensionGroup[]
  showEmptyTags?: boolean
  panDimensionIds?: number[]
  isExportMode?: boolean
  showSelectAll?: boolean
  storageKey?: string
  workspacePath?: string
  onSelectionChange?: (
    tags: Set<string>,
    reason: 'toggle' | 'selectAll' | 'invert' | 'clear',
    parentTagMap: Map<string, string[]>
  ) => void
  onModeChange?: (mode: UnionMode) => void
  onTagClick?: (tag: SelectedTag) => void
  className?: string
  initialUnionMode?: UnionMode
}

// 内部树节点渲染组件
interface DimensionTreeNodeProps {
  node: DimensionTreeNode
  parentTagValue?: string
  ancestorChain?: string[]
  isExportMode: boolean
  collapsedDimensionGroups: Set<number>
  toggleDimensionGroupCollapsed: (groupId: number) => void
  isTagSelected: (
    dimensionId: number,
    tagValue: string,
    parentTagValue?: string,
    viaParentCode?: string,
    isLifted?: boolean,
    codePath?: string
  ) => boolean
  toggleTagSelection: (
    dimensionId: number,
    tagValue: string,
    parentTagValue?: string,
    ancestorChain?: string[],
    viaParentCode?: string,
    isLifted?: boolean
  ) => void
  getVisibleAndHiddenTags: (
    group: any,
    childTags?: Map<string, DimensionTreeNode[]>
  ) => { tagsToShow: DimensionTag[] }
  handleTagClick: (tag: any) => void
  renderRecursive: (
    node: DimensionTreeNode,
    parentTagValue?: string,
    ancestorChain?: string[]
  ) => React.ReactNode
}

const DimensionTreeNodeComponent: React.FC<DimensionTreeNodeProps> = React.memo(
  ({
    node,
    parentTagValue,
    ancestorChain,
    isExportMode,
    collapsedDimensionGroups,
    toggleDimensionGroupCollapsed,
    isTagSelected,
    toggleTagSelection,
    getVisibleAndHiddenTags,
    handleTagClick,
    renderRecursive
  }) => {
    const [collapsedTags, setCollapsedTags] = useState<Set<string>>(() => new Set())

    const toggleTagCollapse = useCallback((tagValue: string) => {
      setCollapsedTags(prev => {
        const next = new Set(prev)
        if (next.has(tagValue)) {
          next.delete(tagValue)
        } else {
          next.add(tagValue)
        }
        return next
      })
    }, [])

    let tagsToUse = node.tags
    if (parentTagValue && node.contextualTags && node.contextualTags[parentTagValue]) {
      const isL3Ext = /扩展名|Extension/i.test(node.name)
      if (!isL3Ext) {
        tagsToUse = node.contextualTags[parentTagValue]
      }
    }

    const { tagsToShow } = getVisibleAndHiddenTags({ ...node, tags: tagsToUse }, node.childTags)
    const isCollapsed = collapsedDimensionGroups.has(node.id)
    const isTopLevel = node.level === 0

    // 对于根级，如果其下没有子标签，则根级数据不应输出，也不应展示
    if (isTopLevel && tagsToShow.length === 0) {
      return null
    }

    return (
      <div key={`${node.id}-${parentTagValue || 'root'}`} className="dimension-group relative">
        {isTopLevel && (
          <div className="flex items-center justify-between mb-1 relative z-10">
            <h3
              className="text-sm font-semibold text-foreground/90 dark:text-foreground/90 hover:text-primary dark:hover:text-primary cursor-pointer transition-colors flex items-center flex-1 py-1"
              onClick={() => toggleDimensionGroupCollapsed(node.id)}
            >
              <div className="w-4 h-4 flex items-center justify-center mr-1">
                <MaterialIcon
                  icon={isCollapsed ? 'chevron_right' : 'expand_more'}
                  className="text-base text-muted-foreground"
                />
              </div>
              {node.name}
            </h3>
          </div>
        )}

        {!isCollapsed && (
          <div className={cn('relative', isTopLevel ? 'ml-5 mt-1' : 'ml-3')}>
            {tagsToShow.map((tag: DimensionTag, index: number) => {
              const isSelected = isTagSelected(
                tag.dimensionId,
                tag.tagValue,
                parentTagValue,
                tag.viaParentCode || undefined,
                tag.isLifted === true,
                tag.codePath
              )
              const isDisabled = tag.fileCount === 0
              const childDimensions = node.childTags?.get(tag.tagValue)
              const hasChildDimensions = childDimensions && childDimensions.length > 0
              const isLastTagInThisDim = index === tagsToShow.length - 1
              const isTagCollapsed = collapsedTags.has(tag.tagValue)
              const currentChain = ancestorChain ? [...ancestorChain, tag.tagValue] : [tag.tagValue]

              return (
                <div
                  key={`${tag.dimensionId}-${tag.tagValue}-${index}`}
                  className="flex flex-col relative"
                >
                  {!isExportMode && (
                    <div
                      className={cn(
                        'absolute border-l border-b border-border/20 pointer-events-none z-0',
                        isTopLevel && index === 0 ? 'top-[-4px]' : 'top-0'
                      )}
                      style={{
                        left: isTopLevel ? '-12px' : '-8px',
                        width: isTopLevel ? '12px' : '8px',
                        height: '15px'
                      }}
                    />
                  )}

                  <div className="flex items-center group min-h-[30px] relative">
                    {hasChildDimensions && (
                      <button
                        className="p-0.5 hover:bg-accent dark:hover:bg-accent/40 rounded-sm text-muted-foreground hover:text-foreground transition-colors mr-0.5 shrink-0 flex items-center justify-center cursor-pointer z-10 w-4.5 h-4.5"
                        onClick={e => {
                          e.stopPropagation()
                          toggleTagCollapse(tag.tagValue)
                        }}
                      >
                        <MaterialIcon
                          icon="keyboard_arrow_right"
                          className={cn(
                            'text-sm transition-transform duration-200',
                            !isTagCollapsed && 'transform rotate-90'
                          )}
                        />
                      </button>
                    )}
                    {!hasChildDimensions && <div className="w-5 shrink-0" />}

                    {isExportMode && (
                      <div
                        className="p-1 cursor-pointer hover:bg-accent/40 rounded-sm flex-shrink-0 flex items-center mr-1"
                        onClick={e => {
                          e.stopPropagation()
                          if (!isDisabled) {
                            toggleTagSelection(
                              tag.dimensionId,
                              tag.tagValue,
                              parentTagValue,
                              currentChain,
                              tag.viaParentCode || undefined,
                              tag.isLifted === true
                            )
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isDisabled}
                          onChange={() =>
                            toggleTagSelection(
                              tag.dimensionId,
                              tag.tagValue,
                              parentTagValue,
                              currentChain,
                              tag.viaParentCode || undefined,
                              tag.isLifted === true
                            )
                          }
                          className="w-3.5 h-3.5 rounded border border-border/80 accent-primary cursor-pointer shrink-0"
                          onClick={e => e.stopPropagation()}
                        />
                      </div>
                    )}

                    <button
                      data-selected={isSelected ? 'true' : 'false'}
                      className={cn(
                        'flex-1 text-xs px-1.5 py-1.5 flex items-center rounded-sm overflow-hidden border-l-2 gap-1 duration-0 select-none',
                        isSelected
                          ? 'bg-primary/10 text-primary font-medium border-primary'
                          : 'text-foreground/80 hover:bg-accent hover:text-accent-foreground border-transparent',
                        isDisabled
                          ? 'text-muted-foreground/45 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground/45'
                          : 'cursor-pointer'
                      )}
                      onClick={() => {
                        if (isDisabled) return
                        if (isExportMode) {
                          toggleTagSelection(
                            tag.dimensionId,
                            tag.tagValue,
                            parentTagValue,
                            currentChain,
                            tag.viaParentCode || undefined,
                            tag.isLifted === true
                          )
                        } else {
                          handleTagClick({
                            dimensionId: tag.dimensionId,
                            dimensionName: tag.dimensionName,
                            tagValue: tag.tagValue,
                            code: tag.code,
                            codePath: tag.codePath,
                            namePath: tag.namePath,
                            codePaths: tag.codePaths,
                            isLifted: tag.isLifted === true,
                            viaParentCode: tag.viaParentCode || undefined,
                            level: tag.level,
                            parentTagValue,
                            ancestorChain: currentChain
                          })
                        }
                      }}
                      disabled={isDisabled}
                    >
                      <span className="flex-1 text-left truncate text-current">{tag.tagValue}</span>
                      <span className="text-[10px] ml-1 shrink-0 opacity-55 text-current">
                        ({tag.fileCount})
                      </span>
                    </button>
                  </div>

                  {hasChildDimensions && !isTagCollapsed && (
                    <div className="relative">
                      {childDimensions!.map(childNode =>
                        renderRecursive(childNode, tag.tagValue, currentChain)
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {isTopLevel && (
          <div className="border-t border-border/40 dark:border-border/30 my-3 mx-[-16px]"></div>
        )}
      </div>
    )
  }
)
// 单独提取的树节点渲染行组件，使用 React.memo 进行细粒度隔离
interface DimensionTreeRowProps {
  row: any
  isExportMode?: boolean
  toggleDimensionGroupCollapsed: (id: number) => void
  toggleTagExpand: (tagValue: string) => void
  toggleTagSelection: (
    dimensionId: number,
    tagValue: string,
    parentTagValue?: string,
    ancestorChain?: string[],
    viaParentCode?: string,
    /** 是否为穿透提升聚合行（key 打 liftCode 标记，ADR-0034 §4 / M-4） */
    isLifted?: boolean
  ) => void
  handleTagClickInternal: (tag: any) => void
}

const DimensionTreeRow = React.memo<DimensionTreeRowProps>(
  ({
    row,
    isExportMode,
    toggleDimensionGroupCollapsed,
    toggleTagExpand,
    toggleTagSelection,
    handleTagClickInternal
  }) => {
    if (row.type === 'header' && row.node) {
      return (
        <div className="dimension-group relative mb-2">
          {/* 维度名称向下贯穿到底部 Tag 节点的垂直竖线 (精确左移 8px，100% 绝对对齐维度名称前的箭头中心) */}
          {!row.isCollapsed && (
            <div
              className="absolute border-l border-muted-foreground/45 dark:border-muted-foreground/35 pointer-events-none z-0"
              style={{
                left: '8px',
                top: '26px',
                bottom: '-8px'
              }}
            />
          )}
          <div className="flex items-center justify-between mb-1 relative z-10">
            <h3
              className="text-sm font-semibold text-primary cursor-pointer transition-colors flex items-center flex-1 py-1"
              onClick={() => toggleDimensionGroupCollapsed(row.node!.id)}
            >
              <div className="w-4 h-4 flex items-center justify-center mr-1">
                <MaterialIcon
                  icon={row.isCollapsed ? 'chevron_right' : 'expand_more'}
                  className="text-base text-primary transition-colors"
                />
              </div>
              {row.node!.name}
            </h3>
          </div>
        </div>
      )
    }

    if (row.type === 'tag' && row.tag) {
      const tag = row.tag
      return (
        <div
          className="flex items-center group min-h-[25px] relative h-[26px]"
          style={{ paddingLeft: `${(row.depth || 0) * 18 + 0}px` }}
        >
          {/* 贯穿每一个 L2 / L3 父级标签中轴线的多重深层垂直贯线 │ (8px 基准，绝对对齐维度名称前的箭头) */}
          {(row.depth || 0) > 0 &&
            Array.from({ length: row.depth || 0 }).map((_, d) => (
              <div
                key={`ancestor-v-line-${d}`}
                className="absolute border-l border-muted-foreground/45 dark:border-muted-foreground/35 pointer-events-none z-0"
                style={{
                  left: `${d * 18 + 8}px`,
                  top: 0,
                  height: '100%'
                }}
              />
            ))}

          {/* 本层级的 ├── 树分支与贯穿线 */}
          <div
            className="absolute border-l border-muted-foreground/45 dark:border-muted-foreground/35 pointer-events-none z-0"
            style={{
              left: `${(row.depth || 0) * 18 + 8}px`,
              top: 0,
              height: row.isLastInGroup ? '13px' : '100%'
            }}
          />
          {/* 分支横线 ─ */}
          <div
            className="absolute border-b border-muted-foreground/45 dark:border-muted-foreground/35 pointer-events-none z-0"
            style={{
              left: `${(row.depth || 0) * 18 + 8}px`,
              top: 0,
              width: '10px',
              height: '13px'
            }}
          />

          {/* 箭头与 Dot 节点的垂直统一 Icon 框 (-ml-0.5 稍微左移 2px，完美压在 8px 连线上) */}
          <div className="w-5 h-5 flex items-center justify-center shrink-0 mr-0.5 z-10 -ml-0.5">
            {row.hasChildDimensions ? (
              <button
                className="p-0.5 hover:bg-accent rounded-sm text-muted-foreground hover:text-foreground transition-colors shrink-0 flex items-center justify-center cursor-pointer w-4.5 h-4.5"
                onClick={e => {
                  e.stopPropagation()
                  toggleTagExpand(tag.tagValue)
                }}
              >
                <MaterialIcon
                  icon="keyboard_arrow_right"
                  className={cn(
                    'text-sm text-foreground hover:text-primary transition-transform duration-200',
                    row.isTagExpanded && 'transform rotate-90'
                  )}
                />
              </button>
            ) : row.depth > 0 ? (
              <span className="w-1 h-1 rounded-full bg-muted-foreground/15 shrink-0" />
            ) : null}
          </div>

          {isExportMode && (
            <div
              className="p-0.5 cursor-pointer hover:bg-accent/40 rounded-sm flex-shrink-0 flex items-center mr-1"
              onClick={e => {
                e.stopPropagation()
                if (!row.isDisabled) {
                  toggleTagSelection(
                    tag.dimensionId,
                    tag.tagValue,
                    row.parentTagValue,
                    row.ancestorChain,
                    tag.viaParentCode || undefined,
                    tag.isLifted === true
                  )
                }
              }}
            >
              <input
                type="checkbox"
                checked={row.isSelected}
                disabled={row.isDisabled}
                onChange={() =>
                  toggleTagSelection(
                    tag.dimensionId,
                    tag.tagValue,
                    row.parentTagValue,
                    row.ancestorChain,
                    tag.viaParentCode || undefined,
                    tag.isLifted === true
                  )
                }
                className="w-3.5 h-3.5 rounded border border-border/80 accent-primary cursor-pointer shrink-0"
                onClick={e => e.stopPropagation()}
              />
            </div>
          )}

          <button
            data-selected={row.isSelected ? 'true' : 'false'}
            className={cn(
              'flex-1 text-xs px-1.5 py-0.5 flex items-center rounded-sm overflow-hidden border-l-2 gap-1 duration-0 select-none h-[24px]',
              row.depth > 0 && 'text-[11px]',
              row.isSelected
                ? 'bg-primary/10 text-primary font-medium border-primary'
                : 'text-foreground/80 hover:bg-accent hover:text-accent-foreground border-transparent',
              row.isDisabled
                ? 'text-muted-foreground/45 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground/45'
                : 'cursor-pointer'
            )}
            onClick={() => {
              if (row.isDisabled) return
              if (isExportMode) {
                toggleTagSelection(
                  tag.dimensionId,
                  tag.tagValue,
                  row.parentTagValue,
                  row.ancestorChain,
                  tag.viaParentCode || undefined,
                  tag.isLifted === true
                )
              } else {
                handleTagClickInternal({
                  dimensionId: tag.dimensionId,
                  dimensionName: tag.dimensionName,
                  tagValue: tag.tagValue,
                  code: tag.code,
                  codePath: tag.codePath,
                  namePath: tag.namePath,
                  // 穿透提升跨分支聚合标签携带完整物化路径集合，保证 FileList 视野零丢失 (ADR-0034 §4 / M-4)
                  codePaths: tag.codePaths,
                  isLifted: tag.isLifted === true,
                  viaParentCode: tag.viaParentCode || undefined,
                  level: tag.level,
                  parentTagValue: row.parentTagValue,
                  ancestorChain: row.ancestorChain
                })
              }
            }}
            disabled={row.isDisabled}
          >
            <span className="flex-1 text-left truncate text-current">{tag.tagValue}</span>
            <span className="text-[10px] ml-1 shrink-0 opacity-55 text-current">
              ({tag.fileCount})
            </span>
          </button>
        </div>
      )
    }
    return null
  }
)
DimensionTreeRow.displayName = 'DimensionTreeRow'

export const DimensionTreeSidebar: React.FC<DimensionTreeSidebarProps> = ({
  dimensionGroups,
  showEmptyTags = false,
  panDimensionIds = EMPTY_PAN_DIMENSION_IDS,
  isExportMode = false,
  showSelectAll = false,
  storageKey,
  workspacePath,
  onSelectionChange,
  onModeChange,
  onTagClick,
  className,
  initialUnionMode = 'union'
}) => {
  // 1. Internal states
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => {
    if (storageKey && isExportMode) {
      try {
        const saved = localStorage.getItem(`${storageKey}_selectedTags`)
        if (saved) return new Set<string>(JSON.parse(saved))
      } catch (error) {
        console.error('Failed to load selected tags from localStorage:', error)
      }
    }
    return new Set<string>()
  })

  const [selectionStack, setSelectionStack] = useState<string[]>(() => {
    if (storageKey && isExportMode) {
      try {
        const saved = localStorage.getItem(`${storageKey}_selectionStack`)
        if (saved) return JSON.parse(saved)
      } catch (error) {
        console.error('Failed to load selection stack from localStorage:', error)
      }
    }
    return []
  })

  const [parentTagMap, setParentTagMap] = useState<Map<string, string[]>>(() => {
    if (storageKey && isExportMode) {
      try {
        const saved = localStorage.getItem(`${storageKey}_parentTagMap`)
        if (saved) return new Map<string, string[]>(JSON.parse(saved))
      } catch (error) {
        console.error('Failed to load parent tag map from localStorage:', error)
      }
    }
    return new Map<string, string[]>()
  })

  const [unionMode, setUnionMode] = useState<UnionMode>(() => {
    if (storageKey) {
      try {
        const saved = localStorage.getItem(`${storageKey}_unionMode`)
        if (saved === 'union' || saved === 'intersection') return saved
      } catch {}
    }
    return initialUnionMode
  })

  const [collapsedDimensionGroups, setCollapsedDimensionGroups] = useState<Set<number>>(() => {
    if (storageKey) {
      try {
        const saved = localStorage.getItem(`${storageKey}_collapsedDimensionGroups`)
        if (saved) return new Set<number>(JSON.parse(saved))
      } catch {}
    }
    return new Set<number>()
  })

  const [currentTag, setCurrentTag] = useState<SelectedTag | null>(null)

  // 记录是否已完成初次挂载与外部持久化注入 (B-2 修复)
  const isInitializedRef = useRef(false)

  // 标签树层级深度刻度状态 (1~10 刻度，ADR-0034 §4 推荐默认 3 级)
  const [maxScaleDepth, setMaxScaleDepth] = useState<number>(() => {
    if (storageKey) {
      try {
        const saved = localStorage.getItem(`${storageKey}_maxScaleDepth`)
        if (saved) {
          const val = Number(saved)
          if (val >= 1 && val <= 10) return val
        }
      } catch {}
    }
    return 3
  })

  useEffect(() => {
    if (storageKey) {
      try {
        localStorage.setItem(`${storageKey}_maxScaleDepth`, String(maxScaleDepth))
      } catch {}
    }
  }, [storageKey, maxScaleDepth])

  const onSelectionChangeRef = useRef(onSelectionChange)
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])

  const onTagClickRef = useRef(onTagClick)
  useEffect(() => {
    onTagClickRef.current = onTagClick
  }, [onTagClick])

  const onModeChangeRef = useRef(onModeChange)
  useEffect(() => {
    onModeChangeRef.current = onModeChange
  }, [onModeChange])

  // 保存/恢复 export 模式的多选标签
  const savedExportTagsRef = useRef<{
    selectedTags: Set<string>
    selectionStack: string[]
    parentTagMap: Map<string, string[]>
  }>({
    selectedTags: storageKey
      ? (() => {
          try {
            const s = localStorage.getItem(`${storageKey}_selectedTags`)
            return s ? new Set<string>(JSON.parse(s)) : new Set<string>()
          } catch {
            return new Set<string>()
          }
        })()
      : new Set<string>(),
    selectionStack: storageKey
      ? (() => {
          try {
            const s = localStorage.getItem(`${storageKey}_selectionStack`)
            return s ? (JSON.parse(s) as string[]) : []
          } catch {
            return []
          }
        })()
      : [],
    parentTagMap: storageKey
      ? (() => {
          try {
            const s = localStorage.getItem(`${storageKey}_parentTagMap`)
            return s ? new Map<string, string[]>(JSON.parse(s)) : new Map<string, string[]>()
          } catch {
            return new Map<string, string[]>()
          }
        })()
      : new Map<string, string[]>()
  })

  const selectedTagsRef = useRef(selectedTags)
  selectedTagsRef.current = selectedTags
  const selectionStackRef = useRef(selectionStack)
  selectionStackRef.current = selectionStack
  const parentTagMapRef = useRef(parentTagMap)
  parentTagMapRef.current = parentTagMap

  const prevIsExportModeRef = useRef(isExportMode)
  useEffect(() => {
    if (prevIsExportModeRef.current && !isExportMode) {
      // export → browse：保存多选标签，清空当前状态让单选模式独立运行
      savedExportTagsRef.current = {
        selectedTags: new Set(selectedTagsRef.current),
        selectionStack: [...selectionStackRef.current],
        parentTagMap: new Map(parentTagMapRef.current)
      }
      setSelectedTags(new Set())
      setSelectionStack([])
      setParentTagMap(new Map())
      setCurrentTag(null)

      if (onSelectionChangeRef.current) {
        onSelectionChangeRef.current(new Set(), 'clear', new Map())
      }
    } else if (!prevIsExportModeRef.current && isExportMode) {
      // browse → export：恢复之前保存的多选标签
      const saved = savedExportTagsRef.current
      if (saved.selectedTags.size > 0) {
        setSelectedTags(saved.selectedTags)
        setSelectionStack(saved.selectionStack)
        setParentTagMap(saved.parentTagMap)

        if (storageKey) {
          localStorage.setItem(
            `${storageKey}_selectedTags`,
            JSON.stringify(Array.from(saved.selectedTags))
          )
          localStorage.setItem(`${storageKey}_selectionStack`, JSON.stringify(saved.selectionStack))
          localStorage.setItem(
            `${storageKey}_parentTagMap`,
            JSON.stringify(Array.from(saved.parentTagMap.entries()))
          )
        }

        if (onSelectionChangeRef.current) {
          onSelectionChangeRef.current(saved.selectedTags, 'toggle', saved.parentTagMap)
        }
      }
    }
    prevIsExportModeRef.current = isExportMode
  }, [isExportMode, storageKey])

  // 2. Reset states if workspacePath changes
  const lastWorkspacePathRef = useRef(workspacePath)
  useEffect(() => {
    if (workspacePath !== lastWorkspacePathRef.current) {
      isInitializedRef.current = false
      setSelectedTags(new Set())
      setSelectionStack([])
      setParentTagMap(new Map())
      setCurrentTag(null)
      savedExportTagsRef.current = {
        selectedTags: new Set(),
        selectionStack: [],
        parentTagMap: new Map()
      }

      if (storageKey) {
        localStorage.removeItem(`${storageKey}_selectedTags`)
        localStorage.removeItem(`${storageKey}_selectionStack`)
        localStorage.removeItem(`${storageKey}_parentTagMap`)
        localStorage.removeItem(`${storageKey}_unionMode`)
        localStorage.removeItem(`${storageKey}_collapsedDimensionGroups`)
      }

      if (onSelectionChangeRef.current) {
        onSelectionChangeRef.current(new Set(), 'clear', new Map())
      }
      lastWorkspacePathRef.current = workspacePath
    }
  }, [workspacePath, storageKey])

  // Listen for workspace reset events
  useEffect(() => {
    const handleWorkspaceReset = () => {
      setSelectedTags(new Set())
      setSelectionStack([])
      setParentTagMap(new Map())
      setCurrentTag(null)
      savedExportTagsRef.current = {
        selectedTags: new Set(),
        selectionStack: [],
        parentTagMap: new Map()
      }

      if (storageKey) {
        localStorage.removeItem(`${storageKey}_selectedTags`)
        localStorage.removeItem(`${storageKey}_selectionStack`)
        localStorage.removeItem(`${storageKey}_parentTagMap`)
        localStorage.removeItem(`${storageKey}_unionMode`)
        localStorage.removeItem(`${storageKey}_collapsedDimensionGroups`)
      }

      if (onSelectionChangeRef.current) {
        onSelectionChangeRef.current(new Set(), 'clear', new Map())
      }
    }

    window.addEventListener('workspace-reset', handleWorkspaceReset)
    return () => {
      window.removeEventListener('workspace-reset', handleWorkspaceReset)
    }
  }, [storageKey])

  // Notify parent on mount if there is any restored tag or unionMode
  useEffect(() => {
    if (onSelectionChangeRef.current && isExportMode && selectedTags.size > 0) {
      onSelectionChangeRef.current(selectedTags, 'toggle', parentTagMap)
    }
    if (onModeChangeRef.current) {
      onModeChangeRef.current(unionMode)
    }
  }, [])

  const toggleDimensionGroupCollapsed = useCallback(
    (id: number) => {
      setCollapsedDimensionGroups(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        if (storageKey) {
          try {
            localStorage.setItem(
              `${storageKey}_collapsedDimensionGroups`,
              JSON.stringify(Array.from(next))
            )
          } catch {}
        }
        return next
      })
    },
    [storageKey]
  )

  const handleModeChangeInternal = useCallback(
    (mode: UnionMode) => {
      if (unionMode === mode) return
      setUnionMode(mode)
      if (storageKey) {
        try {
          localStorage.setItem(`${storageKey}_unionMode`, mode)
        } catch {}
      }
      onModeChangeRef.current?.(mode)
    },
    [unionMode, storageKey]
  )

  const isTagSelected = useCallback(
    (
      dimensionId: number,
      tagValue: string,
      parentTagValue?: string,
      viaParentCode?: string,
      isLifted?: boolean,
      codePath?: string
    ): boolean => {
      if (isExportMode) {
        // 聚合行与直系实例行可能同父 code，key 必须带 liftCode 标记区分 (ADR-0034 §4 / M-4)
        const key = makeTagKey(dimensionId, tagValue, parentTagValue, viaParentCode, isLifted)
        return selectedTags.has(key)
      } else {
        const curParent = currentTag ? currentTag.viaParentCode : undefined
        // 若两端均物化了 codePath，优先按 codePath 严格匹配，杜绝多父跨分支同名误高亮
        const pathMatches =
          !codePath || !currentTag?.codePath || currentTag.codePath === codePath
        const liftMatches =
          isLifted === undefined ||
          (currentTag?.isLifted === true) === isLifted
        return (
          currentTag !== null &&
          currentTag.dimensionId === dimensionId &&
          currentTag.tagValue === tagValue &&
          currentTag.parentTagValue === parentTagValue &&
          (!viaParentCode || !curParent || curParent === viaParentCode) &&
          pathMatches &&
          liftMatches
        )
      }
    },
    [isExportMode, selectedTags, currentTag]
  )

  const toggleTagSelection = useCallback(
    (
      dimensionId: number,
      tagValue: string,
      parentTagValue?: string,
      ancestorChain?: string[],
      viaParentCode?: string,
      isLifted?: boolean
    ) => {
      const key = makeTagKey(dimensionId, tagValue, parentTagValue, viaParentCode, isLifted)

      const isRemoving = selectedTags.has(key)
      const nextSelected = new Set(selectedTags)
      if (isRemoving) {
        nextSelected.delete(key)
      } else {
        nextSelected.add(key)
      }

      const nextStack = isRemoving
        ? selectionStack.filter(k => k !== key)
        : [...selectionStack, key]

      const nextParentMap = new Map(parentTagMap)
      if (isRemoving) {
        nextParentMap.delete(key)
      } else if (ancestorChain) {
        nextParentMap.set(key, ancestorChain)
      } else if (parentTagValue) {
        nextParentMap.set(key, [parentTagValue])
      }

      setSelectedTags(nextSelected)
      setSelectionStack(nextStack)
      setParentTagMap(nextParentMap)

      if (storageKey) {
        try {
          localStorage.setItem(
            `${storageKey}_selectedTags`,
            JSON.stringify(Array.from(nextSelected))
          )
          localStorage.setItem(`${storageKey}_selectionStack`, JSON.stringify(nextStack))
          localStorage.setItem(
            `${storageKey}_parentTagMap`,
            JSON.stringify(Array.from(nextParentMap.entries()))
          )
        } catch {}
      }

      if (onSelectionChangeRef.current) {
        onSelectionChangeRef.current(nextSelected, 'toggle', nextParentMap)
      }
    },
    [selectedTags, selectionStack, parentTagMap, storageKey]
  )

  const handleTagClickInternal = useCallback(
    (tag: {
      dimensionId: number
      dimensionName: string
      tagValue: string
      code?: string
      /** 完整物化代码路径 (M-2 修复：单选模式必须透传，FileList 才能执行排他性前缀穿透筛选) */
      codePath?: string
      /** 完整物化展示名路径 (M-2 修复) */
      namePath?: string
      /** 穿透提升跨分支聚合后的全部物化路径集合 (ADR-0034 §4 / M-4) */
      codePaths?: string[]
      isLifted?: boolean
      viaParentCode?: string
      level: number
      parentTagValue?: string
      ancestorChain?: string[]
    }) => {
      const effectiveViaParent = tag.viaParentCode
      if (isExportMode) {
        toggleTagSelection(
          tag.dimensionId,
          tag.tagValue,
          tag.parentTagValue,
          tag.ancestorChain,
          effectiveViaParent,
          tag.isLifted === true
        )
      } else {
        const newTag: SelectedTag = {
          dimensionId: tag.dimensionId,
          dimensionName: tag.dimensionName,
          tagValue: tag.tagValue,
          code: tag.code,
          codePath: tag.codePath,
          namePath: tag.namePath,
          codePaths: tag.codePaths,
          isLifted: tag.isLifted === true,
          viaParentCode: effectiveViaParent,
          level: tag.level,
          parentTagValue: tag.parentTagValue,
          ancestorChain: tag.ancestorChain
        }

        setCurrentTag(prev => {
          const prevViaParent = prev ? prev.viaParentCode : undefined
          const isSame =
            prev !== null &&
            prev.dimensionId === tag.dimensionId &&
            prev.tagValue === tag.tagValue &&
            prev.parentTagValue === tag.parentTagValue &&
            prevViaParent === effectiveViaParent &&
            (prev.codePath ?? '') === (tag.codePath ?? '') &&
            (prev.isLifted === true) === (tag.isLifted === true)

          return isSame ? null : newTag
        })

        if (onTagClickRef.current) {
          onTagClickRef.current(newTag)
        }
      }
    },
    [isExportMode, toggleTagSelection]
  )

  const handleVisibleAndHiddenTags = useCallback(
    (group: DimensionGroup, childTags?: Map<string, DimensionTreeNode[]>) => {
      return getVisibleAndHiddenTags(group, showEmptyTags, panDimensionIds, childTags)
    },
    [showEmptyTags, panDimensionIds]
  )

  // 3. 递归构建维度树（严格过滤在当前 showEmptyTags 模式下无有效子标签的根级组，且响应 maxScaleDepth 刻度穿透提升）
  const visibleGroups = useMemo(() => {
    const rawTree = buildDimensionTree(dimensionGroups, null, null, 0, maxScaleDepth)
    return rawTree.filter(group => {
      const { tagsToShow } = handleVisibleAndHiddenTags(group, group.childTags)
      return tagsToShow && tagsToShow.length > 0
    })
  }, [dimensionGroups, handleVisibleAndHiddenTags, maxScaleDepth])

  // 4. 单一收口的自愈与合法性同步管道（响应 maxScaleDepth 投影伸缩，遵循全覆盖不变式与物理死标签自愈）
  useEffect(() => {
    // 初次挂载守卫：跳过空树自愈，防止 localStorage 恢复的选中态被空树清除 (B-2 修复)
    if (!isInitializedRef.current) {
      if (visibleGroups.length === 0) {
        return
      }
      isInitializedRef.current = true
    }

    if (selectedTags.size === 0) return

    const result = migrateTagKeysAcrossScale({
      prevSelected: selectedTags,
      prevStack: selectionStack,
      prevParentMap: parentTagMap,
      currentVisibleGroups: visibleGroups,
      masterDimensionGroups: dimensionGroups
    })

    if (result.hasChanged) {
      setSelectedTags(result.migratedSelected)
      setSelectionStack(result.migratedStack)
      setParentTagMap(result.migratedParentMap)

      if (storageKey) {
        try {
          localStorage.setItem(
            `${storageKey}_selectedTags`,
            JSON.stringify(Array.from(result.migratedSelected))
          )
          localStorage.setItem(`${storageKey}_selectionStack`, JSON.stringify(result.migratedStack))
          localStorage.setItem(
            `${storageKey}_parentTagMap`,
            JSON.stringify(Array.from(result.migratedParentMap.entries()))
          )
        } catch {}
      }

      if (onSelectionChangeRef.current && isExportMode) {
        onSelectionChangeRef.current(result.migratedSelected, 'toggle', result.migratedParentMap)
      }
    }
  }, [visibleGroups, dimensionGroups, maxScaleDepth, isExportMode, storageKey])

  const handleSelectAll = useCallback(() => {
    const allItems = getAllKeys(visibleGroups, undefined, [], collapsedDimensionGroups)
    const newSelected = new Set<string>()
    const newStack: string[] = []
    const newParentTagMap = new Map<string, string[]>()

    allItems.forEach(item => {
      newSelected.add(item.key)
      newStack.push(item.key)
      if (item.ancestorChain) {
        newParentTagMap.set(item.key, item.ancestorChain)
      }
    })

    setSelectedTags(newSelected)
    setSelectionStack(newStack)
    setParentTagMap(newParentTagMap)

    if (storageKey) {
      try {
        localStorage.setItem(
          `${storageKey}_selectedTags`,
          JSON.stringify(Array.from(newSelected))
        )
        localStorage.setItem(`${storageKey}_selectionStack`, JSON.stringify(newStack))
        localStorage.setItem(
          `${storageKey}_parentTagMap`,
          JSON.stringify(Array.from(newParentTagMap.entries()))
        )
      } catch {}
    }

    if (onSelectionChangeRef.current) {
      onSelectionChangeRef.current(newSelected, 'selectAll', newParentTagMap)
    }
  }, [visibleGroups, storageKey, collapsedDimensionGroups])

  const handleInvertSelection = useCallback(() => {
    const allItems = getAllKeys(visibleGroups, undefined, [], collapsedDimensionGroups)
    const newSelected = new Set<string>()
    const newStack: string[] = []
    const newParentTagMap = new Map<string, string[]>()

    allItems.forEach(item => {
      if (!selectedTags.has(item.key)) {
        newSelected.add(item.key)
        newStack.push(item.key)
        if (item.ancestorChain) {
          newParentTagMap.set(item.key, item.ancestorChain)
        }
      }
    })

    setSelectedTags(newSelected)
    setSelectionStack(newStack)
    setParentTagMap(newParentTagMap)

    if (storageKey) {
      try {
        localStorage.setItem(
          `${storageKey}_selectedTags`,
          JSON.stringify(Array.from(newSelected))
        )
        localStorage.setItem(`${storageKey}_selectionStack`, JSON.stringify(newStack))
        localStorage.setItem(
          `${storageKey}_parentTagMap`,
          JSON.stringify(Array.from(newParentTagMap.entries()))
        )
      } catch {}
    }

    if (onSelectionChangeRef.current) {
      onSelectionChangeRef.current(newSelected, 'invert', newParentTagMap)
    }
  }, [visibleGroups, selectedTags, storageKey, collapsedDimensionGroups])


  const [collapsedTags, setCollapsedTags] = useState<Set<string>>(() => new Set())
  const toggleTagExpand = useCallback((tagValue: string) => {
    setCollapsedTags(prev => {
      const next = new Set(prev)
      if (next.has(tagValue)) next.delete(tagValue)
      else next.add(tagValue)
      return next
    })
  }, [])

  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(600)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateHeight = () => {
      setContainerHeight(container.clientHeight || 600)
    }

    updateHeight()

    // 监听容器尺寸变化（窗口 resize、侧边栏折叠、SplitPane 拖动等）时重新计算虚拟列表高度
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateHeight)
      observer.observe(container)
      return () => observer.disconnect()
    }

    // 回退方案：ResizeObserver 不可用时监听 window resize
    window.addEventListener('resize', updateHeight)
    return () => window.removeEventListener('resize', updateHeight)
  }, [])

  const flatRows = useMemo(() => {
    const rows: any[] = []

    function traverse(
      node: DimensionTreeNode,
      parentTagValue?: string,
      ancestorChain?: string[],
      depth: number = 0
    ) {
      const isCollapsed = collapsedDimensionGroups.has(node.id)
      const isTopLevel = node.level === 0

      // 与 getAllKeys（全选）共用同一份标签解析口径，确保选中态 key 集合完全一致
      const tagsToUse = resolveTagsToUse(node, parentTagValue)

      const { tagsToShow } = handleVisibleAndHiddenTags(
        { ...node, tags: tagsToUse },
        node.childTags
      )

      if (isTopLevel) {
        // 对于根级，如果其下没有子标签，则根级数据不应输出，也不应展示
        if (tagsToShow.length === 0) return

        rows.push({
          id: `header-${node.id}`,
          type: 'header',
          node,
          isCollapsed,
          depth: 0
        })
        if (isCollapsed) return
      }

      tagsToShow.forEach((tag, index) => {
        const isSelected = isTagSelected(
          tag.dimensionId,
          tag.tagValue,
          parentTagValue,
          tag.viaParentCode ?? undefined,
          tag.isLifted === true,
          tag.codePath
        )
        const isDisabled = tag.fileCount === 0
        const childDimensions = node.childTags?.get(tag.tagValue)
        const hasChildDimensions =
          !!childDimensions &&
          childDimensions.some(childNode => {
            let tagsToUse = childNode.tags
            if (
              tag.tagValue &&
              childNode.contextualTags &&
              childNode.contextualTags[tag.tagValue]
            ) {
              const isL3Ext = /扩展名|Extension/i.test(childNode.name)
              if (!isL3Ext) {
                tagsToUse = childNode.contextualTags[tag.tagValue]
              }
            }
            const { tagsToShow: childTagsToShow } = handleVisibleAndHiddenTags(
              { ...childNode, tags: tagsToUse },
              childNode.childTags
            )
            return childTagsToShow && childTagsToShow.length > 0
          })

        const isTagExpanded = !collapsedTags.has(tag.tagValue)
        const currentChain = ancestorChain ? [...ancestorChain, tag.tagValue] : [tag.tagValue]

        const effectiveTag = tag

        const rowId = `tag-${depth}-${currentChain.join('/')}-${tag.dimensionId}-${tag.tagValue}`
        rows.push({
          id: rowId,
          type: 'tag',
          node,
          tag: effectiveTag,
          parentTagValue,
          ancestorChain: currentChain,
          isSelected,
          isDisabled: effectiveTag.fileCount === 0,
          hasChildDimensions,
          isTagExpanded,
          depth,
          isLastInGroup: index === tagsToShow.length - 1
        })

        if (hasChildDimensions && isTagExpanded) {
          childDimensions.forEach(childNode => {
            traverse(childNode, tag.tagValue, currentChain, depth + 1)
          })
        }
      })
    }

    visibleGroups.forEach(group => traverse(group, undefined, undefined, 0))
    return rows
  }, [
    visibleGroups,
    collapsedDimensionGroups,
    collapsedTags,
    isTagSelected,
    handleVisibleAndHiddenTags,
    maxScaleDepth
  ])

  // 精准虚拟滚动计算：Header 40px (32px + mb-2 8px), Tag 26px
  const HEADER_HEIGHT = 40
  const TAG_HEIGHT = 26

  const { rowOffsets, totalContentHeight } = useMemo(() => {
    const offsets: number[] = new Array(flatRows.length + 1)
    let currentOffset = 0
    offsets[0] = 0
    for (let i = 0; i < flatRows.length; i++) {
      const h = flatRows[i].type === 'header' ? HEADER_HEIGHT : TAG_HEIGHT
      currentOffset += h
      offsets[i + 1] = currentOffset
    }
    return { rowOffsets: offsets, totalContentHeight: currentOffset }
  }, [flatRows])

  // 二分查找当前 scrollTop 对应的起始行索引
  const { startIndex, endIndex, paddingTop, paddingBottom } = useMemo(() => {
    const count = flatRows.length
    if (count === 0) {
      return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 }
    }

    // 当列表总行数较少 (<= 150 行) 时，全量渲染，零虚拟切片，确保滚动平滑且 100% 杜绝任何白屏或子标签丢损
    if (count <= 150) {
      return { startIndex: 0, endIndex: count, paddingTop: 0, paddingBottom: 0 }
    }

    // 关键保护：回滚到顶部（scrollTop <= 5）时绝对强制重置到索引 0
    if (scrollTop <= 5) {
      const end = Math.min(count, Math.ceil(containerHeight / TAG_HEIGHT) + 20)
      const top = 0
      const bottom = Math.max(0, totalContentHeight - rowOffsets[end])
      return { startIndex: 0, endIndex: end, paddingTop: top, paddingBottom: bottom }
    }

    // 二分查找第一个 offset + itemHeight > scrollTop 的位置
    let low = 0
    let high = count - 1
    let target = 0
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (rowOffsets[mid + 1] > scrollTop) {
        target = mid
        high = mid - 1
      } else {
        low = mid + 1
      }
    }

    // 向上充分缓冲 15 行，杜绝向上滚动时的视觉残缺
    const start = Math.max(0, target - 15)

    // 二分查找视口底部对应索引，加上向下充分缓冲 20 行
    const viewBottom = scrollTop + containerHeight
    let endTarget = count
    low = start
    high = count - 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (rowOffsets[mid] >= viewBottom) {
        endTarget = mid
        high = mid - 1
      } else {
        low = mid + 1
      }
    }
    const end = Math.min(count, endTarget + 20)

    const top = rowOffsets[start]
    const bottom = Math.max(0, totalContentHeight - rowOffsets[end])

    return { startIndex: start, endIndex: end, paddingTop: top, paddingBottom: bottom }
  }, [flatRows.length, rowOffsets, totalContentHeight, scrollTop, containerHeight])

  const visibleRows = useMemo(() => {
    return flatRows.slice(startIndex, endIndex)
  }, [flatRows, startIndex, endIndex])


  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 标签树层级深度刻度滑块 (1~10 刻度与穿透提升，ADR-0034 §4) */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 bg-muted/15 shrink-0 text-xs text-muted-foreground select-none">
        <div className="flex items-center gap-1 min-w-0">
          <MaterialIcon icon="tune" className="text-xs text-primary" />
          <span className="text-[11px] font-medium text-foreground/80">{t('层级深度')}</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary font-bold">
            {maxScaleDepth}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-1 max-w-[100px] ml-2">
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={maxScaleDepth}
            onChange={e => setMaxScaleDepth(Number(e.target.value))}
            className="w-full h-1 bg-muted-foreground/25 rounded-lg appearance-none cursor-pointer accent-primary"
            title={t('拖动调整标签树显示深度 (1~10 级)')}
          />
        </div>
      </div>

      {showSelectAll && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20 shrink-0">
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                requestAnimationFrame(() => {
                  handleSelectAll()
                })
              }}
              className="text-[10px] font-bold px-2 py-1 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-all duration-200 cursor-pointer active:scale-95 flex items-center gap-0.5"
            >
              <MaterialIcon icon="select_all" className="text-xs" />
              {t('全选')}
            </button>
            <button
              onClick={() => {
                requestAnimationFrame(() => {
                  handleInvertSelection()
                })
              }}
              className="text-[10px] font-bold px-2 py-1 rounded-md bg-muted-foreground/10 text-muted-foreground hover:bg-muted-foreground/20 transition-all duration-200 cursor-pointer active:scale-95 flex items-center gap-0.5"
            >
              <MaterialIcon icon="swap_horiz" className="text-xs" />
              {t('反选')}
            </button>
          </div>
          <div className="flex items-center border border-border/50 rounded-md overflow-hidden">
            <button
              onClick={() => handleModeChangeInternal('union')}
              className={cn(
                'text-[9px] font-bold px-1.5 py-1 transition-all duration-200 cursor-pointer',
                unionMode === 'union'
                  ? 'bg-primary/20 text-primary'
                  : 'bg-transparent text-muted-foreground hover:bg-muted/50'
              )}
            >
              {t('并集')}
            </button>
            <button
              onClick={() => handleModeChangeInternal('intersection')}
              className={cn(
                'text-[9px] font-bold px-1.5 py-1 transition-all duration-200 cursor-pointer',
                unionMode === 'intersection'
                  ? 'bg-primary/20 text-primary'
                  : 'bg-transparent text-muted-foreground hover:bg-muted/50'
              )}
            >
              {t('交集')}
            </button>
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 custom-scrollbar relative"
      >
        <div style={{ paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom}px` }}>
          {visibleRows.map(row => (
            <DimensionTreeRow
              key={row.id}
              row={row}
              isExportMode={isExportMode}
              toggleDimensionGroupCollapsed={toggleDimensionGroupCollapsed}
              toggleTagExpand={toggleTagExpand}
              toggleTagSelection={toggleTagSelection}
              handleTagClickInternal={handleTagClickInternal}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
