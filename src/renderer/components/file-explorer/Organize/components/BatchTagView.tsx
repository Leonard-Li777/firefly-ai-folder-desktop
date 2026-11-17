import React, { useState, useMemo, useEffect, useCallback } from 'react'
import { MaterialIcon } from '../../../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Badge } from '../../../ui/badge'
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
import { toast } from '../../../common/Toast'
import { SplitPane } from '../../../common/SplitPane'
import { useAnalyzedDirectoryStore } from '@/renderer/stores/analyzed-directory-store'

import { DimensionGroupCard } from './batch-tag-view/DimensionGroupCard'
import { HierarchicalDimensionCard } from './batch-tag-view/HierarchicalDimensionCard'
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
} from './batch-tag-view/dimension-utils'
import type { BatchTagViewProps } from './batch-tag-view/types'

export { isExtensionDimension }
export type { HierarchicalDimensionGroup } from './batch-tag-view/types'
export {
  isExtensionTag,
  isSensitiveDimension,
  resolveDimensionGroupCode,
  getTriggerConditionParentCodes,
  resolveDimensionRootCode,
  isRootDimension,
  isPanDimensionGroup
} from './batch-tag-view/dimension-utils'

export const BatchTagView: React.FC<BatchTagViewProps> = ({
  files,
  dimensionGroups = [],
  onSaveTags,
  isSaving = false,
  inspectedFile = null,
  onClearInspectedFile
}) => {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const totalFilesCount = files.length

  // 每个已有标签的状态映射: `${dimensionId}::${tagValue}` -> TagActionState
  const [tagStates, setTagStates] = useState<Record<string, TagActionState>>({})
  // 新建标签列表: dimensionId -> string[]
  const [newTagNames, setNewTagNames] = useState<Record<number, string[]>>({})
  // 新建标签的受控元数据映射: dimensionId -> tagName -> { isControlled, matchedParent, code?, ancestryMatchedCode?, targetParentCode }
  const [newTagMetaMap, setNewTagMetaMap] = useState<
    Record<
      number,
      Record<
        string,
        {
          isControlled: boolean
          matchedParent: boolean
          code?: string | null
          ancestryMatchedCode?: string | null
          targetParentCode: string
        }
      >
    >
  >({})
  // 标记待删除的已有泛维度标签集合: Set of `${dimensionId}::${tagValue}`
  const [deletedTagKeys, setDeletedTagKeys] = useState<Set<string>>(() => new Set())
  // 正在内嵌输入的维度ID
  const [activeInputDimId, setActiveInputDimId] = useState<number | null>(null)
  const [inputVal, setInputVal] = useState('')
  // 正在向 Omni 预检受控语义的加载状态 (互斥防重)
  const [isInspectingTag, setIsInspectingTag] = useState(false)
  // 搜索关键字
  const [searchQuery, setSearchQuery] = useState('')
  // 异步获取的全量预设维度定义（包含当前文件集合未拥有的所有预设标签）
  const [fullPresetGroups, setFullPresetGroups] = useState<DimensionGroup[]>([])
  // 是否正在加载预设维度数据（防首屏空态误闪烁）
  const [isLoadingPresets, setIsLoadingPresets] = useState(true)

  // 拉取全量预设维度与标签数据
  const loadFullDimensions = useCallback(async () => {
    try {
      const workspacePath = useAnalyzedDirectoryStore.getState().currentWorkspaceDirectory?.path
      const res = await window.electronAPI?.analyzedDirectory?.getDimensionGroups({
        ...(workspacePath ? { workspaceDirectoryPath: workspacePath } : {}),
        includeAllPresetTags: true,
        excludeExtensionDimension: true
      })
      if (res?.groups && res.groups.length > 0) {
        setFullPresetGroups(res.groups)
      }
    } catch (err) {
      console.warn('[BatchTagView] 加载全量预设维度失败，使用传入的维度数据:', err)
    } finally {
      setIsLoadingPresets(false)
    }
  }, [])

  // 挂载时拉取全量预设维度与标签数据
  useEffect(() => {
    loadFullDimensions()
  }, [loadFullDimensions])

  // 监听全局标签更新广播（如删除标签或保存变更后自动同步）
  useEffect(() => {
    const handleTagsChanged = () => {
      loadFullDimensions()
    }
    window.addEventListener('tags-updated', handleTagsChanged)
    window.addEventListener('tags:updated', handleTagsChanged)
    return () => {
      window.removeEventListener('tags-updated', handleTagsChanged)
      window.removeEventListener('tags:updated', handleTagsChanged)
    }
  }, [loadFullDimensions])

  // 1. 单次快速循环：统计待整理文件中各标签的覆盖计数，并汇总各维度的自定义标签（避免重复多重扫描）
  const { tagFileCounts, fileCustomTags } = useMemo(() => {
    const counts: Record<string, number> = {}
    const customTagsByDim = new Map<string, Set<string>>()

    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const fileTagSet = new Set<string>()

      if (Array.isArray(f.dimensionTags)) {
        for (let j = 0; j < f.dimensionTags.length; j++) {
          const dt = f.dimensionTags[j]
          const dimId = dt?.dimensionId ?? dt?.dimension
          const val = dt?.tagValue ?? dt?.tag ?? dt?.name
          if (val) {
            const strVal = String(val).trim()
            fileTagSet.add(strVal)
            if (dimId !== undefined && dimId !== null) {
              const strDimKey = String(dimId).trim()
              if (strDimKey) {
                let dimSet = customTagsByDim.get(strDimKey)
                if (!dimSet) {
                  dimSet = new Set<string>()
                  customTagsByDim.set(strDimKey, dimSet)
                }
                dimSet.add(strVal)
              }
            }
          }
        }
      }

      if (Array.isArray(f.tags)) {
        for (let j = 0; j < f.tags.length; j++) {
          const t = f.tags[j]
          if (typeof t === 'string') {
            fileTagSet.add(t.trim())
          } else if (t && typeof t === 'object') {
            const val = t.tagValue || t.tagName || t.name || t.value || t.tag
            const dimId = t.dimensionId || t.dimension
            if (val) {
              const strVal = String(val).trim()
              fileTagSet.add(strVal)
              if (dimId !== undefined && dimId !== null) {
                const strDimKey = String(dimId).trim()
                if (strDimKey) {
                  let dimSet = customTagsByDim.get(strDimKey)
                  if (!dimSet) {
                    dimSet = new Set<string>()
                    customTagsByDim.set(strDimKey, dimSet)
                  }
                  dimSet.add(strVal)
                }
              }
            }
          }
        }
      }

      fileTagSet.forEach(tagVal => {
        counts[tagVal] = (counts[tagVal] || 0) + 1
      })
    }

    return { tagFileCounts: counts, fileCustomTags: customTagsByDim }
  }, [files])

  // 铁律：维度名只用于区块/卡片名，绝不能作为自身区块下的标签供用户选择；顶层元根名不能作为叶子标签
  // 铁律：维度名只用于区块/卡片名，绝不能作为自身区块下的标签供用户选择；顶层元根名不能作为叶子标签
  const rootCategoryNamesSet = useMemo(() => {
    const names = new Set<string>()
    // 1. 从 SSOT TOP_ROOT_CODES 中收集所有顶层根维度的权威名称
    for (const code of TOP_ROOT_CODES) {
      const meta = ROOT_DIMENSION_META[code]
      if (meta?.name) names.add(meta.name.trim())
      try {
        const canonical = concept(code as any)
        if (canonical) names.add(canonical)
      } catch {}
    }
    // 2. 从全量维度预设池及传入维度组中收集所有维度名称
    for (const g of fullPresetGroups) {
      if (g.name) names.add(g.name.trim())
    }
    for (const g of dimensionGroups) {
      if (g.name) names.add(g.name.trim())
    }
    return names
  }, [fullPresetGroups, dimensionGroups])

  // 2. 合并全量预设维度、传入维度以及当前待整理文件中已拥有的自定义标签（排除被用户在工作台标记删除的标签）
  const effectiveDimensionGroups = useMemo(() => {
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
          if (trimmed === '共') return { ...t, tagValue: '公开' } // locale-invariant-ok: 历史脏别名清洗
          if (trimmed === '内') return { ...t, tagValue: '内部' } // locale-invariant-ok: 历史脏别名清洗
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
  }, [
    fullPresetGroups,
    dimensionGroups,
    fileCustomTags,
    tagFileCounts,
    deletedTagKeys,
    rootCategoryNamesSet
  ])

  // 判断是否为泛维度（由策略元数据 flag.isPanDimension === true 驱动）
  const isPanDimension = useCallback(
    (group: DimensionGroup) => isPanDimensionGroup(group, fullPresetGroups),
    [fullPresetGroups]
  )

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

  const inspectedFileItem = Array.isArray(inspectedFile) ? inspectedFile[0] : inspectedFile

  // 建立维度 ID 与维度名称字典（基于 effectiveDimensionGroups 缓存，避免每次切换选中文件时重复全量遍历）
  const { dimIdToName, tagToDimName } = useMemo(() => {
    const idMap = new Map<number, string>()
    const tagMap = new Map<string, { dimId: number; name: string }>()

    effectiveDimensionGroups.forEach(g => {
      idMap.set(g.id, g.name)
      if (Array.isArray(g.tags)) {
        g.tags.forEach(t => {
          if (t?.tagValue) {
            tagMap.set(t.tagValue.trim().toLowerCase(), { dimId: g.id, name: g.name })
          }
        })
      }
    })

    return { dimIdToName: idMap, tagToDimName: tagMap }
  }, [effectiveDimensionGroups])

  // 提取选中聚焦文件所拥有的结构化标签列表（包含归属维度名称），供顶部状态条集中展示
  const inspectedFileTagsWithDimension = useMemo(() => {
    if (!inspectedFileItem) return []

    const result: Array<{ dimensionId?: number; dimensionName: string; tagValue: string }> = []
    const seen = new Set<string>()

    const addTag = (dimId: number | undefined, dimName: string | undefined, tagVal: any) => {
      if (!tagVal) return
      const valStr = String(tagVal).trim()
      if (!valStr || isExtensionTag(valStr) || rootCategoryNamesSet.has(valStr)) return

      let resolvedDimId = dimId
      let resolvedDimName = dimName
      if (!resolvedDimName && resolvedDimId !== undefined) {
        resolvedDimName = dimIdToName.get(Number(resolvedDimId))
      }
      if (!resolvedDimName) {
        const matched = tagToDimName.get(valStr.toLowerCase())
        if (matched) {
          resolvedDimId = matched.dimId
          resolvedDimName = matched.name
        } else {
          resolvedDimId = undefined
          resolvedDimName = CANONICAL_NAMES.CONTENT_TAGS
        }
      }

      const finalDimName = resolvedDimName || t('内容标签')
      const key = `${finalDimName}::${valStr.toLowerCase()}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push({
          dimensionId: resolvedDimId,
          dimensionName: finalDimName,
          tagValue: valStr
        })
      }
    }

    // 1. dimensionTags
    if (Array.isArray(inspectedFileItem.dimensionTags)) {
      for (const dt of inspectedFileItem.dimensionTags) {
        const dimId = dt?.dimensionId ?? dt?.dimension
        const dimName =
          dt?.dimensionName ??
          (typeof dt?.dimension === 'string' && isNaN(Number(dt.dimension))
            ? dt.dimension
            : undefined)
        const val = dt?.tagValue ?? dt?.tag ?? dt?.name ?? dt?.value
        addTag(
          dimId !== undefined && !isNaN(Number(dimId)) ? Number(dimId) : undefined,
          dimName,
          val
        )
      }
    }

    // 2. tags
    if (Array.isArray(inspectedFileItem.tags)) {
      for (const t of inspectedFileItem.tags) {
        if (typeof t === 'string') {
          addTag(undefined, undefined, t)
        } else if (t && typeof t === 'object') {
          const dimId = t.dimensionId ?? t.dimension
          const dimName =
            t.dimensionName ??
            (typeof t.dimension === 'string' && isNaN(Number(t.dimension))
              ? t.dimension
              : undefined)
          const val = t.tagValue ?? t.tagName ?? t.name ?? t.value ?? t.tag
          addTag(
            dimId !== undefined && !isNaN(Number(dimId)) ? Number(dimId) : undefined,
            dimName,
            val
          )
        }
      }
    }

    // 3. 排序：按维度名称归类，同维度按标签名称排序
    result.sort((a, b) => {
      if (a.dimensionName !== b.dimensionName) {
        // 让“内容标签”排在最后
        const dimCodeA =
          (a.dimensionId ? CONTROLLED_DIMENSION_ROOT_CODES[a.dimensionId] : undefined) ||
          (isControlledConcept(a.dimensionName) ? concept(a.dimensionName as any) : undefined)
        const dimCodeB =
          (b.dimensionId ? CONTROLLED_DIMENSION_ROOT_CODES[b.dimensionId] : undefined) ||
          (isControlledConcept(b.dimensionName) ? concept(b.dimensionName as any) : undefined)
        const isAContent = dimCodeA === CONTENT_TAGS_CODE
        const isBContent = dimCodeB === CONTENT_TAGS_CODE
        if (isAContent && !isBContent) return 1
        if (!isAContent && isBContent) return -1
        return a.dimensionName.localeCompare(b.dimensionName, 'zh-CN')
      }
      return a.tagValue.localeCompare(b.tagValue, 'zh-CN')
    })

    return result
  }, [inspectedFileItem, dimIdToName, tagToDimName, activeLanguage, rootCategoryNamesSet])

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
    if (activeInputDimId !== null && inputVal.trim()) {
      addCount++
    }
    // 统计待删除标签数量（按唯一 key 计数，避免重复）
    const distinctDeletedKeys = new Set<string>()
    deletedTagKeys.forEach(k => {
      const [d, ...rest] = k.split('::')
      distinctDeletedKeys.add(`${d}::${rest.join('::').toLowerCase()}`)
    })
    removeCount += distinctDeletedKeys.size

    return { addCount, removeCount, totalChanges: addCount + removeCount }
  }, [tagStates, newTagNames, activeInputDimId, inputVal, deletedTagKeys])

  // 维度 ID → 维度组映射。handleToggleTag 只拿到 tagKey（`${dimId}::${tagValue}`），
  // 靠它反查所属维度以判定互斥策略（规格 §5.2）；随维度列表变化重建。
  const groupById = useMemo(() => {
    const map = new Map<number, DimensionGroup>()
    for (const g of effectiveDimensionGroups) map.set(g.id, g)
    return map
  }, [effectiveDimensionGroups])

  // 处理标签点击三态循环 (Initial -> Add All -> Remove All -> Initial)
  const handleToggleTag = useCallback(
    (tagKey: string) => {
      setTagStates(prev => {
        const curr = prev[tagKey] || 'initial'
        let next: TagActionState = 'add_all'
        if (curr === 'initial') next = 'add_all'
        else if (curr === 'add_all') next = 'remove_all'
        else if (curr === 'remove_all') next = 'initial'

        const copy = { ...prev }

        if (next === 'initial') {
          delete copy[tagKey]
          return copy
        }

        // S3 规格 §5.2：单选 / unknown 维度下，把某标签置为 add_all 时，
        // 清除同组其他标签的 add_all（置回 initial），仅保留当前标签。
        // remove_all 不触发联动——用户显式要删的标签不应被互斥逻辑撤销。
        // 注意：这只是选中态收敛，不删除库中已存在的旧标签（收敛靠 S2 写库侧）。
        if (next === 'add_all') {
          const dimId = Number(tagKey.split('::')[0])
          const group = groupById.get(dimId)
          if (group && isMutexSingleGroup(group)) {
            const prefix = `${dimId}::`
            for (const key of Object.keys(prev)) {
              if (key !== tagKey && key.startsWith(prefix) && prev[key] === 'add_all') {
                delete copy[key]
              }
            }
          }
        }

        copy[tagKey] = next
        return copy
      })
    },
    [groupById]
  )

  // 重置全部标签变更
  const handleResetAllChanges = useCallback(() => {
    setTagStates({})
    setNewTagNames({})
    setDeletedTagKeys(new Set())
    setInputVal('')
    setActiveInputDimId(null)
    toast.info(t('已重置所有未保存的标签变更'))
  }, [])

  // 快速全选某维度下的全部标签为全部附加
  const handleBatchSetDimensionTags = useCallback(
    (group: DimensionGroup, targetState: TagActionState) => {
      // S3 规格 §5.3 状态机层兜底（第二道防线）：单选 / unknown 维度禁止「全附」。
      // 展示层已把这些按钮替换为纯文本提示「选一个」，但任何新增入口都会绕过展示层，
      // 故这里必须独立判定。toast 说明原因，避免用户以为按钮坏了。
      if (targetState === 'add_all' && isMutexSingleGroup(group)) {
        toast.info(t('该维度为单选维度，一次只能附加一个标签'))
        return
      }
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
    },
    []
  )

  // 提交新建标签
  const handleAddNewTag = useCallback(
    async (dimensionId: number) => {
      const trimmed = inputVal.trim()
      if (!trimmed) {
        setActiveInputDimId(null)
        return
      }
      if (isExtensionTag(trimmed)) {
        toast.warning(t('扩展名由程序自动识别，无需手动新建标签'))
        return
      }
      // 铁律：维度名称绝不能作为标签添加 (多重自我同名拦截)
      const targetGroup = effectiveDimensionGroups.find(g => g.id === dimensionId)
      if (
        (targetGroup &&
          (trimmed === targetGroup.name.trim() ||
            (isControlledConcept(trimmed) && targetGroup.code === concept(trimmed)))) ||
        rootCategoryNamesSet.has(trimmed)
      ) {
        toast.warning(t('维度名称不能作为标签，请输入具体标签名'))
        return
      }

      if (isInspectingTag) return
      setIsInspectingTag(true)

      try {
        const targetParentCode =
          targetGroup?.code ||
          CONTROLLED_DIMENSION_ROOT_CODES[dimensionId] ||
          (targetGroup?.name && isControlledConcept(targetGroup.name)
            ? concept(targetGroup.name)
            : undefined) ||
          concept('内容标签')

        // 即时预检受控语义
        let meta: {
          isControlled: boolean
          matchedParent: boolean
          code?: string | null
          ancestryMatchedCode?: string | null
          targetParentCode: string
        } = {
          isControlled: false,
          matchedParent: false,
          targetParentCode
        }

        if (window.electronAPI?.organizeBatch?.inspectControlledTags) {
          try {
            const inspectRes = await window.electronAPI.organizeBatch.inspectControlledTags([
              { tagName: trimmed, targetParentCode }
            ])
            if (inspectRes && inspectRes.success && inspectRes.results?.[0]) {
              const r = inspectRes.results[0]
              meta = {
                isControlled: r.isControlled,
                matchedParent: r.matchedParent,
                code: r.code,
                ancestryMatchedCode: r.ancestryMatchedCode,
                targetParentCode
              }
            }
          } catch (err: any) {
            // 悲观熔断铁律：Omni 离线或超时强阻断，保留输入框文本，严禁静默假成功
            toast.error(t('受控标签鉴别失败: Omni 服务未就绪或响应超时'))
            return
          }
        }

        setNewTagMetaMap(prev => ({
          ...prev,
          [dimensionId]: {
            ...(prev[dimensionId] || {}),
            [trimmed]: meta
          }
        }))

        setNewTagNames(prev => ({
          ...prev,
          [dimensionId]: [...(prev[dimensionId] || []).filter(n => n !== trimmed), trimmed]
        }))
        setInputVal('')
        setActiveInputDimId(null)
      } finally {
        setIsInspectingTag(false)
      }
    },
    [inputVal, effectiveDimensionGroups, rootCategoryNamesSet, isInspectingTag]
  )

  // 删除新建标签
  const handleRemoveNewTag = useCallback((dimensionId: number, name: string) => {
    setNewTagNames(prev => ({
      ...prev,
      [dimensionId]: (prev[dimensionId] || []).filter(n => n !== name)
    }))
    setNewTagMetaMap(prev => {
      const nextDimMap = { ...(prev[dimensionId] || {}) }
      delete nextDimMap[name]
      return {
        ...prev,
        [dimensionId]: nextDimMap
      }
    })
  }, [])

  // 标记泛维度中的已有标签为待删除（从当前工作台中隐藏并加入移除变更队列）
  const handleDeleteExistingTag = useCallback(
    (dimId: number, tagName: string, e: React.MouseEvent) => {
      e.stopPropagation()
      const strVal = tagName.trim()
      const key = `${dimId}::${strVal}`
      const lowerKey = `${dimId}::${strVal.toLowerCase()}`

      setDeletedTagKeys(prev => {
        const next = new Set(prev)
        next.add(key)
        next.add(lowerKey)
        return next
      })

      // 如果该标签此前有三态附加设置，清理之
      setTagStates(prev => {
        const next = { ...prev }
        delete next[key]
        delete next[lowerKey]
        return next
      })

      toast.info(t('已将标签「{name}」标记为待移除，点击保存后生效', { name: tagName }))
    },
    []
  )

  // 汇总变更并提交
  const handleSave = async () => {
    // 1. 优先提取当前正在输入的未提交新建标签（支持用户未敲回车直接点击保存）
    const activeNewTags: Record<number, string[]> = {}
    Object.entries(newTagNames).forEach(([dimIdStr, names]) => {
      activeNewTags[Number(dimIdStr)] = [...names]
    })

    if (activeInputDimId !== null && inputVal.trim()) {
      const trimmed = inputVal.trim()
      const targetGroup = effectiveDimensionGroups.find(g => g.id === activeInputDimId)
      const isDimName =
        (targetGroup &&
          (trimmed === targetGroup.name.trim() ||
            (isControlledConcept(trimmed) && targetGroup.code === concept(trimmed)))) ||
        rootCategoryNamesSet.has(trimmed)

      if (isExtensionTag(trimmed)) {
        toast.warning(t('扩展名由程序自动识别，无需手动新建标签'))
        return
      }
      if (isDimName) {
        toast.warning(t('维度名称不能作为标签，请输入具体标签名'))
        return
      }

      // 提取未提交文本即时向 Omni 预检，严禁未鉴别直接保存
      const targetParentCode =
        targetGroup?.code ||
        CONTROLLED_DIMENSION_ROOT_CODES[activeInputDimId] ||
        (targetGroup?.name && isControlledConcept(targetGroup.name)
          ? concept(targetGroup.name)
          : undefined) ||
        concept('内容标签')

      let meta: {
        isControlled: boolean
        matchedParent: boolean
        code?: string | null
        ancestryMatchedCode?: string | null
        targetParentCode: string
      } = {
        isControlled: false,
        matchedParent: false,
        targetParentCode
      }

      if (window.electronAPI?.organizeBatch?.inspectControlledTags) {
        try {
          const inspectRes = await window.electronAPI.organizeBatch.inspectControlledTags([
            { tagName: trimmed, targetParentCode }
          ])
          if (inspectRes && inspectRes.success && inspectRes.results?.[0]) {
            const r = inspectRes.results[0]
            meta = {
              isControlled: r.isControlled,
              matchedParent: r.matchedParent,
              code: r.code,
              ancestryMatchedCode: r.ancestryMatchedCode,
              targetParentCode
            }
          }
        } catch (err: any) {
          toast.error(t('受控标签鉴别失败: Omni 服务未就绪或响应超时'))
          return
        }
      }

      newTagMetaMap[activeInputDimId] = {
        ...(newTagMetaMap[activeInputDimId] || {}),
        [trimmed]: meta
      }

      activeNewTags[activeInputDimId] = [
        ...(activeNewTags[activeInputDimId] || []).filter(n => n !== trimmed),
        trimmed
      ]
      setInputVal('')
      setActiveInputDimId(null)
    }

    const fileIds = files
      .map(f => f?.id ?? f?.fileId ?? f?.workspaceFileId ?? f?.path)
      .filter(Boolean)

    type TagItemWithMeta = {
      dimensionId: number
      dimensionName: string
      tagName: string
      dimensionCode?: string
      viaParentCode?: string
      tagCode?: string
    }
    const addTags: TagItemWithMeta[] = []
    const removeTags: TagItemWithMeta[] = []
    const newTags: TagItemWithMeta[] = []
    const processedRemoveKeys = new Set<string>()

    for (const [tagKey, state] of Object.entries(tagStates)) {
      const [dimIdStr, ...tagValueParts] = tagKey.split('::')
      const tagValue = tagValueParts.join('::')
      const dimId = Number(dimIdStr)
      const group =
        fullPresetGroups.find(g => g.id === dimId) || dimensionGroups.find(g => g.id === dimId)
      const dimName = group?.name || '内容标签'
      const dimCode =
        group?.code ||
        CONTROLLED_DIMENSION_ROOT_CODES[dimId] ||
        (dimName && isControlledConcept(dimName) ? concept(dimName) : undefined)
      const matchedTag = (group?.tags || []).find(t => t.tagValue === tagValue)
      const controlledCode = isControlledConcept(tagValue) ? concept(tagValue) : undefined
      const tagCode = controlledCode || (matchedTag as any)?.tagCode || (matchedTag as any)?.code

      if (state === 'add_all') {
        addTags.push({
          dimensionId: dimId,
          dimensionCode: dimCode,
          dimensionName: dimName,
          viaParentCode: dimCode,
          tagCode,
          tagName: tagValue
        })
      } else if (state === 'remove_all') {
        removeTags.push({
          dimensionId: dimId,
          dimensionCode: dimCode,
          dimensionName: dimName,
          viaParentCode: dimCode,
          tagCode,
          tagName: tagValue
        })
        processedRemoveKeys.add(`${dimId}::${tagValue.toLowerCase()}`)
      }
    }

    // 收集通过 X 按钮标记删除的标签
    for (const key of deletedTagKeys) {
      const [dimIdStr, ...tagValueParts] = key.split('::')
      const tagValue = tagValueParts.join('::')
      const dimId = Number(dimIdStr)
      const lowerKey = `${dimId}::${tagValue.toLowerCase()}`
      if (!processedRemoveKeys.has(lowerKey)) {
        processedRemoveKeys.add(lowerKey)
        const group =
          fullPresetGroups.find(g => g.id === dimId) || dimensionGroups.find(g => g.id === dimId)
        const dimName = group?.name || '内容标签'
        const dimCode =
          group?.code ||
          CONTROLLED_DIMENSION_ROOT_CODES[dimId] ||
          (dimName && isControlledConcept(dimName) ? concept(dimName) : undefined)
        const matchedTag = (group?.tags || []).find(t => t.tagValue === tagValue)
        const controlledCode = isControlledConcept(tagValue) ? concept(tagValue) : undefined
        const tagCode = controlledCode || (matchedTag as any)?.tagCode || (matchedTag as any)?.code
        removeTags.push({
          dimensionId: dimId,
          dimensionCode: dimCode,
          dimensionName: dimName,
          viaParentCode: dimCode,
          tagCode,
          tagName: tagValue
        })
      }
    }

    for (const [dimIdStr, names] of Object.entries(activeNewTags)) {
      const dimId = Number(dimIdStr)
      const group =
        fullPresetGroups.find(g => g.id === dimId) || dimensionGroups.find(g => g.id === dimId)
      const dimName = group?.name || '内容标签'
      const dimCode =
        group?.code ||
        CONTROLLED_DIMENSION_ROOT_CODES[dimId] ||
        (dimName && isControlledConcept(dimName) ? concept(dimName) : undefined)
      for (const name of names) {
        if (name && name.trim()) {
          const trimmedName = name.trim()
          const cachedMeta = newTagMetaMap[dimId]?.[trimmedName]
          const isControlledHit =
            cachedMeta?.isControlled && cachedMeta?.matchedParent && cachedMeta?.code
          newTags.push({
            dimensionId: dimId,
            dimensionCode: dimCode,
            dimensionName: dimName,
            viaParentCode: cachedMeta?.ancestryMatchedCode || dimCode,
            tagCode: isControlledHit ? cachedMeta.code! : undefined,
            tagName: trimmedName
          })
        }
      }
    }

    if (addTags.length === 0 && removeTags.length === 0 && newTags.length === 0) {
      toast.info(t('未检测到任何标签变更'))
      return
    }

    try {
      const result = await onSaveTags({
        fileIds,
        addTags,
        removeTags,
        newTags
      })
      // S3 规格 §5.4：保存成功后回显单选互斥的覆盖次数。
      // 计数是跨文件/跨维度汇总，故用「共覆盖」；D-03 已裁定不提供撤销入口，
      // 提示本身即终态反馈（不弹模态框，避免阻塞批量场景）。
      if (result && typeof result.overriddenCount === 'number' && result.overriddenCount > 0) {
        toast.info(t('共覆盖 {count} 处单选冲突标签', { count: result.overriddenCount }))
      }
      await loadFullDimensions()
      setTagStates({})
      setNewTagNames({})
      setNewTagMetaMap({})
      setDeletedTagKeys(new Set())
    } catch (err: any) {
      toast.error(t('保存标签失败: {msg}', { msg: err?.message || String(err) }))
      // 悲观保护：发生异常时绝不重置工作台，保留已录入标签。
      // 依赖 saveBatchTags 在 toast.error 之后重抛（规格 §5.5），否则这里永远不触发。
    }
  }

  // 过滤后的维度与标签列表
  const filteredDimensionGroups = useMemo(() => {
    if (!searchQuery.trim()) return effectiveDimensionGroups
    const q = searchQuery.trim().toLowerCase()
    return effectiveDimensionGroups
      .map(group => {
        const groupMatches = group.name.toLowerCase().includes(q)
        const matchedTags = (group.tags || []).filter(t => t.tagValue.toLowerCase().includes(q))
        const matchedNewTags = (newTagNames[group.id] || []).filter(n =>
          n.toLowerCase().includes(q)
        )

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

  // 拆分为标准分类维度（左列）与泛维度（右列，内容标签固定置于最后）
  const { standardGroups, panGroups } = useMemo(() => {
    const std: DimensionGroup[] = []
    const pan: DimensionGroup[] = []

    for (const group of filteredDimensionGroups) {
      if (isPanDimension(group)) {
        pan.push(group)
      } else {
        std.push(group)
      }
    }

    // 泛维度标签列：将“内容标签”维度（通过 CONTENT_TAGS_CODE）放置到最后
    pan.sort((a, b) => {
      const codeA =
        (a as any).code ||
        (a.id ? CONTROLLED_DIMENSION_ROOT_CODES[a.id] : undefined) ||
        (a.name && isControlledConcept(a.name) ? concept(a.name as any) : undefined)
      const codeB =
        (b as any).code ||
        (b.id ? CONTROLLED_DIMENSION_ROOT_CODES[b.id] : undefined) ||
        (b.name && isControlledConcept(b.name) ? concept(b.name as any) : undefined)
      const isAContent = codeA === CONTENT_TAGS_CODE
      const isBContent = codeB === CONTENT_TAGS_CODE
      if (isAContent && !isBContent) return 1
      if (!isAContent && isBContent) return -1
      return 0
    })

    return { standardGroups: std, panGroups: pan }
  }, [filteredDimensionGroups, isPanDimension])

  // 建立分类维度的树形层级嵌套结构（根维度 -> 子维度分组）
  const hierarchicalGroups = useMemo<HierarchicalDimensionGroup[]>(() => {
    const rootMap = new Map<string, HierarchicalDimensionGroup>()
    const nonRootList: DimensionGroup[] = []

    // 1. 优先提取所有根维度（Level 1 根维度卡片）
    for (const group of standardGroups) {
      if (isRootDimension(group, fullPresetGroups)) {
        const rootKey = resolveDimensionGroupCode(group) || `dim_${group.id}`
        rootMap.set(rootKey, {
          root: group,
          children: [],
          totalTagsCount: (group.tags || []).length,
          hasActiveFileHits: (group.tags || []).some(t => (tagFileCounts[t.tagValue] || 0) > 0)
        })
      } else {
        nonRootList.push(group)
      }
    }

    // 2. 将子维度精确归入其所属根维度卡片
    for (const subGroup of nonRootList) {
      const rootKey = resolveDimensionRootCode(subGroup, fullPresetGroups)
      let parentNode = rootMap.get(rootKey)

      // 若未直接命中，遍历按 code / id 查找
      if (!parentNode) {
        for (const [k, p] of rootMap.entries()) {
          const pCode = resolveDimensionGroupCode(p.root)
          if (
            (pCode && pCode === rootKey) ||
            (p.root as any).rootCode === rootKey ||
            (p.root.id !== undefined && `dim_${p.root.id}` === rootKey)
          ) {
            parentNode = p
            break
          }
        }
      }

      // 如果当前 standardGroups 里由于过滤导致父根卡片没有出现，但该根维度存在于 fullPresetGroups 中
      if (!parentNode && fullPresetGroups.length > 0) {
        const matchedPresetRoot = fullPresetGroups.find(
          p =>
            resolveDimensionGroupCode(p) === rootKey ||
            p.code === rootKey ||
            `dim_${p.id}` === rootKey
        )
        if (matchedPresetRoot && !isPanDimensionGroup(matchedPresetRoot, fullPresetGroups)) {
          const newRootGroup: DimensionGroup = {
            ...matchedPresetRoot,
            tags: []
          }
          parentNode = {
            root: newRootGroup,
            children: [],
            totalTagsCount: 0,
            hasActiveFileHits: false
          }
          rootMap.set(rootKey, parentNode)
        }
      }

      if (parentNode) {
        parentNode.children.push(subGroup)
        parentNode.totalTagsCount += (subGroup.tags || []).length
        if ((subGroup.tags || []).some(t => (tagFileCounts[t.tagValue] || 0) > 0)) {
          parentNode.hasActiveFileHits = true
        }
      } else {
        // 找不到所属根维度的子维度，作为独立卡片兜底，绝不丢失任何维度与标签
        const fallbackKey = resolveDimensionGroupCode(subGroup) || `dim_${subGroup.id}`
        rootMap.set(fallbackKey, {
          root: subGroup,
          children: [],
          totalTagsCount: (subGroup.tags || []).length,
          hasActiveFileHits: (subGroup.tags || []).some(t => (tagFileCounts[t.tagValue] || 0) > 0)
        })
      }
    }

    const result = Array.from(rootMap.values())

    // 3. 根维度排序：文件用途排首位，其余按官方权威 order 或 ID 排序
    result.sort((a, b) => {
      const codeA = resolveDimensionGroupCode(a.root) || ''
      const codeB = resolveDimensionGroupCode(b.root) || ''
      if (codeA === FILE_PURPOSE_CODE) return -1
      if (codeB === FILE_PURPOSE_CODE) return 1
      const orderA = a.root.order || (a.root.metadata as any)?.order || a.root.id
      const orderB = b.root.order || (b.root.metadata as any)?.order || b.root.id
      return orderA - orderB
    })

    // 4. 每个根维度内部的子维度排序
    result.forEach(item => {
      item.children.sort((a, b) => {
        const orderA = a.order || (a.metadata as any)?.order || a.id
        const orderB = b.order || (b.metadata as any)?.order || b.id
        return orderA - orderB
      })
    })

    return result
  }, [standardGroups, fullPresetGroups, tagFileCounts])

  // 展开/折叠状态管理
  const [expandedRootKeys, setExpandedRootKeys] = useState<Set<string>>(() => new Set())
  const [hasInitializedExpand, setHasInitializedExpand] = useState(false)

  // 默认展开：有命中的根维度卡片 + 首个核心根维度（如文件用途）
  useEffect(() => {
    if (hierarchicalGroups.length > 0 && !hasInitializedExpand) {
      const initialKeys = new Set<string>()
      hierarchicalGroups.forEach((item, idx) => {
        const key = item.root.code || `dim_${item.root.id}`
        if (item.hasActiveFileHits || idx === 0 || item.root.code === FILE_PURPOSE_CODE) {
          initialKeys.add(key)
        }
      })
      setExpandedRootKeys(initialKeys)
      setHasInitializedExpand(true)
    }
  }, [hierarchicalGroups, hasInitializedExpand])

  // 切换单个根维度的展开/折叠
  const handleToggleExpandRoot = useCallback((rootKey: string) => {
    setExpandedRootKeys(prev => {
      const next = new Set(prev)
      if (next.has(rootKey)) {
        next.delete(rootKey)
      } else {
        next.add(rootKey)
      }
      return next
    })
  }, [])

  // 全部展开
  const handleExpandAll = useCallback(() => {
    const allKeys = new Set<string>()
    hierarchicalGroups.forEach(item => {
      const key = item.root.code || `dim_${item.root.id}`
      allKeys.add(key)
    })
    setExpandedRootKeys(allKeys)
  }, [hierarchicalGroups])

  // 全部折叠
  const handleCollapseAll = useCallback(() => {
    setExpandedRootKeys(new Set())
  }, [])

  // 判断某个卡片当前是否展开（搜索时自动展开所有包含结果的卡片）
  const isCardExpanded = useCallback(
    (rootKey: string) => {
      if (searchQuery.trim()) {
        return true
      }
      return expandedRootKeys.has(rootKey)
    },
    [searchQuery, expandedRootKeys]
  )

  // 开启新建标签输入
  const handleStartAddNewTag = useCallback((dimId: number) => {
    setActiveInputDimId(dimId)
    setInputVal('')
  }, [])

  // 取消新建标签输入
  const handleCancelAddNewTag = useCallback(() => {
    setInputVal('')
    setActiveInputDimId(null)
  }, [])

  const hasInspected = Boolean(inspectedFileItem)

  return (
    <div
      data-testid="batch-tag-view"
      className="relative flex-1 flex flex-col overflow-hidden bg-background"
    >
      {/* 1. 选中文件聚焦联动状态条 (Inspector Banner - 浮动显示，脱离文档流，杜绝页面回流与重绘) */}
      {inspectedFileItem && (
        <div className="absolute top-3 left-4 right-4 z-30 px-4 py-3 bg-card/95 dark:bg-card/90 backdrop-blur-md border border-primary/30 rounded-2xl shadow-xl shadow-black/10 flex flex-col gap-2 text-xs transition-all duration-200 animate-in fade-in slide-in-from-top-2 will-change-transform pointer-events-auto">
          {/* 上部：文件信息、标签统计与取消聚焦操作 */}
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              <div className="w-6 h-6 rounded-lg bg-primary/20 text-primary flex items-center justify-center shrink-0">
                <MaterialIcon icon="visibility" className="text-sm" />
              </div>
              <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                <span className="text-muted-foreground shrink-0">{t('当前选中文件:')}</span>
                <span
                  className="font-bold text-foreground truncate max-w-[240px] sm:max-w-[360px]"
                  title={inspectedFileItem.smartName || inspectedFileItem.name}
                >
                  {inspectedFileItem.smartName || inspectedFileItem.name}
                </span>
              </div>
              <Badge
                variant="outline"
                className="bg-background/80 text-primary border-primary/30 text-[10px] h-4.5 px-1.5 shrink-0 font-mono font-medium"
              >
                {t('共 {count} 个标签', { count: inspectedFileTagsWithDimension.length })}
              </Badge>
            </div>

            {onClearInspectedFile && (
              <Button
                size="sm"
                variant="destructive"
                onClick={onClearInspectedFile}
                className="h-7 px-3 text-xs font-semibold rounded-xl shadow-xs shrink-0 gap-1.5 cursor-pointer"
                title={t('清除选定文件高亮')}
              >
                <MaterialIcon icon="close" className="text-sm shrink-0" />
                <span>{t('取消聚焦')}</span>
              </Button>
            )}
          </div>

          {/* 下部：当前选中文件的所有标签（带归属维度名称），支持集中查看 */}
          <div className="flex flex-wrap items-center gap-1.5 max-h-24 overflow-y-auto pr-1">
            {inspectedFileTagsWithDimension.length === 0 ? (
              <span className="text-[11px] text-muted-foreground/80 italic">
                {t('该文件暂无归属标签')}
              </span>
            ) : (
              inspectedFileTagsWithDimension.map((item, idx) => (
                <div
                  key={`${item.dimensionName}::${item.tagValue}::${idx}`}
                  className="inline-flex items-center rounded-lg border border-primary/30 bg-background/90 text-xs overflow-hidden shadow-2xs select-none"
                  title={t('归属维度: {dim}', { dim: item.dimensionName })}
                >
                  {/* 所属维度名称 */}
                  <span className="px-1.5 py-0.5 bg-primary/15 text-primary text-[10px] font-semibold border-r border-primary/20 shrink-0">
                    {item.dimensionName}
                  </span>
                  {/* 标签值 */}
                  <span className="px-2 py-0.5 font-medium text-foreground text-xs">
                    {item.tagValue}
                  </span>
                </div>
              ))
            )}
          </div>
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
              className="h-7.5 px-2.5 text-xs text-muted-foreground hover:text-foreground rounded-xl shrink-0 gap-1 cursor-pointer"
              title={t('重置所有未保存的标签变更')}
            >
              <MaterialIcon icon="restart_alt" className="text-xs" />
              <span>{t('重置')}</span>
            </Button>
          )}
        </div>
      </div>

      {/* 3. 两列独立滚动与支持调整宽度的 SplitPane (左列：分类维度；右列：泛维度标签) */}
      <div className="flex-1 overflow-hidden min-h-0 relative">
        {isLoadingPresets && effectiveDimensionGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-3 h-full">
            <MaterialIcon icon="sync" className="text-3xl text-primary animate-spin" />
            <p className="text-xs font-semibold text-foreground/80">{t('正在加载维度与标签...')}</p>
          </div>
        ) : filteredDimensionGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-2 h-full">
            <MaterialIcon icon="search_off" className="text-3xl text-muted-foreground/50" />
            <p className="text-xs font-semibold text-foreground/80">
              {t('未找到匹配的维度或标签')}
            </p>
            <p className="text-[11px] text-muted-foreground">{t('请尝试更换搜索词或新建标签')}</p>
          </div>
        ) : (
          <SplitPane
            direction="horizontal"
            storageKey="batch-tag-view-split"
            className="h-full w-full"
            sections={[
              {
                id: 'standard-dimensions',
                type: 'flex' as const,
                defaultSize: 1,
                minSize: 260,
                content: (
                  <div className="flex flex-col h-full w-full overflow-hidden bg-background">
                    {/* 左列固定置顶标题栏 */}
                    <div className="px-4 py-2.5 border-b border-border/60 bg-muted/25 shrink-0 flex items-center justify-between gap-2 select-none">
                      <div className="flex items-center gap-2">
                        <MaterialIcon icon="category" className="text-sm text-primary" />
                        <span className="text-xs font-bold text-foreground">{t('分类维度')}</span>
                        <Badge
                          variant="outline"
                          className="text-[10px] h-4.5 px-1.5 font-normal text-muted-foreground bg-background"
                        >
                          {t('{count} 个根分类', { count: hierarchicalGroups.length })}
                        </Badge>
                      </div>

                      {/* 快捷展开/折叠全部 */}
                      {hierarchicalGroups.length > 0 && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={handleExpandAll}
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded-lg hover:bg-muted/80 transition-colors cursor-pointer"
                            title={t('展开所有分类维度')}
                          >
                            <MaterialIcon icon="unfold_more" className="text-xs" />
                            <span>{t('全部展开')}</span>
                          </button>
                          <span className="text-muted-foreground/30 text-xs">|</span>
                          <button
                            type="button"
                            onClick={handleCollapseAll}
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded-lg hover:bg-muted/80 transition-colors cursor-pointer"
                            title={t('折叠所有分类维度')}
                          >
                            <MaterialIcon icon="unfold_less" className="text-xs" />
                            <span>{t('全部折叠')}</span>
                          </button>
                        </div>
                      )}
                    </div>
                    {/* 左列独立滚动区域 */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
                      {hierarchicalGroups.length === 0 ? (
                        <div className="p-8 text-center text-xs text-muted-foreground bg-muted/10 rounded-2xl border border-dashed border-border/50">
                          {t('无匹配的分类维度')}
                        </div>
                      ) : (
                        hierarchicalGroups.map(item => {
                          const rootKey = item.root.code || `dim_${item.root.id}`
                          return (
                            <HierarchicalDimensionCard
                              key={rootKey}
                              item={item}
                              isExpanded={isCardExpanded(rootKey)}
                              onToggleExpand={handleToggleExpandRoot}
                              tagStates={tagStates}
                              tagFileCounts={tagFileCounts}
                              totalFilesCount={totalFilesCount}
                              inspectedTagSet={inspectedTagSet}
                              hasInspected={hasInspected}
                              onToggleTag={handleToggleTag}
                              onBatchSetTags={handleBatchSetDimensionTags}
                            />
                          )
                        })
                      )}
                    </div>
                  </div>
                )
              },
              {
                id: 'pan-dimensions',
                type: 'flex' as const,
                defaultSize: 1,
                minSize: 260,
                content: (
                  <div className="flex flex-col h-full w-full overflow-hidden bg-background">
                    {/* 右列固定置顶标题栏 */}
                    <div className="px-4 py-2.5 border-b border-border/60 bg-muted/25 shrink-0 flex items-center justify-between gap-2 select-none">
                      <div className="flex items-center gap-2">
                        <MaterialIcon icon="label" className="text-sm text-primary" />
                        <span className="text-xs font-bold text-foreground">{t('泛维度标签')}</span>
                        <Badge
                          variant="outline"
                          className="text-[10px] h-4.5 px-1.5 font-normal text-muted-foreground bg-background"
                        >
                          {panGroups.length}
                        </Badge>
                      </div>
                    </div>
                    {/* 右列独立滚动区域 */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                      {panGroups.length === 0 ? (
                        <div className="p-8 text-center text-xs text-muted-foreground bg-muted/10 rounded-2xl border border-dashed border-border/50">
                          {t('无匹配的泛维度标签')}
                        </div>
                      ) : (
                        panGroups.map(group => (
                          <DimensionGroupCard
                            key={group.id}
                            group={group}
                            isPan={true}
                            groupNewTags={newTagNames[group.id] || []}
                            isInputActive={activeInputDimId === group.id}
                            isInspecting={isInspectingTag}
                            inputVal={inputVal}
                            tagStates={tagStates}
                            tagFileCounts={tagFileCounts}
                            totalFilesCount={totalFilesCount}
                            inspectedTagSet={inspectedTagSet}
                            hasInspected={hasInspected}
                            onToggleTag={handleToggleTag}
                            onDeleteExistingTag={handleDeleteExistingTag}
                            onBatchSetTags={handleBatchSetDimensionTags}
                            onStartAddNewTag={handleStartAddNewTag}
                            onCancelAddNewTag={handleCancelAddNewTag}
                            onInputChange={setInputVal}
                            onSubmitAddNewTag={handleAddNewTag}
                            onRemoveNewTag={handleRemoveNewTag}
                          />
                        ))
                      )}
                    </div>
                  </div>
                )
              }
            ]}
          />
        )}
      </div>

      {/* 隐藏的保存打标触发器，供外部顶栏调用 */}
      <button
        id="btn-save-tags-trigger"
        type="button"
        className="hidden"
        onClick={handleSave}
        disabled={isSaving}
      />
    </div>
  )
}
