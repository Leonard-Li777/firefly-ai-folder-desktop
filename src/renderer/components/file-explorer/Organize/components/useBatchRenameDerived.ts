import { useMemo } from 'react'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { BatchRenamePreviewItem, DimensionGroup, FileInfoForAI } from '@firefly/types'
import { isExtensionTriggerTagName } from '@firefly/shared'
import { getBatchRenameTokenCategories, type TokenCategory } from './batch-rename-tokens'

export interface RenamePresetTemplate {
  name: string
  template: string
  category: string
  icon: string
  description: string
}

export type TokenCategoryType = 'name' | 'date' | 'tag' | 'meta' | 'seq' | 'literal'
export type RenameFilterTab = 'all' | 'changed' | 'unchanged' | 'error'

export interface BatchRenamePreviewStats {
  total: number
  changed: number
  unchanged: number
  errors: number
  changeRate: number
}

// 限制更名效果实时对照列表最大展示数量（避免海量文件造成前端 DOM 渲染卡顿）
export const MAX_PREVIEW_ITEMS = 200

/**
 * 常用/精选命名模板预置列表（与后端 NamingDSLEngine 多语言对齐）
 */
export const getPresetNamingTemplates = (): RenamePresetTemplate[] => [
  {
    name: `${t('文件类型')} + ${t('智能文件名')} + ${t('日期')}`,
    template: `[{TAG:${t('文件类型')}}]{SMART_NAME}_{MOD:YYYY-MM-DD}`,
    category: t('常用'),
    icon: 'auto_awesome',
    description: t('文件类型前置，后接智能文件名与修改日期，标准通用命名')
  },
  {
    name: `${t('修改日期')} + ${t('智能文件名')}`,
    template: '{MOD:YYYY-MM-DD}_{SMART_NAME}',
    category: t('时间线'),
    icon: 'calendar_today',
    description: t('日期前缀，便于在文件管理器中按时间正序排列')
  },
  {
    name: `${t('题材维度')} + ${t('智能文件名')}`,
    template: `[{TAG:${t('题材')}}]_{SMART_NAME}`,
    category: t('分类'),
    icon: 'category',
    description: t('题材标签前置，强化主题分类属性')
  },
  {
    name: `${t('作者')} + ${t('智能文件名')}`,
    template: '[{AUTHOR}]_{SMART_NAME}',
    category: t('归档'),
    icon: 'person',
    description: t('作者或创作者前置，适合书籍、文献与作品集')
  },
  {
    name: `${t('智能文件名')} + ${t('分辨率')} + ${t('序号')}`,
    template: `{SMART_NAME}_<{META:${t('分辨率')}}>_({SEQ:01})`,
    category: t('多模态'),
    icon: 'aspect_ratio',
    description: t('多模态媒体专用命名，附带分辨率规格与两位序号')
  },
  {
    name: `${t('创建日期')} + ${t('原文件名')} + ${t('序号')}`,
    template: '{CRE:YYYY-MM-DD}_{ORIG_NAME}_({SEQ:001})',
    category: t('保留原名'),
    icon: 'history_edu',
    description: t('保留原文件名并附加创建日期与三位递增序号')
  },
  {
    name: `${t('智能文件名')} + ${t('质量分')}`,
    template: '{SMART_NAME}_[Q{QUALITY_SCORE}]',
    category: t('质量'),
    icon: 'verified',
    description: t('标记 AI 质量评分，快速区分优选文件')
  },
  {
    name: t('全维度属性组合'),
    template: `[{TAG:${t('题材')}}]_{SMART_NAME}_{MOD:YYYY-MM-DD}_({SEQ:01})`,
    category: t('复合'),
    icon: 'dashboard_customize',
    description: t('题材、名称、日期与序号全维度综合规范')
  }
]

/**
 * 判定某个 Token 是否已存在于当前模板中（用于在中栏过滤掉已选标签，防止重复点击插入；保证模板中绝不出现两个相同的标签）
 */
