import { create } from 'zustand'
import {
  FileItem,
  DirectoryItem,
  WorkspaceDirectory,
  DimensionGroup,
  DimensionTag,
  SelectedTag,
  SavedVirtualDirectory,
  AnalysisQueueItem
} from '@firefly/types'
import {
  sortTopLevelDimensionNodes,
  SortWeightNode
} from '../components/file-explorer/dimension-tree-utils'

/**
 * #625 前端纯树形选择状态机
 *
 * 核心变更：
 * 1. 内部状态以 code: string 为唯一主键
 * 2. toggleTag(code) 自动向上查找父节点，若父级 isMultiSelect=false 则原子化反选同父兄弟
 * 3. selectionStack 完全由 Store 内部闭环管理，UI 组件无需手写反选与栈同步
 */

/** 标签拓扑节点（从 DimensionGroup/DimensionTag 拍平而来） */
export interface TagTopologyNode {
  code: string
  name: string
  parentCode: string | null
  isMultiSelect: boolean
  dimensionCode: string
  dimensionName: string
  level: number
}

interface VirtualDirectoryStore {
  // Current workspace directory
  currentWorkspaceDirectory: WorkspaceDirectory | null
  setCurrentWorkspaceDirectory: (directory: WorkspaceDirectory | null) => void
  workspaceDirectories: WorkspaceDirectory[]
  setWorkspaceDirectories: (directories: WorkspaceDirectory[]) => void

  // Dimension groups and tags
  dimensionGroups: DimensionGroup[]
  setDimensionGroups: (groups: DimensionGroup[]) => void
  /** 获取经三级动态权重排序后的顶层主干维度组 */
  getSortedTopLevelGroups: () => DimensionGroup[]
  /** 动态更新文件计数并触发响应式重新排序 */
  updateTagCounts: (countMap: Record<string, number> | Map<string, number>) => void

  // #625: 标签拓扑（code → 节点信息），由 setDimensionGroups 自动构建
  tagTopology: Map<string, TagTopologyNode>

  // #625: 以 code 为主键的选中集合
  selectedTagCodes: Set<string>
  // #625: 勾选顺序栈（Store 闭环管理）
  selectionStack: string[]

  // #625: 纯树形状态机核心 action
  toggleTag: (code: string) => void
  selectTag: (code: string) => void
  deselectTag: (code: string) => void
  clearSelection: () => void
  isTagSelected: (code: string) => boolean

  // 兼容层：旧 SelectedTag[] 接口（供现有调用方渐进迁移）
  selectedTags: SelectedTag[]
  setSelectedTags: (tags: SelectedTag[]) => void
  addSelectedTag: (tag: SelectedTag) => void
  removeSelectedTag: (dimensionId: number) => void
  clearSelectedTags: () => void

  // Filtered files
  filteredFiles: (FileItem | DirectoryItem)[]
  setFilteredFiles: (
    files:
      | (FileItem | DirectoryItem)[]
      | ((prev: (FileItem | DirectoryItem)[]) => (FileItem | DirectoryItem)[])
  ) => void
  totalFilesCount: number
  setTotalFilesCount: (count: number) => void

  // View settings
  sortBy:
    | 'name'
    | 'date'
    | 'size'
    | 'type'
    | 'smartName'
    | 'analysisStatus'
    | 'qualityScore'
    | 'author'
    | 'language'
  sortOrder: 'asc' | 'desc'
  viewMode: 'list' | 'grid' | 'waterfall' | 'table' | 'search-list'
  setSortBy: (
    sortBy:
      | 'name'
      | 'date'
      | 'size'
      | 'type'
      | 'smartName'
      | 'analysisStatus'
      | 'qualityScore'
      | 'author'
      | 'language'
  ) => void
  setSortOrder: (order: 'asc' | 'desc') => void
  setViewMode: (mode: 'list' | 'grid' | 'waterfall' | 'table' | 'search-list') => void

