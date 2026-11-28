import React, { useState, useMemo, useEffect, useCallback } from 'react'
import { MaterialIcon } from '../../../../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Button } from '../../../../ui/button'
import { Input } from '../../../../ui/input'
import { Badge } from '../../../../ui/badge'
import { DimensionGroup } from '@firefly/types'
import {
  isExtensionDimension,
  isFileTypeDimension,
  isRuleSubdivisionDimension,
  filterDimensionTags,
  concept,
  CANONICAL_NAMES,
  TOP_ROOT_CODES,
  ROOT_DIMENSION_META,
  CONTROLLED_DIMENSION_ROOT_CODES,
  isControlledConcept
} from '@firefly/shared'
import { toast } from '../../../../common/Toast'
import { SplitPane } from '../../../../common/SplitPane'
import { useAnalyzedDirectoryStore } from '@/renderer/stores/analyzed-directory-store'

import { DimensionGroupCard } from '.././batch-tag-view/DimensionGroupCard'
import { HierarchicalDimensionCard } from '.././batch-tag-view/HierarchicalDimensionCard'
import {
  FILE_PURPOSE_CODE,
  CONTENT_TAGS_CODE,
  SECURITY_LEVEL_CODE,
  isExtensionTag,
  isMutexSingleGroup,
  isPanDimensionGroup,
  isRootDimension,
  isSensitiveDimension,
  getTriggerConditionParentCodes,
  resolveDimensionGroupCode,
  resolveDimensionRootCode
} from '.././batch-tag-view/dimension-utils'
import type {
  BatchTagViewProps,
  HierarchicalDimensionGroup,
  TagActionState
} from '.././batch-tag-view/types'

/**
 * 由 BatchTagView 内联 useMemo 抽离的纯派生函数（R-27 文件体量治理）。
 * 行为与抽取前完全一致：仅做维度组合并、删除标记过滤、维度名自引用剔除与泛维度排序。
 */