export function isTokenInTemplate(tokenValue: string, currentTemplate: string): boolean {
  if (!currentTemplate || !tokenValue) return false

  const tpl = currentTemplate.toLowerCase()
  const cleanVal = tokenValue.replace(/^[[(<]+|[\])>]+$/g, '').trim()

  // 1. 维度标签 {TAG:xxx}
  if (cleanVal.startsWith('{TAG:')) {
    const dimName = cleanVal.slice(5, -1).trim().toLowerCase()
    return tpl.includes(`{tag:${dimName}}`) || tpl.includes(`tag:${dimName}`)
  }

  // DSL 元数据槽位规范名 (用于模板存在性校验与别名映射)
  const META_SLOT_NAMES = {
    RESOLUTION: t('分辨率'),
    DURATION: t('时长'),
    PAGES: t('页数'),
    CODEC: t('编码'),
    CODEC_FORMAT: t('编码格式')
  } as const

  // 2. 多模态元数据 {META:xxx}
  if (cleanVal.startsWith('{META:')) {
    const metaKey = cleanVal.slice(6, -1).trim().toLowerCase()
    // locale-invariant-ok: DSL 占位符模板匹配
    if (metaKey === META_SLOT_NAMES.RESOLUTION || metaKey === 'resolution' || metaKey === 'res') {
      return (
        tpl.includes('{meta:分辨率') ||
        tpl.includes('{meta:resolution') ||
        tpl.includes('{meta:res')
      )
    }
    // locale-invariant-ok: DSL 占位符模板匹配
    if (metaKey === META_SLOT_NAMES.DURATION || metaKey === 'duration' || metaKey === 'dur') {
      return (
        tpl.includes('{meta:时长') || tpl.includes('{meta:duration') || tpl.includes('{meta:dur')
      )
    }
    // locale-invariant-ok: DSL 占位符模板匹配
    if (metaKey === META_SLOT_NAMES.PAGES || metaKey === 'pages' || metaKey === 'page') {
      return tpl.includes('{meta:页数') || tpl.includes('{meta:pages') || tpl.includes('{meta:page')
    }
    // locale-invariant-ok: DSL 占位符模板匹配
    if (
      metaKey === META_SLOT_NAMES.CODEC ||
      metaKey === 'codec' ||
      metaKey === META_SLOT_NAMES.CODEC_FORMAT
    ) {
      return (
        tpl.includes('{meta:编码') || tpl.includes('{meta:codec') || tpl.includes('{meta:编码格式')
      )
    }
    return tpl.includes(`{meta:${metaKey}`)
  }

  // 3. 时间日期 {MOD:...} 与 {CRE:...}
  if (cleanVal.startsWith('{MOD:')) {
    return tpl.includes('{mod:')
  }
  if (cleanVal.startsWith('{CRE:')) {
    return tpl.includes('{cre:')
  }

  // 4. 序号 {SEQ:...}
  if (cleanVal.startsWith('{SEQ:') || cleanVal.startsWith('{SEQ')) {
    return tpl.includes('{seq:') || tpl.includes('{seq}')
  }

  // 5. 质量评分 {QUALITY_SCORE}
  if (cleanVal.includes('QUALITY_SCORE')) {
    return tpl.includes('{quality_score}')
  }

  // 6. 基础变量精确匹配（{SMART_NAME}, {ORIG_NAME}, {EXT}, {SIZE}, {AUTHOR}, {LANG} 等）
  const lowerVal = cleanVal.toLowerCase()
  return tpl.includes(lowerVal)
}

/**
 * 剥离 DSL 模板中包裹在各变量外围的类型修饰符（如 []、()、<>）
 */
export function stripTypeDelimiters(tpl: string): string {
  if (!tpl) return ''
  let res = tpl
  // 1. 剥离包裹在维度与作者/质量分/语言外围的 []
  res = res.replace(/\[\s*(\{TAG:[^}]+\})\s*\]/gi, '$1')
  res = res.replace(/\[\s*(\{AUTHOR\})\s*\]/gi, '$1')
  res = res.replace(/\[\s*Q?(\{QUALITY_SCORE\})\s*\]/gi, '$1')
  res = res.replace(/\[\s*(\{LANG\})\s*\]/gi, '$1')
  // 2. 剥离包裹在序号外围的 ()
  res = res.replace(/\(\s*(\{SEQ(?::[^}]+)?\})\s*\)/gi, '$1')
  // 3. 剥离包裹在元数据外围的 <>
  res = res.replace(/<\s*(\{META:[^}]+\})\s*>/gi, '$1')
  // 4. 清理任何孤立的空括号
  res = res.replace(/\[\s*\]/g, '')
  res = res.replace(/\(\s*\)/g, '')
  res = res.replace(/<\s*>/g, '')
  // 5. 优雅折叠多余下划线
  res = res.replace(/__+/g, '_').replace(/^\s*[_-]|[-_]\s*$/g, '')
  return res
}

/**
 * 为 DSL 模板中未包裹的变量添加规范的类型修饰符（标签 []、序号 ()、元数据 <>）
 */