  // Saved virtual directories
  savedDirectories: SavedVirtualDirectory[]
  setSavedDirectories: (directories: SavedVirtualDirectory[]) => void
  addSavedDirectory: (directory: SavedVirtualDirectory) => void
  removeSavedDirectory: (id: string) => void
  loadSavedDirectory: (directory: SavedVirtualDirectory) => void

  // Loading state
  isLoading: boolean
  setIsLoading: (loading: boolean) => void

  // Selected item for details panel
  selectedItem: FileItem | DirectoryItem | null
  setSelectedItem: (item: FileItem | DirectoryItem | null) => void
  selectedFiles: (FileItem | DirectoryItem)[]
  setSelectedFiles: (files: (FileItem | DirectoryItem)[]) => void
  showDetailsPanel: boolean
  setShowDetailsPanel: (show: boolean) => void

  // New files notification
  hasNewFiles: boolean
  newFilesCount: number
  newAnalyzedPaths: Set<string>
  setHasNewFiles: (hasNew: boolean, count?: number) => void
  incrementNewFilesCount: (items: AnalysisQueueItem[]) => void
}

/**
 * 从 DimensionGroup[] 构建标签拓扑 Map
 */
function buildTagTopology(groups: DimensionGroup[]): Map<string, TagTopologyNode> {
  const topology = new Map<string, TagTopologyNode>()

  for (const group of groups) {
    const dimCode = group.code || String(group.id)
    const dimIsMultiSelect = group.isMultiSelect === true

    // 维度根节点
    topology.set(dimCode, {
      code: dimCode,
      name: group.name,
      parentCode: null,
      isMultiSelect: dimIsMultiSelect,
      dimensionCode: dimCode,
      dimensionName: group.name,
      level: group.level || 0
    })

    // 子标签
    for (const tag of group.tags) {
      const tagCode = tag.code || `${dimCode}.${tag.tagValue}`
      topology.set(tagCode, {
        code: tagCode,
        name: tag.tagValue,
        parentCode: tag.parentCode || dimCode,
        // 子标签自身的 isMultiSelect 控制其子节点；同父互斥由父节点的 isMultiSelect 决定
        isMultiSelect: tag.isMultiSelect === true,
        dimensionCode: dimCode,
        dimensionName: group.name,
        level: tag.level || 1
      })
    }
  }

  return topology
}

/**
 * 将 code 集合同步转换为兼容层 SelectedTag[]
 */
function codesToSelectedTags(
  codes: Set<string>,
  topology: Map<string, TagTopologyNode>
): SelectedTag[] {
  const result: SelectedTag[] = []
  for (const code of codes) {
    const node = topology.get(code)
    if (!node) continue

    // 构建祖先链
    const ancestorChain: string[] = []
    let cursor: TagTopologyNode | undefined = node
    while (cursor) {
      ancestorChain.unshift(cursor.name)
      cursor = cursor.parentCode ? topology.get(cursor.parentCode) : undefined
    }

    const parent = node.parentCode ? topology.get(node.parentCode) : undefined

    result.push({
      dimensionId: (node.dimensionCode.match(/^dim\.(\d+)$/)?.[1]
        ? parseInt(node.dimensionCode.match(/^dim\.(\d+)$/)![1], 10)
        : 0) as any,
      dimensionName: node.dimensionName,
      tagValue: node.name,
      level: node.level,
      parentTagValue: parent?.name,
      ancestorChain
    })
  }
  return result
}

