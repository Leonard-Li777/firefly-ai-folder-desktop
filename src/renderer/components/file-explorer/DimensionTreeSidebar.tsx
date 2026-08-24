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
  getSelectedTagsFromSet
} from './dimension-tree-utils'

interface DimensionTreeSidebarProps {
  dimensionGroups: DimensionGroup[]
  showEmptyTags: boolean
  panDimensionIds: number[]
  isExportMode?: boolean
  showSelectAll?: boolean
  storageKey?: string
  workspacePath?: string
  unionMode?: UnionMode
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
  panDimensionIds: number[]
  collapsedDimensionGroups: Set<number>
  toggleDimensionGroupCollapsed: (groupId: number) => void
  isTagSelected: (dimensionId: number, tagValue: string, parentTagValue?: string) => boolean
  toggleTagSelection: (
    dimensionId: number,
    tagValue: string,
    parentTagValue?: string,
    ancestorChain?: string[]
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
    panDimensionIds,
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
              const isSelected = isTagSelected(tag.dimensionId, tag.tagValue, parentTagValue)
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
                              currentChain
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
                              currentChain
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
                            currentChain
                          )
                        } else {
                          handleTagClick({
                            dimensionId: tag.dimensionId,
                            dimensionName: tag.dimensionName,
                            tagValue: tag.tagValue,
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
                      {isExportMode &&
                        ((panDimensionIds || [4, 28]).includes(tag.dimensionId) ||
                          node.name === '作者' ||
                          node.name === 'Author' ||
                          node.name === '内容标签' ||
                          node.name === 'Content Tag' ||
                          Boolean((node as any).isAIGenerated)) && (
                          <span
                            role="button"
                            tabIndex={0}
                            title={t('直接删除该标签')}
                            onClick={async e => {
                              e.stopPropagation()
                              if (window.electronAPI?.deleteTagGlobally) {
                                const success = await window.electronAPI.deleteTagGlobally(
                                  tag.dimensionId,
                                  tag.tagValue
                                )
                                if (success) {
                                  import('../common/Toast').then(({ toast }) => {
                                    toast.success(t('已删除标签「{name}」', { name: tag.tagValue }))
                                  })
                                }
                              }
                            }}
                            className="opacity-0 group-hover:opacity-100 hover:text-destructive p-0.5 rounded transition-opacity shrink-0 ml-1 cursor-pointer"
                          >
                            <MaterialIcon icon="close" className="text-[12px]" />
                          </span>
                        )}
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
DimensionTreeNodeComponent.displayName = 'DimensionTreeNodeComponent'

// Recursive helper to find all keys in tree
const getAllKeys = (
  nodes: DimensionTreeNode[],
  parentTag?: string,
  chain: string[] = []
): { key: string; ancestorChain: string[] }[] => {
  const keys: { key: string; ancestorChain: string[] }[] = []
  nodes.forEach(node => {
    node.tags.forEach(tag => {
      const key = makeTagKey(node.id, tag.tagValue, parentTag)
      const currentChain = [...chain, tag.tagValue]
      keys.push({ key, ancestorChain: currentChain })
    })
    if (node.childTags) {
      for (const [childParentTag, childNodes] of node.childTags) {
        keys.push(...getAllKeys(childNodes, childParentTag, [...chain, childParentTag]))
      }
    }
  })
  return keys
}

export const DimensionTreeSidebar: React.FC<DimensionTreeSidebarProps> = ({
  dimensionGroups,
  showEmptyTags,
  panDimensionIds,
  isExportMode = false,
  showSelectAll = false,
  storageKey,
  workspacePath,
  unionMode: propsUnionMode,
  onSelectionChange,
  onModeChange,
  onTagClick,
  className,
  initialUnionMode
}) => {
  // 1. Internal states
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => {
    if (storageKey) {
      try {
        const saved = localStorage.getItem(`${storageKey}_selectedTags`)
        if (saved) return new Set(JSON.parse(saved))
      } catch (error) {
        console.error('Failed to load selected tags from localStorage:', error)
      }
    }
    return new Set()
  })

  const [selectionStack, setSelectionStack] = useState<string[]>(() => {
    if (storageKey) {
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
    if (storageKey) {
      try {
        const saved = localStorage.getItem(`${storageKey}_parentTagMap`)
        if (saved) return new Map(JSON.parse(saved))
      } catch (error) {
        console.error('Failed to load parent tag map from localStorage:', error)
      }
    }
    return new Map()
  })

  const [internalUnionMode, setInternalUnionMode] = useState<UnionMode>(
    propsUnionMode || initialUnionMode || 'union'
  )

  const activeUnionMode = propsUnionMode ?? internalUnionMode

  useEffect(() => {
    if (propsUnionMode && propsUnionMode !== internalUnionMode) {
      setInternalUnionMode(propsUnionMode)
    }
  }, [propsUnionMode])
  const [collapsedDimensionGroups, setCollapsedDimensionGroups] = useState<Set<number>>(
    () => new Set()
  )
  const [currentTag, setCurrentTag] = useState<SelectedTag | null>(null)

  // 保存/恢复 export 模式的多选标签
  const savedExportTagsRef = useRef<{
    selectedTags: Set<string>
    selectionStack: string[]
    parentTagMap: Map<string, string[]>
  }>({ selectedTags: new Set(), selectionStack: [], parentTagMap: new Map() })

  const prevIsExportModeRef = useRef(isExportMode)
  useEffect(() => {
    if (prevIsExportModeRef.current && !isExportMode) {
      // export → browse：保存多选标签，清空当前状态让单选模式独立运行
      savedExportTagsRef.current = {
        selectedTags: new Set(selectedTags),
        selectionStack: [...selectionStack],
        parentTagMap: new Map(parentTagMap)
      }
      setSelectedTags(new Set())
      setSelectionStack([])
      setParentTagMap(new Map())
      setCurrentTag(null)

      if (onSelectionChange) {
        onSelectionChange(new Set(), 'clear', new Map())
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

        if (onSelectionChange) {
          onSelectionChange(saved.selectedTags, 'toggle', saved.parentTagMap)
        }
      }
    }
    prevIsExportModeRef.current = isExportMode
  }, [isExportMode, storageKey, onSelectionChange])

  // 2. Reset states if workspacePath changes
  const lastWorkspacePathRef = useRef(workspacePath)
  useEffect(() => {
    if (workspacePath !== lastWorkspacePathRef.current) {
      setSelectedTags(new Set())
      setSelectionStack([])
      setParentTagMap(new Map())
      setCurrentTag(null)

      if (storageKey) {
        localStorage.removeItem(`${storageKey}_selectedTags`)
        localStorage.removeItem(`${storageKey}_selectionStack`)
        localStorage.removeItem(`${storageKey}_parentTagMap`)
      }

      if (onSelectionChange) {
        onSelectionChange(new Set(), 'clear', new Map())
      }
      lastWorkspacePathRef.current = workspacePath
    }
  }, [workspacePath, storageKey, onSelectionChange])

  // Listen for workspace reset events
  useEffect(() => {
    const handleWorkspaceReset = () => {
      setSelectedTags(new Set())
      setSelectionStack([])
      setParentTagMap(new Map())
      setCurrentTag(null)

      if (storageKey) {
        localStorage.removeItem(`${storageKey}_selectedTags`)
        localStorage.removeItem(`${storageKey}_selectionStack`)
        localStorage.removeItem(`${storageKey}_parentTagMap`)
      }

      if (onSelectionChange) {
        onSelectionChange(new Set(), 'clear', new Map())
      }
    }

    window.addEventListener('workspace-reset', handleWorkspaceReset)
    return () => {
      window.removeEventListener('workspace-reset', handleWorkspaceReset)
    }
  }, [storageKey, onSelectionChange])

  // Notify parent on mount if there is any restored tag
  useEffect(() => {
    if (onSelectionChange && selectedTags.size > 0) {
      onSelectionChange(selectedTags, 'toggle', parentTagMap)
    }
  }, [])

  const toggleDimensionGroupCollapsed = useCallback((id: number) => {
    setCollapsedDimensionGroups(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const isTagSelected = useCallback(
    (dimensionId: number, tagValue: string, parentTagValue?: string): boolean => {
      if (isExportMode) {
        const key = makeTagKey(dimensionId, tagValue, parentTagValue)
        return selectedTags.has(key)
      } else {
        return (
          currentTag !== null &&
          currentTag.dimensionId === dimensionId &&
          currentTag.tagValue === tagValue &&
          currentTag.parentTagValue === parentTagValue
        )
      }
    },
    [isExportMode, selectedTags, currentTag]
  )

  const toggleTagSelection = useCallback(
    (dimensionId: number, tagValue: string, parentTagValue?: string, ancestorChain?: string[]) => {
      const key = makeTagKey(dimensionId, tagValue, parentTagValue)

      setSelectedTags(prevSelected => {
        const next = new Set(prevSelected)
        const isRemoving = next.has(key)

        if (isRemoving) {
          next.delete(key)
        } else {
          next.add(key)
        }

        setSelectionStack(prevStack => {
          const newStack = isRemoving ? prevStack.filter(k => k !== key) : [...prevStack, key]

          setParentTagMap(prevMap => {
            const nextMap = new Map(prevMap)
            if (isRemoving) {
              nextMap.delete(key)
            } else if (ancestorChain) {
              nextMap.set(key, ancestorChain)
            } else if (parentTagValue) {
              nextMap.set(key, [parentTagValue])
            }

            if (storageKey) {
              localStorage.setItem(`${storageKey}_selectedTags`, JSON.stringify(Array.from(next)))
              localStorage.setItem(`${storageKey}_selectionStack`, JSON.stringify(newStack))
              localStorage.setItem(
                `${storageKey}_parentTagMap`,
                JSON.stringify(Array.from(nextMap.entries()))
              )
            }

            if (onSelectionChange) {
              onSelectionChange(next, 'toggle', nextMap)
            }

            return nextMap
          })

          return newStack
        })

        return next
      })
    },
    [storageKey, onSelectionChange]
  )

  const handleTagClickInternal = useCallback(
    (tag: {
      dimensionId: number
      dimensionName: string
      tagValue: string
      level: number
      parentTagValue?: string
      ancestorChain?: string[]
    }) => {
      if (isExportMode) {
        toggleTagSelection(tag.dimensionId, tag.tagValue, tag.parentTagValue, tag.ancestorChain)
      } else {
        const newTag: SelectedTag = {
          dimensionId: tag.dimensionId,
          dimensionName: tag.dimensionName,
          tagValue: tag.tagValue,
          level: tag.level,
          parentTagValue: tag.parentTagValue,
          ancestorChain: tag.ancestorChain
        }

        setCurrentTag(prev => {
          const isSame =
            prev !== null &&
            prev.dimensionId === tag.dimensionId &&
            prev.tagValue === tag.tagValue &&
            prev.parentTagValue === tag.parentTagValue

          return isSame ? null : newTag
        })

        if (onTagClick) {
          onTagClick(newTag)
        }
      }
    },
    [isExportMode, onTagClick, toggleTagSelection]
  )

  // 3. 递归构建维度树
  const visibleGroups = useMemo(() => {
    return buildDimensionTree(dimensionGroups)
  }, [dimensionGroups])

  const handleSelectAll = useCallback(() => {
    const allItems = getAllKeys(visibleGroups)
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
      setTimeout(() => {
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
      }, 0)
    }

    if (onSelectionChange) {
      onSelectionChange(newSelected, 'selectAll', newParentTagMap)
    }
  }, [visibleGroups, storageKey, onSelectionChange])

  const handleInvertSelection = useCallback(() => {
    const allItems = getAllKeys(visibleGroups)
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
      setTimeout(() => {
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
      }, 0)
    }

    if (onSelectionChange) {
      onSelectionChange(newSelected, 'invert', newParentTagMap)
    }
  }, [visibleGroups, selectedTags, storageKey, onSelectionChange])

  const handleVisibleAndHiddenTags = useCallback(
    (group: DimensionGroup, childTags?: Map<string, DimensionTreeNode[]>) => {
      return getVisibleAndHiddenTags(group, showEmptyTags, panDimensionIds, childTags)
    },
    [showEmptyTags, panDimensionIds]
  )

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

      if (isTopLevel) {
        rows.push({
          id: `header-${node.id}`,
          type: 'header',
          node,
          isCollapsed,
          depth: 0
        })
        if (isCollapsed) return
      }

      let tagsToUse = node.tags
      if (parentTagValue && node.contextualTags && node.contextualTags[parentTagValue]) {
        const isL3Ext = /扩展名|Extension/i.test(node.name)
        if (!isL3Ext) {
          tagsToUse = node.contextualTags[parentTagValue]
        }
      }

      const { tagsToShow } = handleVisibleAndHiddenTags(
        { ...node, tags: tagsToUse },
        node.childTags
      )

      tagsToShow.forEach((tag, index) => {
        const isSelected = isTagSelected(tag.dimensionId, tag.tagValue, parentTagValue)
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

        rows.push({
          id: `tag-${tag.dimensionId}-${tag.tagValue}-${parentTagValue || ''}`,
          type: 'tag',
          node,
          tag,
          parentTagValue,
          ancestorChain: currentChain,
          isSelected,
          isDisabled,
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
    handleVisibleAndHiddenTags
  ])

  const ITEM_HEIGHT = 28
  const visibleCount = Math.ceil(containerHeight / ITEM_HEIGHT) + 6
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 3)
  const endIndex = Math.min(flatRows.length, startIndex + visibleCount)
  const visibleRows = flatRows.slice(startIndex, endIndex)
  const paddingTop = startIndex * ITEM_HEIGHT
  const paddingBottom = Math.max(0, (flatRows.length - endIndex) * ITEM_HEIGHT)

  const handleUnionModeChangeInternal = useCallback(
    (mode: UnionMode) => {
      setInternalUnionMode(mode)
      if (onModeChange) {
        onModeChange(mode)
      }
    },
    [onModeChange]
  )

  return (
    <div className={cn('flex flex-col h-full', className)}>
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
              onClick={() => {
                setInternalUnionMode('union')
                if (onModeChange) onModeChange('union')
              }}
              className={cn(
                'text-[9px] font-bold px-1.5 py-1 transition-all duration-200 cursor-pointer',
                activeUnionMode === 'union'
                  ? 'bg-primary/20 text-primary'
                  : 'bg-transparent text-muted-foreground hover:bg-muted/50'
              )}
            >
              {t('并集')}
            </button>
            <button
              onClick={() => {
                setInternalUnionMode('intersection')
                if (onModeChange) onModeChange('intersection')
              }}
              className={cn(
                'text-[9px] font-bold px-1.5 py-1 transition-all duration-200 cursor-pointer',
                activeUnionMode === 'intersection'
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
          {visibleRows.map(row => {
            if (row.type === 'header' && row.node) {
              return (
                <div key={row.id} className="dimension-group relative mb-2">
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
                  key={row.id}
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
                            row.ancestorChain
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
                            row.ancestorChain
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
                          row.ancestorChain
                        )
                      } else {
                        handleTagClickInternal({
                          dimensionId: tag.dimensionId,
                          dimensionName: tag.dimensionName,
                          tagValue: tag.tagValue,
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
                    {isExportMode &&
                      ((panDimensionIds || [4, 28]).includes(tag.dimensionId) ||
                        row.node?.name === '作者' ||
                        row.node?.name === 'Author' ||
                        row.node?.name === '内容标签' ||
                        row.node?.name === 'Content Tag' ||
                        Boolean((row.node as any)?.isAIGenerated)) && (
                        <span
                          role="button"
                          tabIndex={0}
                          title={t('直接删除该标签')}
                          onClick={async e => {
                            e.stopPropagation()
                            if (window.electronAPI?.deleteTagGlobally) {
                              const success = await window.electronAPI.deleteTagGlobally(
                                tag.dimensionId,
                                tag.tagValue
                              )
                              if (success) {
                                import('../common/Toast').then(({ toast }) => {
                                  toast.success(t('已删除标签「{name}」', { name: tag.tagValue }))
                                })
                              }
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 hover:text-destructive p-0.5 rounded transition-opacity shrink-0 ml-1 cursor-pointer"
                        >
                          <MaterialIcon icon="close" className="text-[12px]" />
                        </span>
                      )}
                  </button>
                </div>
              )
            }
            return null
          })}
        </div>
      </div>
    </div>
  )
}