export function applyTypeDelimiters(tpl: string): string {
  if (!tpl) return ''
  let res = stripTypeDelimiters(tpl)
  res = res.replace(/\{TAG:([^}]+)\}/g, '[{TAG:$1}]')
  res = res.replace(/\{AUTHOR\}/g, '[{AUTHOR}]')
  res = res.replace(/\{QUALITY_SCORE\}/g, '[Q{QUALITY_SCORE}]')
  res = res.replace(/\{SEQ(:[^}]+)?\}/g, '({SEQ$1})')
  res = res.replace(/\{META:([^}]+)\}/g, '<{META:$1}>')
  return res
}

/**
 * 根据所选 DSL Token 类型与语义，动态计算其最佳包裹形态与前置连接符
 */
export function getSmartTokenInsertion(
  tokenValue: string,
  currentTemplate: string,
  useDelimiters = true
): string {
  let mappedToken = tokenValue

  if (useDelimiters) {
    // 1. 维度与作者、质量评分标签默认包覆方括号前置修饰符
    if (tokenValue.startsWith('{TAG:') && !tokenValue.startsWith('[{TAG:')) {
      mappedToken = `[${tokenValue}]`
    } else if (tokenValue === '{AUTHOR}') {
      mappedToken = `[{AUTHOR}]`
    } else if (tokenValue === '{QUALITY_SCORE}') {
      mappedToken = `[Q{QUALITY_SCORE}]`
    } else if (tokenValue.startsWith('{SEQ') && !tokenValue.startsWith('({SEQ')) {
      // 2. 序号自动包裹圆括号 ()
      mappedToken = `(${tokenValue})`
    } else if (tokenValue.startsWith('{META:') && !tokenValue.startsWith('<{META:')) {
      // 3. 多模态元数据自动包裹尖括号 <>
      mappedToken = `<${tokenValue}>`
    }
  } else {
    mappedToken = stripTypeDelimiters(tokenValue)
  }

  if (!currentTemplate || !currentTemplate.trim()) {
    return mappedToken
  }

  // 4. 扩展名 Token 特殊处理：动态映射为前置点号 `.{EXT}`
  if (tokenValue === '{EXT}') {
    if (currentTemplate.endsWith('.')) {
      return `${currentTemplate}{EXT}`
    }
    return `${currentTemplate}.{EXT}`
  }

  // 5. 检查当前 template 末尾是否已有连接符或括号
  const endsWithSeparator = /[\s_.([<-]$/.test(currentTemplate)
  if (endsWithSeparator) {
    return `${currentTemplate}${mappedToken}`
  }

  // 6. 默认采用下划线 `_` 动态连接
  return `${currentTemplate}_${mappedToken}`
}

export function getTokenCategory(tokenStr: string): TokenCategoryType {
  const tStr = String(tokenStr || '').trim()
  if (
    tStr.includes('SMART_NAME') ||
    tStr.includes('ORIG_NAME') ||
    tStr.includes('EXT') ||
    tStr.includes('SIZE')
  ) {
    return 'name'
  }
  if (
    tStr.includes('MOD:') ||
    tStr.includes('CRE:') ||
    tStr.includes('MOD') ||
    tStr.includes('CRE')
  ) {
    return 'date'
  }
  if (tStr.includes('TAG:') || tStr.includes('AUTHOR') || tStr.includes('LANG')) {
    return 'tag'
  }
  if (tStr.includes('META:')) {
    return 'meta'
  }
  if (tStr.includes('SEQ') || tStr.includes('QUALITY_SCORE')) {
    return 'seq'
  }
  return 'literal'
}

export function getChipStyle(tokenStr: string): string {
  const cat = getTokenCategory(tokenStr)
  switch (cat) {
    case 'name':
      return 'border-blue-500/50 bg-blue-500/15 text-blue-800 dark:text-blue-200 ring-1 ring-blue-500/25 hover:bg-blue-500/25 hover:border-blue-500/70 font-semibold shadow-xs'
    case 'date':
      return 'border-purple-500/50 bg-purple-500/15 text-purple-800 dark:text-purple-200 ring-1 ring-purple-500/25 hover:bg-purple-500/25 hover:border-purple-500/70 font-semibold shadow-xs'
    case 'tag':
      return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-500/25 hover:bg-emerald-500/25 hover:border-emerald-500/70 font-semibold shadow-xs'
    case 'meta':
      return 'border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-200 ring-1 ring-amber-500/25 hover:bg-amber-500/25 hover:border-amber-500/70 font-semibold shadow-xs'
    case 'seq':
      return 'border-cyan-500/50 bg-cyan-500/15 text-cyan-800 dark:text-cyan-200 ring-1 ring-cyan-500/25 hover:bg-cyan-500/25 hover:border-cyan-500/70 font-semibold shadow-xs'
    default:
      return 'bg-muted/70 text-foreground/90 border border-border/70 hover:bg-muted/90 font-mono font-medium shadow-2xs'
  }
}

export function getSegmentColorClass(type: string): string {
  switch (type) {
    case 'name':
      return 'text-blue-600 dark:text-blue-400 font-semibold'
    case 'date':
      return 'text-purple-600 dark:text-purple-400 font-semibold'
    case 'tag':
      return 'text-emerald-600 dark:text-emerald-400 font-semibold'
    case 'meta':
      return 'text-amber-600 dark:text-amber-400 font-semibold'
    case 'seq':
      return 'text-cyan-600 dark:text-cyan-400 font-semibold'
    default:
      return 'text-muted-foreground/80 font-normal'
  }
}

/**
 * 计算单个文件在当前模板与底层数据中具有有效值的标签/属性数量（用于更名实时对照列表由高到低排序）
 */
export function getItemTagScore(item: BatchRenamePreviewItem, file?: FileInfoForAI): number {
  let matchedTokensCount = 0
  let totalTagsCount = 0

  // 1. 优先统计当前模板中实际命中并渲染出有效值的「标签/多模态/作者/日期」片段数量
  if (item.segments && item.segments.length > 0) {
    for (const seg of item.segments) {
      if (seg.type === 'tag' || seg.type === 'meta' || seg.type === 'date') {
        if (seg.text && seg.text.trim()) {
          matchedTokensCount++
        }
      }
    }
  }

  // 2. 统计该文件底层数据库中拥有的有效业务标签总数（排除扩展名标签）
  if (file) {
    if (Array.isArray(file.dimensionTags)) {
      totalTagsCount += file.dimensionTags.filter(
        (tagItem: any) =>
          tagItem &&
          (tagItem.tag || tagItem.tagValue || tagItem.name) &&
          !isExtensionTriggerTagName(tagItem.tag || tagItem.tagValue || tagItem.name)
      ).length
    }
    if (Array.isArray(file.tags)) {
      totalTagsCount += file.tags.filter(
        tagVal => tagVal && typeof tagVal === 'string' && tagVal.trim()
      ).length
    }
    if (file.author && String(file.author).trim()) {
      totalTagsCount += 1
    }
    if (
      file.metadata &&
      typeof file.metadata === 'object' &&
      Object.keys(file.metadata).length > 0
    ) {
      totalTagsCount += 1
    }
  }

  // 模板内实际匹配生效的标签权重大（x100），加上底层有效标签总数，确保有值标签越多的文件排在越前
  return matchedTokensCount * 100 + totalTagsCount
}

/**
 * 判定文件是否相较于智能文件名发生了变动（以智能文件名作为判定基准）
 */
export function isItemChanged(item: BatchRenamePreviewItem): boolean {
  if (item.hasError) return false
  const cleanSmartName = (item.rawSmartName || '').replace(/\.[a-zA-Z0-9]{1,10}$/i, '').trim()
  if (!cleanSmartName) {
    return item.currentName !== item.newName
  }
  const extMatch = item.currentName.match(/\.[a-zA-Z0-9]{1,10}$/i)
  const ext = extMatch ? extMatch[0] : ''
  const smartWithExt = `${cleanSmartName}${ext}`

  return item.newName !== smartWithExt && item.newName !== cleanSmartName
}

export interface UseBatchRenameDerivedParams {
  files: any[]
  dimensionGroups: DimensionGroup[]
  template: string
  templateSearch: string
  filterTab: RenameFilterTab
  previewSearch: string
  previewList: BatchRenamePreviewItem[]
}

export interface UseBatchRenameDerivedResult {
  tokenCategories: TokenCategory[]
  analyzedFiles: any[]
  parsedChips: string[]
  filteredPresets: RenamePresetTemplate[]
  filteredPreviewList: BatchRenamePreviewItem[]
  displayedPreviewList: BatchRenamePreviewItem[]
  previewStats: BatchRenamePreviewStats
}

/**
 * BatchRenameView 衍生数据 Hook：抽离预设模板过滤、Token 分类、文件映射、预览排序与统计计算，
 * 完整保留原 useMemo 语义与依赖数组。
 */
export function useBatchRenameDerived({
  files,
  dimensionGroups,
  template,
  templateSearch,
  filterTab,
  previewSearch,
  previewList
}: UseBatchRenameDerivedParams): UseBatchRenameDerivedResult {
  const { t: scopeT, activeLanguage } = useVoerkaI18n(i18nScope)

  // 快捷插值 Token 分类列表（全量接入 t() 多语言体系与层级体系）
  const tokenCategories: TokenCategory[] = useMemo(() => {
    return getBatchRenameTokenCategories(dimensionGroups, scopeT)
  }, [dimensionGroups, activeLanguage])

  // 仅针对已分析文件进行批量更名预览与操作
  const analyzedFiles: any[] = useMemo(() => {
    return (files || []).filter(f => (f as any).is_analyzed !== 0 && f.isAnalyzed !== false)
  }, [files])

  // 将 template 拆解为可视化胶囊数组 (Chip Pills)
  const parsedChips: string[] = useMemo(() => {
    if (!template) return []
    const regex = /(\[[^\]]+\]|\([^)]+\)|<[^>]+>|\{[^}]+\}|[^\s_{}[\]()<>-]+|[\s_-])/g
    const matches = template.match(regex) || []
    return matches.filter(m => m.trim().length > 0 || m === ' ')
  }, [template])

  // 过滤后的推荐模板（随当前语言切换同步刷新）
  const presetList: RenamePresetTemplate[] = useMemo(
    () => getPresetNamingTemplates(),
    [activeLanguage]
  )
  const filteredPresets: RenamePresetTemplate[] = useMemo(() => {
    if (!templateSearch.trim()) return presetList
    const kw = templateSearch.toLowerCase()
    return presetList.filter(
      p =>
        p.name.toLowerCase().includes(kw) ||
        p.template.toLowerCase().includes(kw) ||
        p.description.toLowerCase().includes(kw)
    )
  }, [presetList, templateSearch])

  const fileMap: Map<any, FileInfoForAI> = useMemo(() => {
    const map = new Map<any, FileInfoForAI>()
    for (const f of analyzedFiles || []) {
      if (f.id !== undefined) map.set(f.id, f)
      if (f.path) map.set(f.path, f)
    }
    return map
  }, [analyzedFiles])

  // 过滤后的预览列表（核心规则：按照标签有值的个数由高到低降序排序）
  const filteredPreviewList: BatchRenamePreviewItem[] = useMemo(() => {
    let list = [...previewList]
    if (filterTab === 'changed') {
      list = list.filter(item => isItemChanged(item))
    } else if (filterTab === 'unchanged') {
      list = list.filter(item => !isItemChanged(item) && !item.hasError)
    } else if (filterTab === 'error') {
      list = list.filter(item => item.hasError)
    }

    if (previewSearch.trim()) {
      const kw = previewSearch.toLowerCase()
      list = list.filter(
        item =>
          item.currentName.toLowerCase().includes(kw) ||
          item.newName.toLowerCase().includes(kw) ||
          (item.rawSmartName && item.rawSmartName.toLowerCase().includes(kw))
      )
    }

    // 核心规则：按照标签有值的个数排序，由高到低 (降序)
    list.sort((a, b) => {
      const fileA = fileMap.get(a.fileId) || fileMap.get(a.path)
      const fileB = fileMap.get(b.fileId) || fileMap.get(b.path)

      const scoreA = getItemTagScore(a, fileA)
      const scoreB = getItemTagScore(b, fileB)

      if (scoreB !== scoreA) {
        return scoreB - scoreA // 降序：高 -> 低
      }
      return a.currentName.localeCompare(b.currentName, 'zh-CN')
    })

    return list
  }, [previewList, filterTab, previewSearch, fileMap])

  // 截取前 200 项用于实际列表渲染
  const displayedPreviewList: BatchRenamePreviewItem[] = useMemo(() => {
    return filteredPreviewList.slice(0, MAX_PREVIEW_ITEMS)
  }, [filteredPreviewList])

  // 统计信息（以智能文件名为基准判定）
  const previewStats: BatchRenamePreviewStats = useMemo(() => {
    const total = previewList.length
    const changed = previewList.filter(i => isItemChanged(i)).length
    const unchanged = previewList.filter(i => !isItemChanged(i) && !i.hasError).length
    const errors = previewList.filter(i => i.hasError).length
    const changeRate = total > 0 ? Math.round((changed / total) * 100) : 0
    return { total, changed, unchanged, errors, changeRate }
  }, [previewList])

  return {
    tokenCategories,
    analyzedFiles,
    parsedChips,
    filteredPresets,
    filteredPreviewList,
    displayedPreviewList,
    previewStats
  }
}
