import { DimensionGroup, DimensionTag } from '@firefly/types'
import {
  isPanDimension as checkIsPanDimension,
  concept,
  resolveSubdimensionRoot,
  resolveControlledParent,
  getParentDimensionCodeOfTag,
  TOP_ROOT_CODES,
  CONTROLLED_SUBDIMENSION_PARENTS_GENERATED,
  CONTROLLED_DIMENSION_ROOT_CODES,
  isControlledConcept,
  classifyDimensionMutexScope
} from '@firefly/shared'

export const isSensitiveDimension = (g: DimensionGroup): boolean => {
  if (!g) return false
  const sensitiveConceptCode = concept('敏感内容')
  const ratingConceptCode = concept('内容分级')
  const eroticConceptCode = concept('色情分级')

  const code =
    (g as any).code ||
    (g.id ? CONTROLLED_DIMENSION_ROOT_CODES[Number(g.id)] : undefined) ||
    (isControlledConcept(g.name) ? concept(g.name) : undefined)
  const rootCode = (g as any).rootCode

  if (
    code === sensitiveConceptCode ||
    code === ratingConceptCode ||
    code === eroticConceptCode ||
    rootCode === sensitiveConceptCode ||
    rootCode === ratingConceptCode
  ) {
    return true
  }

  // 自底向上回溯受控父维度链，彻底消除硬编码魔法数字
  let curCode: string | undefined = code
  const visited = new Set<string>()
  while (curCode && !visited.has(curCode)) {
    visited.add(curCode)
    if (
      curCode === sensitiveConceptCode ||
      curCode === ratingConceptCode ||
      curCode === eroticConceptCode
    ) {
      return true
    }
    curCode =
      CONTROLLED_SUBDIMENSION_PARENTS_GENERATED[curCode]?.parentCode ||
      getParentDimensionCodeOfTag(curCode) ||
      resolveControlledParent(curCode)
  }

  return false
}

/**
 * 基于受控概念与单一事实源（SSOT）的动态受控常数
 * 严格使用 concept('...') 与 @firefly/shared，严禁任何手写自然语言字符串或私造伪受控代码
 */
export const FILE_TYPE_CODE = concept('文件类型')
export const FILE_PURPOSE_CODE = concept('文件用途')
export const SENSITIVE_CONTENT_CODE = concept('敏感内容')
export const PORNOGRAPHY_SUBGENRES_CODE = concept('色情细分')
export const CONTENT_TAGS_CODE = concept('内容标签')
export const SECURITY_LEVEL_CODE = concept('安全等级')

/**
 * 动态提取维度组的规范受控代码（支持 code / id / name 动态解析，100% 动态，无局部硬编码）
 */
export const resolveDimensionGroupCode = (group?: DimensionGroup | null): string | undefined => {
  if (!group) return undefined
  if (group.code) return group.code
  if (group.id !== undefined && CONTROLLED_DIMENSION_ROOT_CODES[Number(group.id)]) {
    return CONTROLLED_DIMENSION_ROOT_CODES[Number(group.id)]
  }
  if (group.name && isControlledConcept(group.name)) {
    try {
      return concept(group.name as any)
    } catch {}
  }
  return undefined
}

/**
 * 依据 triggerConditions 与 AOT 单亲受控拓扑动态提取维度的直接父维度受控代码列表
 * 严格遵守 SSOT：只考虑 triggerConditions 与 AOT 父子关系，绝不考虑 tagImplications 延伸的关系！
 */
