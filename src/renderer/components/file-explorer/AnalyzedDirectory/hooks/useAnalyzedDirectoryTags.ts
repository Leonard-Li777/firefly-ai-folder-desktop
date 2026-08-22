import { useMemo, useCallback } from 'react'
import { DimensionGroup, SelectedTag } from '@firefly/types'
import { useSettingsStore } from '../../../../stores/settings-store'
import {
  makeTagKey,
  parseTagKey,
  buildDimensionTree,
  getVisibleAndHiddenTags,
  getSelectedTagsFromSet
} from '../../dimension-tree-utils'

/**
 * 虚拟目录标签逻辑 Hook (遗留包装器)
 * 包装并导出核心维度树工具函数
 */
export const useAnalyzedDirectoryTags = (
  dimensionGroups: DimensionGroup[],
  selectedTagsForAnalyzedDir: Set<string>,
  setSelectedTagsForAnalyzedDir: React.Dispatch<React.SetStateAction<Set<string>>>,
  selectionStack: string[],
  setSelectionStack: React.Dispatch<React.SetStateAction<string[]>>,
  _getConfigValue: <T>(key: string) => T | undefined,
  parentTagMap?: Map<string, string[]>
) => {
  const showEmptyTags = useSettingsStore(s => s.getConfigValue<boolean>('SHOW_EMPTY_TAGS')) ?? false
  const panDimensionIds =
    useSettingsStore(s => s.getConfigValue<number[]>('PAN_DIMENSION_IDS')) || []

  const getSelectedTagsFromSetMemo = useMemo(() => {
    return getSelectedTagsFromSet(selectedTagsForAnalyzedDir, dimensionGroups, parentTagMap)
  }, [selectedTagsForAnalyzedDir, dimensionGroups, parentTagMap])

  const buildDimensionTreeCallback = useCallback(
    (parentId: number | null = null, parentTag: string | null = null, level = 0) => {
      return buildDimensionTree(dimensionGroups, parentId, parentTag, level)
    },
    [dimensionGroups]
  )

  const getVisibleAndHiddenTagsCallback = useCallback(
    (group: DimensionGroup, childTags?: any) => {
      return getVisibleAndHiddenTags(group, showEmptyTags, panDimensionIds, childTags)
    },
    [showEmptyTags, panDimensionIds]
  )

  return {
    getSelectedTagsFromSet: getSelectedTagsFromSetMemo,
    buildDimensionTree: buildDimensionTreeCallback,
    getVisibleAndHiddenTags: getVisibleAndHiddenTagsCallback,
    showEmptyTags,
    panDimensionIds
  }
}
