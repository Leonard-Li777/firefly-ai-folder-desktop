import { useState, useMemo, useCallback } from 'react'
import { VirtualDirectoryNode, SelectedTag, DimensionGroup } from '@firefly/types'
import { buildPreviewTree } from '../utils/buildPreviewTree'
import { applyTreeOptions } from '../utils/applyTreeOptions'

export function useOrganizeTree() {
  const [selectedTags, setSelectedTags] = useState<SelectedTag[]>([])
  const [options, setOptions] = useState({
    allowAICreateDirectories: false,
    skipEmptyDirectories: true,
    deduplicateFiles: true,
    flattenToRoot: false,
    flattenDirectories: false,
    enableNestedClassification: true
  })

  const rawTree = useMemo(() => {
    return buildPreviewTree(selectedTags, [], [], {
      enableNestedClassification: options.enableNestedClassification
    })
  }, [selectedTags, options])

  const { result: previewTree, stats } = useMemo(() => {
    return applyTreeOptions(
      rawTree,
      {
        flattenToRoot: options.flattenToRoot,
        flattenDirectories: options.flattenDirectories,
        skipEmptyDirectories: options.skipEmptyDirectories,
        deduplicateFiles: options.deduplicateFiles
      },
      true
    )
  }, [rawTree, options])

  return {
    selectedTags,
    setSelectedTags,
    options,
    setOptions,
    previewTree,
    stats
  }
}