export const getTriggerConditionParentCodes = (
  group: DimensionGroup,
  presetGroups?: DimensionGroup[]
): string[] => {
  if (!group) return []

  // 1. 优先读取维度对象自身的 triggerConditions 或 parentCodes
  const tcs =
    (group as any).triggerConditions ||
    (group.metadata as any)?.triggerConditions ||
    (group.meta as any)?.triggerConditions
  if (Array.isArray(tcs) && tcs.length > 0) {
    const list: string[] = []
    for (const tc of tcs) {
      if (tc.parentDimension) {
        const p = String(tc.parentDimension).trim()
        try {
          const cCode = concept(p as any)
          if (cCode) {
            list.push(cCode)
            continue
          }
        } catch {}
        if (p.startsWith('builtin.') || p.startsWith('omw.') || p.startsWith('hownet.')) {
          list.push(p)
        }
      }
    }
    if (list.length > 0) return list
  }

  const pCodes = (group as any).parentCodes || (group.metadata as any)?.parentCodes
  if (Array.isArray(pCodes) && pCodes.length > 0) {
    return pCodes.filter(Boolean)
  }

  // 2. 从预设维度池 presetGroups 中动态读取其预置 triggerConditions / parentCodes
  if (presetGroups && presetGroups.length > 0) {
    const gCode = resolveDimensionGroupCode(group)
    const gId = group.id !== undefined ? Number(group.id) : undefined
    const gName = group.name ? group.name.trim() : undefined

    const matched = presetGroups.find(p => {
      if (gId !== undefined && p.id !== undefined && Number(p.id) === gId) return true
      if (gCode && p.code && p.code === gCode) return true
      if (gName && p.name && p.name.trim() === gName) return true
      return false
    })

    if (matched) {
      const matchTcs =
        (matched as any).triggerConditions ||
        (matched.metadata as any)?.triggerConditions ||
        (matched.meta as any)?.triggerConditions
      if (Array.isArray(matchTcs) && matchTcs.length > 0) {
        const list: string[] = []
        for (const tc of matchTcs) {
          if (tc.parentDimension) {
            const p = String(tc.parentDimension).trim()
            try {
              const cCode = concept(p as any)
              if (cCode) {
                list.push(cCode)
                continue
              }
            } catch {}
            if (p.startsWith('builtin.') || p.startsWith('omw.') || p.startsWith('hownet.')) {
              list.push(p)
            }
          }
        }
        if (list.length > 0) return list
      }
      const matchPCodes = (matched as any).parentCodes || (matched.metadata as any)?.parentCodes
      if (Array.isArray(matchPCodes) && matchPCodes.length > 0) {
        return matchPCodes.filter(Boolean)
      }
    }
  }

  // 3. 基于 @firefly/shared 导出的 AOT 单亲拓扑表 CONTROLLED_SUBDIMENSION_PARENTS_GENERATED 动态求解直接父级
  const code = resolveDimensionGroupCode(group)
  if (code && CONTROLLED_SUBDIMENSION_PARENTS_GENERATED[code]?.parentCode) {
    return [CONTROLLED_SUBDIMENSION_PARENTS_GENERATED[code].parentCode]
  }

  return []
}

/**
 * 动态解析分类维度所属的顶级根大类代码
 * 100% 基于单一事实源（AOT 拓扑回溯器 resolveSubdimensionRoot 与 triggerConditions）动态求解
 * 严禁任何硬编码静态字典
 */
export const resolveDimensionRootCode = (
  group: DimensionGroup,
  presetGroups?: DimensionGroup[]
): string => {
  const code = resolveDimensionGroupCode(group)

  // 1. 若当前维度直接声明了 rootCode（且不等于自身 code），优先使用
  const explicitRootCode = (group as any).rootCode || (group.metadata as any)?.rootCode
  if (explicitRootCode && explicitRootCode !== code && TOP_ROOT_CODES.has(explicitRootCode)) {
    return explicitRootCode
  }

  // 2. 利用 @firefly/shared 导出的 AOT 递归溯根器 resolveSubdimensionRoot 求解一级根
  if (code) {
    const subRoot = resolveSubdimensionRoot(code)
    if (subRoot) {
      // 敏感内容 / 色情分级保护
      if (subRoot === PORNOGRAPHY_SUBGENRES_CODE) {
        return SENSITIVE_CONTENT_CODE
      }
      // 若回溯得到的是顶级根（如文件用途、文件来源、文件质量等）
      if (TOP_ROOT_CODES.has(subRoot) && subRoot !== FILE_TYPE_CODE) {
        return subRoot
      }
    }
  }

  // 3. 读取 triggerConditions 求解直接父级并向上回溯
  const parents = getTriggerConditionParentCodes(group, presetGroups)
  if (parents.length > 0) {
    const firstParent = parents[0]
    // 若直接父维度为色情细分，向上追溯至敏感内容
    if (firstParent === PORNOGRAPHY_SUBGENRES_CODE) {
      return SENSITIVE_CONTENT_CODE
    }
    // 若父维度是文件类型（左侧已排除该大类），则该细分维度自身（如图片细分）作为一级大类展示
    if (firstParent === FILE_TYPE_CODE) {
      return code || `dim_${group.id}`
    }
    // 递归追溯该父级所属的一级根维度
    const ancestorRoot = resolveSubdimensionRoot(firstParent)
    if (ancestorRoot && TOP_ROOT_CODES.has(ancestorRoot) && ancestorRoot !== FILE_TYPE_CODE) {
      return ancestorRoot
    }
    return firstParent
  }

  return code || `dim_${group.id}`
}

/**
 * 判断是否为根大类（在左列分类维度中作为顶级卡片展示）
 * 规则：
 * 1. 本身为全系统顶级受控根维度 TOP_ROOT_CODES（且不是已排除的文件类型）；
 * 2. 或无父维度（parents 为空，且 resolveDimensionRootCode 返回自身）；
 * 3. 或其直接父维度是已被排除的元分类（如文件类型，则如图片细分等自身提升为一级根卡片）。
 */