export function buildEffectiveDimensionGroups({
  // R-27：由 BatchTagView 内联 useMemo 抽离
  fullPresetGroups,
  dimensionGroups,
  fileCustomTags,
  tagFileCounts,
  deletedTagKeys,
  rootCategoryNamesSet
}: {
  fullPresetGroups: DimensionGroup[]
  dimensionGroups: DimensionGroup[]
  fileCustomTags: Map<string, Set<string>>
  tagFileCounts: Record<string, number>
  deletedTagKeys: Set<string>
  rootCategoryNamesSet: Set<string>
}): DimensionGroup[] {
  const isDeletedTag = (dimId: number, tagVal: string) => {
    const valStr = String(tagVal).trim()
    return (
      deletedTagKeys.has(`${dimId}::${valStr}`) ||
      deletedTagKeys.has(`${dimId}::${valStr.toLowerCase()}`)
    )
  }

  const dimMap = new Map<number, DimensionGroup>()

  // 归一化查找已存在的维度组（按 ID、Code、Name 精准匹配，杜绝同一维度分裂出两个卡片）
  const findExistingGroup = (candidate: DimensionGroup): DimensionGroup | undefined => {
    if (candidate.id !== undefined && dimMap.has(candidate.id)) {
      return dimMap.get(candidate.id)
    }
    if (candidate.code) {
      for (const g of dimMap.values()) {
        if (g.code && g.code === candidate.code) return g
      }
    }
    if (candidate.name) {
      const cName = candidate.name.trim()
      for (const g of dimMap.values()) {
        if (g.name && g.name.trim() === cName) return g
      }
    }
    return undefined
  }

  // 1. 载入全量预设维度定义
  for (const g of fullPresetGroups) {
    const isPan = isPanDimensionGroup(g, fullPresetGroups)
    const prevMeta =
      typeof g.metadata === 'object' && g.metadata !== null
        ? (g.metadata as Record<string, any>)
        : {}
    const prevFlag =
      typeof prevMeta.flag === 'object' && prevMeta.flag !== null ? prevMeta.flag : {}
    dimMap.set(g.id, {
      ...g,
      code: resolveDimensionGroupCode(g) || g.code,
      metadata: {
        ...prevMeta,
        ...(isPan ? { flag: { ...prevFlag, isPanDimension: true } } : {})
      },
      tags: g.tags ? g.tags.filter(t => !isDeletedTag(g.id, t.tagValue)) : []
    })
  }

  // 2. 合并传入的 dimensionGroups（包含数据库中已存的自定义标签，按 ID/Code/Name 精确归并）
  for (const g of dimensionGroups) {
    const existing = findExistingGroup(g)
    if (existing) {
      const existingTagValues = new Set((existing.tags || []).map(t => t.tagValue.toLowerCase()))
      for (const t of g.tags || []) {
        if (
          !isDeletedTag(existing.id, t.tagValue) &&
          !existingTagValues.has(t.tagValue.toLowerCase())
        ) {
          existing.tags = [
            ...(existing.tags || []),
            {
              ...t,
              dimensionId: existing.id,
              dimensionName: existing.name
            }
          ]
          existingTagValues.add(t.tagValue.toLowerCase())
        }
      }
      if (!existing.code) existing.code = resolveDimensionGroupCode(g) || g.code
      if (isPanDimensionGroup(g, fullPresetGroups)) {
        const prevMeta =
          typeof existing.metadata === 'object' && existing.metadata !== null
            ? (existing.metadata as Record<string, any>)
            : {}
        const prevFlag =
          typeof prevMeta.flag === 'object' && prevMeta.flag !== null ? prevMeta.flag : {}
        existing.metadata = {
          ...prevMeta,
          flag: {
            ...prevFlag,
            isPanDimension: true
          }
        }
      }
    } else {
      const isPan = isPanDimensionGroup(g, fullPresetGroups)
      const prevMeta =
        typeof g.metadata === 'object' && g.metadata !== null
          ? (g.metadata as Record<string, any>)
          : {}
      const prevFlag =
        typeof prevMeta.flag === 'object' && prevMeta.flag !== null ? prevMeta.flag : {}
      dimMap.set(g.id, {
        ...g,
        code: resolveDimensionGroupCode(g) || g.code,
        metadata: {
          ...prevMeta,
          ...(isPan ? { flag: { ...prevFlag, isPanDimension: true } } : {})
        },
        tags: g.tags ? g.tags.filter(t => !isDeletedTag(g.id, t.tagValue)) : []
      })
    }
  }

  // 3. 将待整理文件中收集到的自定义标签高效合并（坚决阻断维度名作为标签侵入）
  fileCustomTags.forEach((tagSet, dimIdentifier) => {
    let g: DimensionGroup | undefined
    // 1. 若为数字 ID 或数字字符串，优先按 ID 精确查找
    const numDimId = Number(dimIdentifier)
    if (!Number.isNaN(numDimId)) {
      g = dimMap.get(numDimId)
      if (!g) {
        for (const group of dimMap.values()) {
          if (group.id === numDimId) {
            g = group
            break
          }
        }
      }
    }
    // 2. 若未匹配，按受控维度 Code 匹配（例如 builtin.geographical_location）
    if (!g) {
      for (const group of dimMap.values()) {
        const gCode = resolveDimensionGroupCode(group) || group.code
        if (gCode && gCode === dimIdentifier) {
          g = group
          break
        }
      }
    }
    // 3. 若仍未匹配，按权威常量 ROOT_DIMENSION_META 映射数字 ID
    if (!g && ROOT_DIMENSION_META[dimIdentifier]?.id !== undefined) {
      const canonicalId = ROOT_DIMENSION_META[dimIdentifier].id
      g = dimMap.get(canonicalId)
    }
    // 4. 保底：按维度展示名称匹配
    if (!g) {
      for (const group of dimMap.values()) {
        if (group.name && group.name.trim() === dimIdentifier.trim()) {
          g = group
          break
        }
      }
    }

    if (g) {
      const existingTagValues = new Set((g.tags || []).map(t => t.tagValue.toLowerCase()))
      tagSet.forEach(strVal => {
        const trimmed = strVal.trim()
        if (!trimmed) return
        // 铁律：维度名称绝不能作为自身区块下的标签，且顶层元分类根名不能作为标签
        if (trimmed === g.name.trim() || rootCategoryNamesSet.has(trimmed)) {
          return
        }
        if (!isDeletedTag(g.id, strVal) && !existingTagValues.has(trimmed.toLowerCase())) {
          g.tags = [
            ...(g.tags || []),
            {
              dimensionId: g.id,
              dimensionName: g.name,
              tagValue: trimmed,
              fileCount: tagFileCounts[trimmed] || 1,
              level: g.level || 2
            }
          ]
          existingTagValues.add(trimmed.toLowerCase())
        }
      })
    }
  })

  // 4. 过滤排除扩展名维度、文件类型维度以及由标签找补程序处理的规则细分维度
  const nonExtGroups = Array.from(dimMap.values()).filter(g => {
    if (
      isExtensionDimension(g) ||
      isFileTypeDimension(g) ||
      (isRuleSubdivisionDimension(g) && !isPanDimensionGroup(g, fullPresetGroups))
    ) {
      return false
    }
    // 敏感内容维度的隐蔽门禁：除非同维度的标签有一个及以上文件计数，否则全量隐藏不展示
    if (isSensitiveDimension(g)) {
      const hasHit = (g.tags || []).some(t => (tagFileCounts[t.tagValue] || t.fileCount || 0) > 0)
      if (!hasHit) return false
    }
    return true
  })

  // 动态收集属于文件用途子维度的预置标签值（如处理状态、安全等级等），严禁硬编码静态数组
  const purposeSubdimensionTagNames = new Set<string>()
  if (fullPresetGroups && fullPresetGroups.length > 0) {
    for (const g of fullPresetGroups) {
      const parents = getTriggerConditionParentCodes(g, fullPresetGroups)
      const rootCode = resolveDimensionRootCode(g, fullPresetGroups)
      if (parents.includes(FILE_PURPOSE_CODE) || rootCode === FILE_PURPOSE_CODE) {
        for (const t of g.tags || []) {
          if (t.tagValue) purposeSubdimensionTagNames.add(t.tagValue.trim())
        }
      }
    }
  }

  return nonExtGroups.map(group => {
    // 过滤排除首部或尾部的预设扩展名触发标签
    const rawTags = group.tags || []

    // 安全等级单字异常防腐：防止历史脏别名 '共'、'内' 侵入，规范化为 '公开'、'内部'
    const isSecurityDim = (group as any).code === SECURITY_LEVEL_CODE

    const sanitizedRawTags = rawTags.map(t => {
      if (isSecurityDim && t.tagValue) {
        const trimmed = t.tagValue.trim()
        if (trimmed === '共') return { ...t, tagValue: '公开' } // i18n-disable-line: 历史脏别名清洗，受控概念展示名非 UI 文案
        if (trimmed === '内') return { ...t, tagValue: '内部' } // i18n-disable-line: 历史脏别名清洗，受控概念展示名非 UI 文案
      }
      return t
    })

    // 文件用途直属标签纯净化：严禁混入属于处理状态、安全等级等子维度的预设标签
    const isFilePurposeRoot = (group as any).code === FILE_PURPOSE_CODE

    const purifiedRawTags = isFilePurposeRoot
      ? sanitizedRawTags.filter(t => !purposeSubdimensionTagNames.has(t.tagValue.trim()))
      : sanitizedRawTags

    const allowedTagValues = new Set(
      filterDimensionTags({ id: group.id, tags: purifiedRawTags.map(t => t.tagValue) })
    )

    // 去重并确保单字替换后不重复，严格阻断维度名称作为可选标签
    const seenTagValues = new Set<string>()
    const validTags = purifiedRawTags.filter(t => {
      if (isDeletedTag(group.id, t.tagValue)) return false
      if (!allowedTagValues.has(t.tagValue)) return false
      if (isExtensionTag(t.tagValue)) return false
      const trimmed = t.tagValue.trim()
      // 铁律：维度名本身绝对不能作为其自身区块下的标签，只有其下的标签才是可选标签；顶层元分类根名不能作为标签
      if (trimmed === group.name.trim() || rootCategoryNamesSet.has(trimmed)) {
        return false
      }
      const lowerVal = trimmed.toLowerCase()
      if (seenTagValues.has(lowerVal)) return false
      seenTagValues.add(lowerVal)
      return true
    })

    // 注意：同一 code / 同名标签挂在多父级下（codePath 各异）是既有设计，**严禁在此归并去重**；
    // 分支条目的 React key 唯一性由渲染层 getTagPillKey（纳入 codePath）保证。
    // 如果是泛维度，预先排序好 tags，避免每次组件渲染都重复执行 Array.sort
    const isPan = isPanDimensionGroup(group, fullPresetGroups)
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
}
