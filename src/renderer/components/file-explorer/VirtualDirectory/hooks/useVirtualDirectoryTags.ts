/**
 * #625 虚拟目录标签选择 Hook（薄封装）
 *
 * 将 VirtualDirectoryStore 的纯树形选择状态机暴露为 React Hook，
 * UI 组件无需手写同父互斥反选与 selectionStack 同步逻辑。
 */

import { useCallback, useMemo } from 'react'
import { useVirtualDirectoryStore } from '@/renderer/stores/virtual-directory-store'
import type { SelectedTag } from '@firefly/types'

export function useVirtualDirectoryTags() {
  const selectedTagCodes = useVirtualDirectoryStore(s => s.selectedTagCodes)
  const selectionStack = useVirtualDirectoryStore(s => s.selectionStack)
  const selectedTags = useVirtualDirectoryStore(s => s.selectedTags)
  const tagTopology = useVirtualDirectoryStore(s => s.tagTopology)
  const toggleTag = useVirtualDirectoryStore(s => s.toggleTag)
  const selectTag = useVirtualDirectoryStore(s => s.selectTag)
  const deselectTag = useVirtualDirectoryStore(s => s.deselectTag)
  const clearSelection = useVirtualDirectoryStore(s => s.clearSelection)

  const isTagSelected = useCallback(
    (code: string) => selectedTagCodes.has(code),
    [selectedTagCodes]
  )

  /**
   * 判断给定 code 的父节点是否为单选互斥
   */
  const isParentSingleSelect = useCallback(
    (code: string): boolean => {
      const node = tagTopology.get(code)
      if (!node?.parentCode) return false
      const parent = tagTopology.get(node.parentCode)
      return parent ? parent.isMultiSelect === false : false
    },
    [tagTopology]
  )

  /**
   * 获取给定 code 的同父兄弟 codes（不含自身）
   */
  const getSiblingCodes = useCallback(
    (code: string): string[] => {
      const node = tagTopology.get(code)
      if (!node?.parentCode) return []
      const siblings: string[] = []
      for (const [c, n] of tagTopology) {
        if (n.parentCode === node.parentCode && c !== code) {
          siblings.push(c)
        }
      }
      return siblings
    },
    [tagTopology]
  )

  return useMemo(
    () => ({
      selectedTagCodes,
      selectionStack,
      selectedTags,
      tagTopology,
      toggleTag,
      selectTag,
      deselectTag,
      clearSelection,
      isTagSelected,
      isParentSingleSelect,
      getSiblingCodes
    }),
    [
      selectedTagCodes,
      selectionStack,
      selectedTags,
      tagTopology,
      toggleTag,
      selectTag,
      deselectTag,
      clearSelection,
      isTagSelected,
      isParentSingleSelect,
      getSiblingCodes
    ]
  )
}
