import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import { DimensionGroup, DimensionTag, SelectedTag, UnionMode } from '@firefly/types'
import { MaterialIcon, cn } from '../../lib/utils'
import { DimensionTreeNode } from './AnalyzedDirectory/types'
import { Checkbox } from '../ui/checkbox'
import { t } from '@app/languages'
import {
  dimensionNodeKey,
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
 * R-27 文件体量治理：由 DimensionTreeSidebar.tsx 内联 flatRows 整块搬出。
 * 内部保留原 useMemo 调用与依赖数组，memo 语义不变；返回类型显式标注为 any[]（与原变量推导类型一致，调用点无类型变化）。
 */
export function useDimensionTreeFlatRows(props: Record<string, any>): any[] {
  const {
    visibleGroups,
    collapsedDimensionGroups,
    collapsedTags,
    isTagSelected,
    handleVisibleAndHiddenTags,
    maxScaleDepth
  } = props

  const rows: any[] = []
  const seenRowIds = new Set<string>()

  function traverse(
    node: DimensionTreeNode,
    parentTagValue?: string,
    ancestorChain?: string[],
    depth: number = 0,
    hostScopeCode?: string,
    ancestorIsLast: boolean[] = [],
    isLastSiblingGroup: boolean = true
  ) {
    const isCollapsed = collapsedDimensionGroups.has(node.id)
    const isTopLevel = node.level === 0

    // 与 getAllKeys（全选）共用同一份标签解析口径，确保选中态 key 集合完全一致
    const tagsToUse = resolveTagsToUse(node, parentTagValue)

    const { tagsToShow } = handleVisibleAndHiddenTags({ ...node, tags: tagsToUse }, node.childTags)

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

    tagsToShow.forEach((tag: any, index: number) => {
      const effectiveHostScopeCode = tag.hostScopeCode || hostScopeCode
      const isSelected = isTagSelected(
        tag.dimensionId,
        tag.tagValue,
        parentTagValue,
        tag.viaParentCode ?? undefined,
        tag.isLifted === true,
        tag.codePath,
        effectiveHostScopeCode
      )
      const isDisabled = tag.fileCount === 0
      const tagNodeKey = dimensionNodeKey(node.code || node.name, tag)
      const childDimensions = node.childTags?.get(tagNodeKey)
      const hasChildDimensions =
        !!childDimensions &&
        childDimensions.some(childNode => {
          let tagsToUse = childNode.tags
          if (tag.tagValue && childNode.contextualTags && childNode.contextualTags[tag.tagValue]) {
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

      const isTagExpanded = !collapsedTags.has(tagNodeKey)
      const currentChain = ancestorChain ? [...ancestorChain, tag.tagValue] : [tag.tagValue]

      const effectiveTag = tag

      // ADR-0034 §4 / PRD-0058: 构造稳定且全局唯一的 rowId，结合 depth, currentChain, dimensionId 与 tag.code/tagValue
      const codeOrVal = tag.code ? `${tag.code}_${tag.tagValue}` : tag.tagValue
      let rowId = `tag-${depth}-${currentChain.join('/')}-${tag.dimensionId}-${codeOrVal}`
      if (seenRowIds.has(rowId)) {
        let disambiguateIndex = 1
        while (seenRowIds.has(`${rowId}_${disambiguateIndex}`)) {
          disambiguateIndex++
        }
        rowId = `${rowId}_${disambiguateIndex}`
      }
      seenRowIds.add(rowId)

      const isLastTagInNode = index === tagsToShow.length - 1
      const isLastInGroup = isLastSiblingGroup && isLastTagInNode

      rows.push({
        id: rowId,
        type: 'tag',
        node,
        tag: effectiveTag,
        tagKey: tagNodeKey,
        parentTagValue,
        ancestorChain: currentChain,
        hostScopeCode: effectiveHostScopeCode,
        isSelected,
        isDisabled: effectiveTag.fileCount === 0,
        hasChildDimensions,
        isTagExpanded,
        depth,
        isLastInGroup,
        ancestorIsLast
      })

      if (hasChildDimensions && isTagExpanded && childDimensions) {
        const activeChildDims = childDimensions.filter(childNode => {
          let tagsToUse = childNode.tags
          if (tag.tagValue && childNode.contextualTags && childNode.contextualTags[tag.tagValue]) {
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

        activeChildDims.forEach((childNode, cIdx) => {
          const isLastChildDim = cIdx === activeChildDims.length - 1
          const nextHostCode =
            tag.hostScopeCode || (depth === 0 ? tag.code : hostScopeCode) || tag.code || undefined
          traverse(
            childNode,
            tag.tagValue,
            currentChain,
            depth + 1,
            nextHostCode,
            [...ancestorIsLast, isLastInGroup],
            isLastChildDim
          )
        })
      }
    })
  }

  visibleGroups.forEach((group: any) => traverse(group, undefined, undefined, 0))
  return rows
}