export const isRootDimension = (
  group: DimensionGroup,
  presetGroups?: DimensionGroup[]
): boolean => {
  const code = resolveDimensionGroupCode(group)
  if (code && TOP_ROOT_CODES.has(code) && code !== FILE_TYPE_CODE) {
    return true
  }

  const parents = getTriggerConditionParentCodes(group, presetGroups)
  if (parents.length === 0) {
    const rootCode = resolveDimensionRootCode(group, presetGroups)
    return rootCode === code || rootCode === `dim_${group.id}`
  }

  // 若其父维度是已过滤排除的元分类文件类型，该维度自身就是顶级根卡片
  if (parents.includes(FILE_TYPE_CODE)) {
    return true
  }

  return false
}

/**
 * 判断维度是否为泛维度
 * 严格遵循单一事实源原则：仅通过策略元数据 flag.isPanDimension === true 动态判定
 * 严禁任何硬编码维度 ID、名称或受控 code
 */
export const isPanDimensionGroup = (
  group: DimensionGroup,
  presetGroups?: DimensionGroup[]
): boolean => {
  if (!group) return false

  // 1. 标准 checkIsPanDimension (来自 @firefly/shared，读取 metadata.flag.isPanDimension)
  if (checkIsPanDimension(group)) return true

  // 2. 结构容错：读取 metadata.flag / meta.flag / metadata / meta / 顶层 isPanDimension 属性
  const metaFlag = (group.metadata as any)?.flag || (group.meta as any)?.flag
  if (metaFlag?.isPanDimension === true) return true
  if ((group.metadata as any)?.isPanDimension === true) return true
  if ((group.meta as any)?.isPanDimension === true) return true
  if ((group as any).isPanDimension === true) return true

  // 3. 动态对照：若传入的 group 缺失 metadata，尝试从由 ConfigDbManager 预加载的全量维度池中获取其策略
  if (presetGroups && presetGroups.length > 0) {
    const gCode = resolveDimensionGroupCode(group)
    const gId = group.id !== undefined ? Number(group.id) : undefined
    const gName = group.name ? group.name.trim() : undefined

    const matched = presetGroups.find(p => {
      if (gId !== undefined && p.id !== undefined && Number(p.id) === gId) return true
      if (gCode && p.code && p.code === gCode) return true
      if (gName && p.name && p.name.trim() === gName) return true
      return false
    })

    if (matched) {
      if (checkIsPanDimension(matched)) return true
      const mFlag = (matched.metadata as any)?.flag || (matched.meta as any)?.flag
      if (mFlag?.isPanDimension === true) return true
      if ((matched.metadata as any)?.isPanDimension === true) return true
      if ((matched.meta as any)?.isPanDimension === true) return true
      if ((matched as any).isPanDimension === true) return true
    }
  }

  return false
}

export const isExtensionTag = (tagName: string) => {
  if (!tagName) return false
  const trimmed = tagName.trim()
  return trimmed.startsWith('.')
}

/**
 * S3（规格 §5.2 / §5.3）：该维度是否需要按「单选」做三态互斥。
 *
 * 与写库侧 `resolveBatchTagScopeMode` **同源**——都走共享分类器
 * `classifyDimensionMutexScope`（S0 产物，`@firefly/shared`）：
 *   - `single` / `unknown` ⇒ 互斥（unknown 取保守分支，ADR-0034 默认单选）
 *   - `multi` / `rule`    ⇒ 不收拢
 *
 * 边界（规格 §5.2 明确）：这里的互斥**只改 UI 选中态**。已入库的旧标签不会被
 * 置回 initial 这一动作删除，真正的库里收敛靠 S2 写库侧的覆盖删除。
 */
export const isMutexSingleGroup = (group?: DimensionGroup | null): boolean => {
  const scope = classifyDimensionMutexScope(group?.code)
  return scope === 'single' || scope === 'unknown'
}

/**
 * 计算标签胶囊的 React key（渲染身份键，必须全局唯一）
 *
 * 受控分类树是 **DAG 而非严格树**：同一个 code / 同名标签会挂在多个父级下
 * （如 builtin.chinese 同时挂在 文档/电子书/视频/音频 的语言细分下），其 `codePath` 各不相同，
 * 服务端按父路径各留一条是**既有设计**（前端 dimension-tree-utils 提升聚合阶段依赖全部分支
 * 收集 `codePaths`，保障跨分支文件视野零丢失），因此**严禁在此去重丢弃分支条目**。
 *
 * 但本组件既有的标签身份键 `${dimensionId}::${tagValue}` 无法区分这些分支条目，
 * 直接用作 React key 会触发「Encountered two children with the same key」并造成重复胶囊；
 * 故渲染 key 必须纳入 `codePath`（跨分支唯一）—— 仅在旧载荷缺 codePath/code 时退回数组下标兜底。
 *
 * 注意：三态状态与批量操作的身份键仍是 tag 级的 `${dimensionId}::${tagValue}`
 * （批量打标按标签名生效，与分支路径无关），本函数仅用于 React 渲染 key。
 */
export const getTagPillKey = (dimensionId: number, tag: DimensionTag, index: number): string =>
  `${dimensionId}::${tag.tagValue}::${tag.codePath || tag.code || index}`
