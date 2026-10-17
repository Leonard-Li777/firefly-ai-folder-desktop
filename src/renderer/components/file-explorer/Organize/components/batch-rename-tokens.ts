import { DimensionGroup } from '@firefly/types'
import {
  concept,
  CONTROLLED_DIMENSION_ROOT_CODES,
  isControlledConcept,
  getCanonicalConceptName
} from '@firefly/shared'
import { FILE_DIMENSION_DATA } from '@app/electron/config/file-dimension-source'

export interface TokenItem {
  label: string
  value: string
  desc: string
  pillClass?: string
  isCommon?: boolean
  parentName?: string
  level?: number // 0 = 根级, 1 = 二级细分, 2 = 三级细分
  groupLabel?: string
}

export interface DimensionTreeNode {
  id: number | string
  name: string
  token: TokenItem
  level: number
  children: DimensionTreeNode[]
}

export interface TokenCategory {
  key: string
  category: string
  badgeColor: string
  tokens: TokenItem[]
  tree?: DimensionTreeNode[]
}

/**
 * 构造全量属性标签资源池分类列表（动态函数，避免静态对象多语言刷新失效）
 */
export function getBatchRenameTokenCategories(
  dimensionGroups: DimensionGroup[] = [],
  t: (key: string, params?: any) => string
): TokenCategory[] {
  // ─── 1. 分类维度：从系统权威事实源动态组装全量受控维度体系 ──────────────
  const { dimensionTokens, dimensionTree } = buildDimensionSystem(dimensionGroups, t)

  // ─── 各独立功能大类 ──────────────────────────────────────────
  const coreCategory: TokenCategory = {
    key: 'core',
    category: t('核心与作者'),
    badgeColor: 'text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/20',
    tokens: [
      {
        label: t('智能文件名'),
        value: '{SMART_NAME}',
        desc: t('AI 解析提取的纯净核心命名'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('原始文件名'),
        value: '{ORIG_NAME}',
        desc: t('文件在磁盘上的原始文件名（不含扩展名）'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('作者'),
        value: '{AUTHOR}',
        desc: t('内容作者标签 (如 [{AUTHOR}])'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('文件扩展名'),
        value: '{EXT}',
        desc: t('文件后缀扩展名（自动带点 .ext）'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('质量评分'),
        value: '{QUALITY_SCORE}',
        desc: t('AI 质量分值 (如 [Q{QUALITY_SCORE}])'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('文件大小'),
        value: '{SIZE}',
        desc: t('友好文件大小 (如 12MB)'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('语言代码'),
        value: '{LANG}',
        desc: t('文档语言代码 (如 zh-CN, en)'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: false
      }
    ]
  }

  const datetimeCategory: TokenCategory = {
    key: 'datetime',
    category: t('时间日期'),
    badgeColor: 'text-purple-600 dark:text-purple-400 bg-purple-500/10 border-purple-500/20',
    tokens: [
      {
        label: t('修改日期(年-月-日)'),
        value: '{MOD:YYYY-MM-DD}',
        desc: t('文件最后修改日期 (如 2024-03-15)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: true
      },
      {
        label: t('创建日期(年-月-日)'),
        value: '{CRE:YYYY-MM-DD}',
        desc: t('文件创建日期 (如 2024-01-01)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: true
      },
      {
        label: t('修改时间(年月日时分)'),
        value: '{MOD:YYYYMMDD_HHmm}',
        desc: t('精确修改时间戳 (如 20240315_1430)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: true
      },
      {
        label: t('修改年份(YYYY)'),
        value: '{MOD:YYYY}',
        desc: t('四位修改年份 (如 2024)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: true
      },
      {
        label: t('创建年份(YYYY)'),
        value: '{CRE:YYYY}',
        desc: t('四位创建年份 (如 2024)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: false
      }
    ]
  }

  const dimensionCategory: TokenCategory = {
    key: 'dimension',
    category: t('分类维度'),
    badgeColor: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    tokens: dimensionTokens,
    tree: dimensionTree
  }

  const metaCategory: TokenCategory = {
    key: 'meta',
    category: t('元数据'),
    badgeColor: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20',
    tokens: [
      {
        label: t('分辨率'),
        value: `{META:${t('分辨率')}}`,
        desc: t('图片/视频分辨率 (如 1920x1080)'),
        pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20',
        isCommon: true
      },
      {
        label: t('时长'),
        value: `{META:${t('时长')}}`,
        desc: t('音视频时长 (如 03分25秒)'),
        pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20',
        isCommon: true
      },
      {
        label: t('页数'),
        value: `{META:${t('页数')}}`,
        desc: t('文档总页数 (如 15P)'),
        pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20',
        isCommon: true
      },
      {
        label: t('编码格式'),
        value: `{META:${t('编码')}}`,
        desc: t('媒体编码格式 (如 H264, AAC)'),
        pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20',
        isCommon: true
      }
    ]
  }

  const seqCategory: TokenCategory = {
    key: 'seq',
    category: t('自增序号'),
    badgeColor: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    tokens: [
      {
        label: t('两位序号(01)'),
        value: '{SEQ:01}',
        desc: t('两位补零自增序号 (01, 02...)'),
        pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20',
        isCommon: true
      },
      {
        label: t('三位序号(001)'),
        value: '{SEQ:001}',
        desc: t('三位补零自增序号 (001, 002...)'),
        pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20',
        isCommon: true
      },
      {
        label: t('四位序号(0001)'),
        value: '{SEQ:0001}',
        desc: t('四位补零自增序号 (0001, 0002...)'),
        pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20',
        isCommon: true
      }
    ]
  }

  return [
    coreCategory,
    datetimeCategory,
    dimensionCategory,
    metaCategory,
    seqCategory
  ]
}

/**
 * 提取常用标签并按分类排布（核心与作者、时间日期、分类维度、元数据、自增序号）
 */
export function getCommonCategoriesPartitioned(
  allCategories: TokenCategory[],
  t: (key: string, params?: any) => string
): TokenCategory[] {
  return allCategories
    .map(cat => ({
      key: `common-${cat.key}`,
      category: `${t('常用')} · ${cat.category}`,
      badgeColor: cat.badgeColor,
      tokens: cat.tokens.filter(t => t.isCommon)
    }))
    .filter(cat => cat.tokens.length > 0)
}

// 1. 核心高频常用维度受控代码白名单（强类型单一事实源，基于 concept('...') 获取）
const COMMON_DIMENSION_CODES = new Set<string>([
  concept('文件类型'),
  concept('文件用途'),
  concept('文件来源'),
  concept('作者'),
  concept('图片细分'),
  concept('视频细分'),
  concept('音频细分'),
  concept('文档细分'),
  concept('文本细分'),
  concept('压缩包细分'),
  concept('安全等级'),
  concept('处理状态'),
  concept('学科领域'),
  concept('作品来源'),
  concept('证照细分'),
  concept('摄影照片细分')
])

// 2. 权威 7 大受控根维度受控代码集合（Genesis V1 创世基线规范）
const ROOT_DIMENSION_CODES = new Set<string>([
  concept('文件类型'),
  concept('文件用途'),
  concept('文件来源'),
  concept('作者'),
  concept('文件质量'),
  concept('内容标签'),
  concept('内容分级')
])

interface RawDimensionEntry {
  rawName: string
  rawDesc?: string
  level: number
  code?: string
}

/**
 * 解析任意维度对象或标识符的规范受控代码
 */
function resolveConceptCode(dim: { id?: number | string; code?: string; name?: string } | string | undefined): string | undefined {
  if (!dim) return undefined
  if (typeof dim === 'string') {
    if (dim.startsWith('builtin.') || dim.startsWith('omw.') || dim.startsWith('hownet.')) {
      return dim
    }
    return isControlledConcept(dim) ? concept(dim) : undefined
  }
  if (dim.code) return dim.code
  const numId = Number(dim.id)
  if (!isNaN(numId) && CONTROLLED_DIMENSION_ROOT_CODES[numId]) {
    return CONTROLLED_DIMENSION_ROOT_CODES[numId]
  }
  if (dim.name) {
    if (dim.name.startsWith('builtin.') || dim.name.startsWith('omw.') || dim.name.startsWith('hownet.')) {
      return dim.name
    }
    if (isControlledConcept(dim.name)) {
      return concept(dim.name)
    }
  }
  return undefined
}

/**
 * 敏感内容维度受控判定：
 * 严格基于强类型受控代码比对，严禁使用自然语言中文或 t()
 */
const SENSITIVE_CONTENT_CODE = concept('敏感内容')
const isSensitiveDimIdentifier = (identifier?: string): boolean => {
  if (!identifier) return false
  const c = resolveConceptCode(identifier)
  return c === SENSITIVE_CONTENT_CODE
}

/**
 * 从系统权威事实源 (file-dimension-source / ConfigDbManager) 动态构建受控维度体系
 * 1. 内部处理 100% 基于未翻译的母语规范名与受控代码进行拓扑判定，严禁在分支与集合判定中使用 t()；
 * 2. 根节点严格依从 Genesis V1 创世 7 大受控根维度；
 * 3. 二级与三级维度基于 triggerConditions 声明的 parentDimension 原生关系自顶向下组装；
 * 4. 严格受控过滤：敏感内容仅显示到 2 级维度，彻底不显示其下的 3、4 级细分子维度（如色情细分、涉政细分等）；
 * 5. 其它所有内置维度（包括二级作品来源、三级证照细分等）与自定义维度全部完整显示；
 * 6. 输出展示阶段（Egress）统一使用 t() 进行本地化。
 */
export function buildDimensionSystem(
  dimensionGroups: DimensionGroup[] = [],
  t: (key: string, params?: any) => string
): { dimensionTokens: TokenItem[]; dimensionTree: DimensionTreeNode[] } {
  // 1. 加载权威事实源
  const rawDims = FILE_DIMENSION_DATA?.file_dimensions || []

  // 2. 构建 parentName -> children 拓扑映射（纯母语规范名键）
  const childrenMap = new Map<string, RawDimensionEntry[]>()
  const primaryParentMap = new Map<string, string>()

  for (const d of rawDims) {
    const rawName = d.name
    const conditions = d.triggerConditions || []

    // 过滤规则：任何父级为敏感内容的子维度一律跳过（在未翻译的母语规范名层面比对）
    const validParents = conditions
      .map(c => c.parentDimension)
      .filter((p): p is string => Boolean(p && !isSensitiveDimIdentifier(p)))

    // 若该维度只在敏感内容下触发（如色情细分、涉政细分、血腥细分、违规细分），彻底不予显示
    if (conditions.length > 0 && validParents.length === 0) {
      continue
    }

    if (validParents.length > 0) {
      // 敏感内容：严格只作为「内容分级」之下的二级维度显示，不作为三级维度在媒体细分下重复挂载
      if (isSensitiveDimIdentifier(rawName)) {
        const rootParent = '内容分级'
        const list = childrenMap.get(rootParent) || []
        if (!list.some(item => item.rawName === rawName)) {
          list.push({
            rawName,
            rawDesc: d.description,
            level: 2
          })
        }
        childrenMap.set(rootParent, list)
        primaryParentMap.set(rawName, rootParent)
        continue
      }

      // 规范层级匹配：若维度定义为 level 2，且父级中包含根维度，优先挂载于根维度（如「作品来源」作为二级维度归入「文件类型」）
      let chosenParents = validParents
      if (d.level === 2) {
        const rootParents = validParents.filter(p => {
          const pCode = resolveConceptCode(p)
          return Boolean(pCode && ROOT_DIMENSION_CODES.has(pCode))
        })
        if (rootParents.length > 0) {
          chosenParents = rootParents
        }
      }

      primaryParentMap.set(rawName, chosenParents[0])
      for (const parent of chosenParents) {
        const list = childrenMap.get(parent) || []
        if (!list.some(item => item.rawName === rawName)) {
          list.push({
            rawName,
            rawDesc: d.description,
            level: d.level
          })
        }
        childrenMap.set(parent, list)
      }
    }
  }

  // 3. 合并外部传入的自定义维度（来自工作区或用户定义）
  for (const g of dimensionGroups || []) {
    const rawName = g.name
    const rawParent = (g as any).parentDimension || (g as any).parentDimensionName
    if (rawParent && !isSensitiveDimIdentifier(rawParent)) {
      const list = childrenMap.get(rawParent) || []
      if (!list.some(item => item.rawName === rawName)) {
        list.push({
          rawName,
          rawDesc: undefined,
          level: (g.level ?? 1) + 1
        })
      }
      childrenMap.set(rawParent, list)
      if (!primaryParentMap.has(rawName)) {
        primaryParentMap.set(rawName, rawParent)
      }
    }
  }

  // 4. 递归拼装原生维度树（在展示输出阶段应用 t() 翻译）
  const allTokensMap = new Map<string, TokenItem>()

  const createToken = (
    rawName: string,
    rawDesc: string | undefined,
    level: number,
    rawParentName?: string
  ): TokenItem => {
    const localizedName = t(rawName)
    const tokenVal = `{TAG:${localizedName}}`
    const existing = allTokensMap.get(tokenVal)
    if (existing) return existing

    const desc = rawDesc ? t(rawDesc) : t('匹配该文件的「{name}」维度标签', { name: localizedName })
    const parentName = rawParentName
      ? t(rawParentName)
      : primaryParentMap.has(rawName)
        ? t(primaryParentMap.get(rawName)!)
        : undefined

    const tokenDimCode = resolveConceptCode(rawName)
    const isCommon = Boolean(tokenDimCode && COMMON_DIMENSION_CODES.has(tokenDimCode))

    const item: TokenItem = {
      label: localizedName,
      value: tokenVal,
      desc,
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon,
      parentName,
      level,
      groupLabel: t('分类维度')
    }
    allTokensMap.set(tokenVal, item)
    return item
  }

  const assembleNode = (
    rawName: string,
    rawDesc: string | undefined,
    currentLevel: number,
    rawParentName?: string,
    branchPath: string = ''
  ): DimensionTreeNode => {
    const localizedName = t(rawName)
    const token = createToken(rawName, rawDesc, currentLevel, rawParentName)
    const currentPath = `${branchPath}/${rawName}`

    // 核心门禁：敏感内容只显示到 2 级维度，不显示其下的 3、4 级细分子维度
    if (isSensitiveDimIdentifier(rawName)) {
      return {
        id: `${rawName}-${rawParentName || 'root'}-${currentLevel}`,
        name: localizedName,
        token,
        level: currentLevel,
        children: []
      }
    }

    const rawChildren = childrenMap.get(rawName) || []
    const childrenNodes: DimensionTreeNode[] = []
    for (const child of rawChildren) {
      if (branchPath.includes(child.rawName)) continue // 防回环保护
      childrenNodes.push(
        assembleNode(child.rawName, child.rawDesc, currentLevel + 1, rawName, currentPath)
      )
    }

    return {
      id: `${rawName}-${rawParentName || 'root'}-${currentLevel}`,
      name: localizedName,
      token,
      level: currentLevel,
      children: childrenNodes
    }
  }

  // 5. 权威 7 大受控根维度为顶层树干（强类型受控概念对齐）
  const ROOT_CANONICAL_DEFINITIONS = [
    { code: concept('文件类型'), rawName: '文件类型', rawDesc: '文件的基础格式分类 (如文本/图片/视频/音频等)' },
    { code: concept('文件用途'), rawName: '文件用途', rawDesc: '文件的核心使用场景 (如工作文档/学习资料/游戏娱乐等)' },
    { code: concept('文件来源'), rawName: '文件来源', rawDesc: '文件的原始获取途径 (如本地创建/网络下载/设备导入等)' },
    { code: concept('作者'), rawName: '作者', rawDesc: '文件的创建者或贡献者' },
    { code: concept('文件质量'), rawName: '文件质量', rawDesc: '文件的品质与质量评分 (如优质/良好/一般等)' },
    { code: concept('内容标签'), rawName: '内容标签', rawDesc: '开放式语义与主题内容标签' },
    { code: concept('内容分级'), rawName: '内容分级', rawDesc: '合规安全审查与年龄受众分级' }
  ]

  const dimensionTree: DimensionTreeNode[] = []
  for (const rootDef of ROOT_CANONICAL_DEFINITIONS) {
    dimensionTree.push(assembleNode(rootDef.rawName, rootDef.rawDesc, 0))
  }

  // 外部传入且未绑定父级的自定义维度追加为根节点
  const rootRawNameSet = new Set(ROOT_CANONICAL_DEFINITIONS.map(r => r.rawName))
  for (const g of dimensionGroups || []) {
    const rawName = g.name
    if (!rootRawNameSet.has(rawName) && !primaryParentMap.has(rawName)) {
      rootRawNameSet.add(rawName)
      dimensionTree.push(assembleNode(rawName, undefined, 0))
    }
  }

  return {
    dimensionTokens: Array.from(allTokensMap.values()),
    dimensionTree
  }
}

/**
 * 兼容旧接口函数，委托给 buildDimensionSystem
 */
export function buildRawDimensionTree(
  dimensionTokens: TokenItem[],
  t: (key: string, params?: any) => string
): DimensionTreeNode[] {
  const { dimensionTree } = buildDimensionSystem([], t)
  return dimensionTree
}
