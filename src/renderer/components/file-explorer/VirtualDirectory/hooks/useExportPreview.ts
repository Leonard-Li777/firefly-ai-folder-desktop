import { useState, useMemo } from 'react'
import { VirtualDirectoryNode, SelectedTag, DimensionGroup } from '@firefly/types'
import { buildPreviewTree } from '../../Organize/utils/buildPreviewTree'
import { applyTreeOptions } from '../../Organize/utils/applyTreeOptions'

export interface ExportPreviewOptions {
  deduplicateFiles: boolean
  flattenDirectories: boolean
  flattenFiles: boolean
  skipEmptyDirs: boolean
}

const defaultOptions: ExportPreviewOptions = {
  deduplicateFiles: false,
  flattenDirectories: false,
  flattenFiles: false,
  skipEmptyDirs: false
}

export function useExportPreview(
  selectedTags: SelectedTag[],
  _selectionStack: string[],
  dimensionGroups: DimensionGroup[],
  allFiles: any[]
) {
  const [options, setOptions] = useState<ExportPreviewOptions>(defaultOptions)

  // 标签选择过多时跳过预览树构建（设定 3000 阈值）
  const isTooManyTags = selectedTags.length > 3000

  const rawTree = useMemo(() => {
    if (selectedTags.length === 0) return []
    if (isTooManyTags) return []
    return buildPreviewTree(selectedTags, dimensionGroups, allFiles, {
      enableNestedClassification: true
    })
  }, [selectedTags, dimensionGroups, allFiles, isTooManyTags])

  const { result: previewTree, stats } = useMemo(() => {
    if (rawTree.length === 0)
      return { result: [], stats: { dedupedCount: 0, skippedEmptyCount: 0 } }
    return applyTreeOptions(
      rawTree,
      {
        flattenToRoot: options.flattenFiles,
        flattenDirectories: options.flattenDirectories,
        skipEmptyDirectories: options.skipEmptyDirs,
        deduplicateFiles: options.deduplicateFiles
      },
      false
    )
  }, [rawTree, options])

  const totalFileCount = useMemo(() => {
    // 累加所有根节点 fileCount（含结构容器汇总的子层计数），
    // 作为受影响文件数的上界预估
    return previewTree.reduce((sum, n) => sum + n.fileCount, 0)
  }, [previewTree])

  const updateOption = <K extends keyof ExportPreviewOptions>(
    key: K,
    value: ExportPreviewOptions[K]
  ) => {
    setOptions(prev => {
      if (key === 'flattenDirectories' && value === true) {
        return { ...prev, flattenDirectories: true, flattenFiles: false }
      }
      if (key === 'flattenFiles' && value === true) {
        return { ...prev, flattenFiles: true, flattenDirectories: false }
      }
      return { ...prev, [key]: value }
    })
  }

  return {
    options,
    setOptions,
    updateOption,
    previewTree,
    stats,
    totalFileCount,
    defaultOptions,
    isTooManyTags
  }
}