export const useVirtualDirectoryStore = create<VirtualDirectoryStore>((set, get) => ({
  // Initial state
  currentWorkspaceDirectory: null,
  workspaceDirectories: [],
  dimensionGroups: [],
  tagTopology: new Map<string, TagTopologyNode>(),
  selectedTagCodes: new Set<string>(),
  selectionStack: [],
  selectedTags: [],
  filteredFiles: [],
  totalFilesCount: 0,
  sortBy: 'name',
  sortOrder: 'asc',
  viewMode: 'list',
  savedDirectories: [],
  isLoading: false,
  selectedItem: null,
  selectedFiles: [],
  showDetailsPanel: true,
  hasNewFiles: false,
  newFilesCount: 0,
  newAnalyzedPaths: new Set<string>(),

  // Current workspace directory
  setCurrentWorkspaceDirectory: directory => {
    set({
      currentWorkspaceDirectory: directory,
      selectedTags: [],
      selectedTagCodes: new Set<string>(),
      selectionStack: [],
      filteredFiles: [],
      totalFilesCount: 0,
      hasNewFiles: false,
      newFilesCount: 0,
      newAnalyzedPaths: new Set<string>()
    })
  },

  setWorkspaceDirectories: directories => set({ workspaceDirectories: directories }),

  // Dimension groups（自动构建拓扑并计算聚合计数）
  setDimensionGroups: groups => {
    const groupsWithCounts = groups.map(g => {
      const computedFileCount =
        typeof g.fileCount === 'number'
          ? g.fileCount
          : (g.tags || []).reduce((acc, t) => acc + (t.fileCount || 0), 0)
      return {
        ...g,
        fileCount: computedFileCount
      }
    })
    const topology = buildTagTopology(groupsWithCounts)
    set({ dimensionGroups: groupsWithCounts, tagTopology: topology })
  },

  /**
   * 获取经三级动态权重排序后的顶层主干维度组：
   * SortWeight = <builtin.meta.order (升序), file_count (降序), omw.meta.count (降序)>
   */
  getSortedTopLevelGroups: () => {
    const { dimensionGroups } = get()
    const topLevelGroups = dimensionGroups.filter(
      g =>
        g.level === 0 ||
        ((!g.triggerConditions || g.triggerConditions.length === 0) &&
          (!g.parentDimensionIds || g.parentDimensionIds.length === 0))
    )
    return sortTopLevelDimensionNodes(topLevelGroups)
  },

  /**
   * 响应式更新标签文件计数，并触发排序重新计算
   */
  updateTagCounts: countMap => {
    const { dimensionGroups } = get()
    const getCount = (code: string, fallback?: number) => {
      if (countMap instanceof Map) {
        return countMap.get(code) ?? fallback ?? 0
      }
      return countMap[code] ?? fallback ?? 0
    }

    const updatedGroups = dimensionGroups.map(group => {
      let groupTotal = 0
      const updatedTags = group.tags.map(tag => {
        const key = tag.code || tag.tagValue
        const newCount = getCount(key, tag.fileCount)
        groupTotal += newCount
        return { ...tag, fileCount: newCount }
      })
      return {
        ...group,
        tags: updatedTags,
        fileCount: groupTotal
      }
    })

    set({ dimensionGroups: updatedGroups })
  },

  // ========== #625 纯树形状态机核心 ==========

  isTagSelected: code => get().selectedTagCodes.has(code),

  /**
   * 原子化选中标签：若父级 isMultiSelect=false，自动反选所有同父兄弟（含级联后代）
   */
  selectTag: code => {
    const { selectedTagCodes, selectionStack, tagTopology } = get()
    if (selectedTagCodes.has(code)) return

    const node = tagTopology.get(code)
    const nextCodes = new Set(selectedTagCodes)
    let nextStack = [...selectionStack]

    // 递归收集指定节点的所有后代 codes
    const collectDescendants = (parentCode: string): string[] => {
      const descendants: string[] = []
      for (const [c, n] of tagTopology) {
        if (n.parentCode === parentCode) {
          descendants.push(c)
          descendants.push(...collectDescendants(c))
        }
      }
      return descendants
    }

    // 同父互斥：父节点 isMultiSelect=false 时，反选所有同父兄弟及其后代
    if (node?.parentCode) {
      const parent = tagTopology.get(node.parentCode)
      if (parent && parent.isMultiSelect === false) {
        // 找出所有同父兄弟
        for (const [siblingCode, siblingNode] of tagTopology) {
          if (siblingNode.parentCode === node.parentCode && siblingCode !== code) {
            if (nextCodes.has(siblingCode)) {
              nextCodes.delete(siblingCode)
              // 级联清除兄弟的所有已选后代，防止孤儿
              for (const desc of collectDescendants(siblingCode)) {
                nextCodes.delete(desc)
              }
            }
          }
        }
        // 同步清理栈中被移除的 codes
        nextStack = nextStack.filter(c => nextCodes.has(c))
      }
    }

    nextCodes.add(code)
    nextStack.push(code)

    set({
      selectedTagCodes: nextCodes,
      selectionStack: nextStack,
      selectedTags: codesToSelectedTags(nextCodes, tagTopology)
    })
  },

  /**
   * 反选标签：同时清除其所有后代选中项
   */
  deselectTag: code => {
    const { selectedTagCodes, selectionStack, tagTopology } = get()
    if (!selectedTagCodes.has(code)) return

    const nextCodes = new Set(selectedTagCodes)
    nextCodes.delete(code)

    // 级联清除所有后代
    const collectDescendants = (parentCode: string): string[] => {
      const descendants: string[] = []
      for (const [c, n] of tagTopology) {
        if (n.parentCode === parentCode) {
          descendants.push(c)
          descendants.push(...collectDescendants(c))
        }
      }
      return descendants
    }
    for (const desc of collectDescendants(code)) {
      nextCodes.delete(desc)
    }

    const nextStack = selectionStack.filter(c => nextCodes.has(c))

    set({
      selectedTagCodes: nextCodes,
      selectionStack: nextStack,
      selectedTags: codesToSelectedTags(nextCodes, tagTopology)
    })
  },

  /**
   * 切换标签选中态（核心入口）
   */
  toggleTag: code => {
    const { selectedTagCodes, selectTag, deselectTag } = get()
    if (selectedTagCodes.has(code)) {
      deselectTag(code)
    } else {
      selectTag(code)
    }
  },

  clearSelection: () => {
    set({
      selectedTagCodes: new Set<string>(),
      selectionStack: [],
      selectedTags: []
    })
  },

  // ========== 兼容层：旧 SelectedTag[] 接口 ==========

  setSelectedTags: tags => {
    const { tagTopology } = get()
    const codes = new Set<string>()
    const stack: string[] = []
    for (const tag of tags) {
      // 尝试通过 tagValue + dimensionName 反查 code
      for (const [code, node] of tagTopology) {
        if (node.name === tag.tagValue && node.dimensionName === tag.dimensionName) {
          codes.add(code)
          stack.push(code)
          break
        }
      }
    }
    set({
      selectedTags: tags,
      selectedTagCodes: codes,
      selectionStack: stack
    })
  },

  addSelectedTag: tag => {
    const { tagTopology, selectTag } = get()
    // 通过 tagValue + dimensionName 反查 code，走纯树形状态机
    for (const [code, node] of tagTopology) {
      if (node.name === tag.tagValue && node.dimensionName === tag.dimensionName) {
        selectTag(code)
        return
      }
    }
    // 兜底：直接操作旧接口（Remove existing tag from same dimension - mutual exclusion within dimension）
    const { selectedTags } = get()
    const filtered = selectedTags.filter(t => t.dimensionId !== tag.dimensionId)
    set({ selectedTags: [...filtered, tag] })
  },

  removeSelectedTag: dimensionId => {
    const { selectedTags, dimensionGroups, tagTopology, selectedTagCodes, selectionStack } = get()
    // Remove the tag and any child dimension tags
    const dimensionToRemove = selectedTags.find(t => t.dimensionId === dimensionId)
    if (!dimensionToRemove) return

    // 通过 dimensionName 反查维度 code 并级联清除
    const dimGroup = dimensionGroups.find(
      g => String(g.id) === String(dimensionId) || g.name === dimensionToRemove.dimensionName
    )
    if (dimGroup?.code) {
      const nextCodes = new Set(selectedTagCodes)
      const collectDescendants = (parentCode: string): string[] => {
        const descendants: string[] = []
        for (const [c, n] of tagTopology) {
          if (n.parentCode === parentCode) {
            descendants.push(c)
            descendants.push(...collectDescendants(c))
          }
        }
        return descendants
      }
      // Remove parent and all children
      nextCodes.delete(dimGroup.code)
      for (const desc of collectDescendants(dimGroup.code)) {
        nextCodes.delete(desc)
      }
      const nextStack = selectionStack.filter(c => nextCodes.has(c))
      set({
        selectedTagCodes: nextCodes,
        selectionStack: nextStack,
        selectedTags: codesToSelectedTags(nextCodes, tagTopology)
      })
      return
    }

    // 兜底：旧逻辑（Find all child dimensions）
    const childDimensionIds = new Set<number>()
    const findChildDimensions = (parentId: number) => {
      dimensionGroups.forEach(group => {
        if (group.parentDimensionIds?.includes(parentId)) {
          childDimensionIds.add(group.id)
          findChildDimensions(group.id)
        }
      })
    }
    findChildDimensions(dimensionId)
    // Remove parent and all children
    const filtered = selectedTags.filter(
      t => t.dimensionId !== dimensionId && !childDimensionIds.has(t.dimensionId)
    )
    set({ selectedTags: filtered })
  },

  clearSelectedTags: () => {
    set({
      selectedTags: [],
      selectedTagCodes: new Set<string>(),
      selectionStack: []
    })
  },

  // Filtered files
  setFilteredFiles: filesOrFn => {
    if (typeof filesOrFn === 'function') {
      set(state => ({ filteredFiles: filesOrFn(state.filteredFiles) }))
    } else {
      set({ filteredFiles: filesOrFn })
    }
  },
  setTotalFilesCount: count => set({ totalFilesCount: count }),

  // View settings
  setSortBy: sortBy => set({ sortBy }),
  setSortOrder: order => set({ sortOrder: order }),
  setViewMode: mode => set({ viewMode: mode }),

  // Saved directories
  setSavedDirectories: directories => set({ savedDirectories: directories }),

  addSavedDirectory: directory => {
    const { savedDirectories } = get()
    set({ savedDirectories: [...savedDirectories, directory] })
  },

  removeSavedDirectory: id => {
    const { savedDirectories } = get()
    set({ savedDirectories: savedDirectories.filter(d => d.id !== id) })
  },

  loadSavedDirectory: directory => {
    set({
      selectedTags: directory.filter.selectedTags,
      sortBy: directory.filter.sortBy,
      sortOrder: directory.filter.sortOrder,
      viewMode: directory.filter.viewMode
    })
  },

  // Loading state
  setIsLoading: loading => set({ isLoading: loading }),

  // Selected item
  setSelectedItem: item => set({ selectedItem: item }),
  setSelectedFiles: files => set({ selectedFiles: files }),
  setShowDetailsPanel: show => set({ showDetailsPanel: show }),

  // New files notification
  setHasNewFiles: (hasNew, count) =>
    set({
      hasNewFiles: hasNew,
      newFilesCount: hasNew ? (count !== undefined ? count : get().newFilesCount) : 0,
      newAnalyzedPaths: hasNew ? get().newAnalyzedPaths : new Set<string>()
    }),
  incrementNewFilesCount: items => {
    const { newAnalyzedPaths } = get()
    const newPaths = new Set(newAnalyzedPaths)
    let added = false

    items.forEach(item => {
      if (item.path && !newPaths.has(item.path)) {
        newPaths.add(item.path)
        added = true
      }
    })

    if (added) {
      set({
        hasNewFiles: true,
        newAnalyzedPaths: newPaths,
        newFilesCount: newPaths.size
      })
    }
  }
}))

/**
 * Selector: 获取按三级动态权重排序后的顶层主干维度组
 * SortWeight = <builtin.meta.order (升序), file_count (降序), omw.meta.count (降序)>
 */
export const selectSortedTopLevelGroups = (
  state: Pick<VirtualDirectoryStore, 'dimensionGroups'>
): DimensionGroup[] => {
  const topLevel = (state.dimensionGroups || []).filter(
    g =>
      g.level === 0 ||
      ((!g.triggerConditions || g.triggerConditions.length === 0) &&
        (!g.parentDimensionIds || g.parentDimensionIds.length === 0))
  )
  return sortTopLevelDimensionNodes(topLevel)
}

