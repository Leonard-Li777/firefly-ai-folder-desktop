import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Badge } from '../../../ui/badge'
import { toast } from '../../../common/Toast'
import { SplitPane } from '../../../common/SplitPane'
import { BatchRenamePreviewItem, DimensionGroup, FileInfoForAI } from '@firefly/types'
import { isExtensionTriggerTagName } from '@firefly/shared'

/**
 * 常用/精选命名模板预置列表（与后端 NamingDSLEngine 多语言对齐）
 */
const getPresetNamingTemplates = () => [
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

interface BatchRenameViewProps {
  files: any[]
  dimensionGroups?: DimensionGroup[]
  onExecuteRename: (template: string) => Promise<void>
  isExecuting?: boolean
}

type ViewMode = 'card' | 'table'
type FilterTab = 'all' | 'changed' | 'unchanged' | 'error'

/**
 * 判定某个 Token 是否已存在于当前模板中（用于在中栏过滤掉已选标签，防止重复点击插入；保证模板中绝不出现两个相同的标签）
 */
function isTokenInTemplate(tokenValue: string, currentTemplate: string): boolean {
  if (!currentTemplate || !tokenValue) return false

  const tpl = currentTemplate.toLowerCase()
  const cleanVal = tokenValue.replace(/^[\[\(\<]+|[\]\)\>]+$/g, '').trim()

  // 1. 维度标签 {TAG:xxx}
  if (cleanVal.startsWith('{TAG:')) {
    const dimName = cleanVal.slice(5, -1).trim().toLowerCase()
    return (
      tpl.includes(`{tag:${dimName}}`) ||
      tpl.includes(`{tag:${t(dimName).toLowerCase()}}`) ||
      tpl.includes(`tag:${dimName}`)
    )
  }

  // 2. 多模态元数据 {META:xxx}
  if (cleanVal.startsWith('{META:')) {
    const metaKey = cleanVal.slice(6, -1).trim().toLowerCase()
    if (
      metaKey === '分辨率' ||
      metaKey === 'resolution' ||
      metaKey === 'res' ||
      metaKey === t('分辨率').toLowerCase()
    ) {
      return (
        tpl.includes('{meta:分辨率') ||
        tpl.includes('{meta:resolution') ||
        tpl.includes('{meta:res') ||
        tpl.includes(`{meta:${t('分辨率').toLowerCase()}`)
      )
    }
    if (
      metaKey === '时长' ||
      metaKey === 'duration' ||
      metaKey === 'dur' ||
      metaKey === t('时长').toLowerCase()
    ) {
      return (
        tpl.includes('{meta:时长') ||
        tpl.includes('{meta:duration') ||
        tpl.includes('{meta:dur') ||
        tpl.includes(`{meta:${t('时长').toLowerCase()}`)
      )
    }
    if (
      metaKey === '页数' ||
      metaKey === 'pages' ||
      metaKey === 'page' ||
      metaKey === t('页数').toLowerCase()
    ) {
      return (
        tpl.includes('{meta:页数') ||
        tpl.includes('{meta:pages') ||
        tpl.includes('{meta:page') ||
        tpl.includes(`{meta:${t('页数').toLowerCase()}`)
      )
    }
    if (
      metaKey === '编码' ||
      metaKey === 'codec' ||
      metaKey === '编码格式' ||
      metaKey === t('编码').toLowerCase() ||
      metaKey === t('编码格式').toLowerCase()
    ) {
      return (
        tpl.includes('{meta:编码') ||
        tpl.includes('{meta:codec') ||
        tpl.includes(`{meta:${t('编码').toLowerCase()}`)
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
  res = res.replace(/__+/g, '_').replace(/^\s*[_\-]|[\-_]\s*$/g, '')
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
function getSmartTokenInsertion(
  tokenValue: string,
  currentTemplate: string,
  useDelimiters: boolean = true
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
  const endsWithSeparator = /[\s_\-\.\[\(\<]$/.test(currentTemplate)
  if (endsWithSeparator) {
    return `${currentTemplate}${mappedToken}`
  }

  // 6. 默认采用下划线 `_` 动态连接
  return `${currentTemplate}_${mappedToken}`
}

/**
 * 插入位置指示竖线组件
 */
const InsertionIndicator: React.FC = () => (
  <div className="w-1.5 h-8 bg-primary rounded-full shadow-md shadow-primary/40 -mx-1 z-20 animate-in fade-in zoom-in-75 duration-150 transition-all flex items-center justify-center pointer-events-none">
    <div className="w-0.5 h-5 bg-primary-foreground/90 rounded-full" />
  </div>
)

export const BatchRenameView: React.FC<BatchRenameViewProps> = ({
  files,
  dimensionGroups = [],
  onExecuteRename,
  isExecuting = false
}) => {
  const [template, setTemplate] = useState<string>(`[{TAG:${t('文件类型')}}]{SMART_NAME}_{MOD:YYYY-MM-DD}`)
  const [previewList, setPreviewList] = useState<BatchRenamePreviewItem[]>([])
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)

  // 是否添加类型包裹符（[]、()、<>等），默认开启 (true)
  const [useTypeDelimiters, setUseTypeDelimiters] = useState<boolean>(true)

  // 切换类型包裹符状态
  const handleToggleTypeDelimiters = useCallback((enabled: boolean) => {
    setUseTypeDelimiters(enabled)
    setTemplate(prev => {
      if (!prev) return prev
      return enabled ? applyTypeDelimiters(prev) : stripTypeDelimiters(prev)
    })
  }, [])

  // 胶囊拖拽排序状态
  const [draggedChipIndex, setDraggedChipIndex] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<{ index: number; position: 'before' | 'after' } | null>(null)

  // 左栏模板搜索
  const [templateSearch, setTemplateSearch] = useState('')

  // 中栏属性标签搜索与分类筛选，默认选中「常用」
  const [tokenSearch, setTokenSearch] = useState('')
  const [selectedTokenCategory, setSelectedTokenCategory] = useState<string>(t('常用'))

  // 右栏视图设置与筛选
  const [rightViewMode, setRightViewMode] = useState<ViewMode>('card')
  const [filterTab, setFilterTab] = useState<FilterTab>('all')
  const [previewSearch, setPreviewSearch] = useState('')

  // 快捷插值 Token 分类列表（全量接入 t() 多语言体系）
  const tokenCategories = useMemo(() => {
    const dimTokens = (dimensionGroups || []).map(g => {
      const dimLabel = t(g.name)
      return {
        label: dimLabel,
        value: `{TAG:${dimLabel}}`,
        desc: t('匹配该文件的「{name}」维度标签', { name: dimLabel }),
        pillClass:
          'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
      }
    })

    return [
      {
        category: t('常用'),
        badgeColor: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20',
        tokens: [
          {
            label: t('智能文件名'),
            value: '{SMART_NAME}',
            desc: t('AI 解析提取的纯净核心命名'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          },
          {
            label: t('作者/创作者'),
            value: '{AUTHOR}',
            desc: t('内容作者标签 (如 [{AUTHOR}])'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          },
          {
            label: t('质量评分'),
            value: '{QUALITY_SCORE}',
            desc: t('AI 质量分值 (如 [Q{QUALITY_SCORE}])'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          },
          {
            label: t('修改日期(年-月-日)'),
            value: '{MOD:YYYY-MM-DD}',
            desc: t('文件最后修改日期 (如 2024-03-15)'),
            pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20'
          },
          {
            label: t('文件类型'),
            value: `{TAG:${t('文件类型')}}`,
            desc: t('匹配该文件的「文件类型」维度标签'),
            pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
          },
          {
            label: t('文件用途'),
            value: `{TAG:${t('文件用途')}}`,
            desc: t('匹配该文件的「文件用途」维度标签'),
            pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
          },
          {
            label: t('地理位置'),
            value: `{TAG:${t('地理位置')}}`,
            desc: t('匹配该文件的「地理位置」维度标签'),
            pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
          },
          {
            label: t('压缩包细分'),
            value: `{TAG:${t('压缩包细分')}}`,
            desc: t('匹配该文件的未加密压缩包/加密压缩包等属性'),
            pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
          },
          {
            label: t('画质等级'),
            value: `{TAG:${t('画质等级')}}`,
            desc: t('匹配该文件的「画质等级」维度标签'),
            pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
          },
          {
            label: t('题材'),
            value: `{TAG:${t('题材')}}`,
            desc: t('匹配该文件的「题材」维度标签'),
            pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
          },
          {
            label: t('四位序号(0001)'),
            value: '{SEQ:0001}',
            desc: t('四位补零自增序号 (0001, 0002...)'),
            pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20'
          },
          {
            label: t('时长'),
            value: `{META:${t('时长')}}`,
            desc: t('音视频时长 (如 03分25秒)'),
            pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
          }
        ]
      },
      {
        category: t('核心名称'),
        badgeColor: 'text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/20',
        tokens: [
          {
            label: t('智能文件名'),
            value: '{SMART_NAME}',
            desc: t('AI 解析提取的纯净核心命名'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          },
          {
            label: t('原始文件名'),
            value: '{ORIG_NAME}',
            desc: t('文件在磁盘上的原始文件名（不含扩展名）'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          },
          {
            label: t('作者/创作者'),
            value: '{AUTHOR}',
            desc: t('内容作者标签 (如 [{AUTHOR}])'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          },
          {
            label: t('语言代码'),
            value: '{LANG}',
            desc: t('文档语言代码 (如 zh-CN, en)'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          },
          {
            label: t('质量评分'),
            value: '{QUALITY_SCORE}',
            desc: t('AI 质量分值 (如 [Q{QUALITY_SCORE}])'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          },
          {
            label: t('文件扩展名'),
            value: '{EXT}',
            desc: t('文件后缀扩展名（自动带点 .ext）'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          },
          {
            label: t('文件大小'),
            value: '{SIZE}',
            desc: t('友好文件大小 (如 12MB)'),
            pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20'
          }
        ]
      },
      {
        category: t('时间日期'),
        badgeColor: 'text-purple-600 dark:text-purple-400 bg-purple-500/10 border-purple-500/20',
        tokens: [
          {
            label: t('修改日期(年-月-日)'),
            value: '{MOD:YYYY-MM-DD}',
            desc: t('文件最后修改日期 (如 2024-03-15)'),
            pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20'
          },
          {
            label: t('修改时间(年月日时分)'),
            value: '{MOD:YYYYMMDD_HHmm}',
            desc: t('精确修改时间戳 (如 20240315_1430)'),
            pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20'
          },
          {
            label: t('创建日期(年-月-日)'),
            value: '{CRE:YYYY-MM-DD}',
            desc: t('文件创建日期 (如 2024-01-01)'),
            pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20'
          },
          {
            label: t('修改年份(YYYY)'),
            value: '{MOD:YYYY}',
            desc: t('四位修改年份 (如 2024)'),
            pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20'
          }
        ]
      },
      {
        category: t('分类维度'),
        badgeColor: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
        tokens: dimTokens
      },
      {
        category: t('无数据'),
        badgeColor: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20',
        tokens: [
          {
            label: t('分辨率'),
            value: `{META:${t('分辨率')}}`,
            desc: t('图片/视频分辨率 (如 1920x1080)'),
            pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
          },
          {
            label: t('时长'),
            value: `{META:${t('时长')}}`,
            desc: t('音视频时长 (如 03分25秒)'),
            pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
          },
          {
            label: t('页数'),
            value: `{META:${t('页数')}}`,
            desc: t('文档总页数 (如 15P)'),
            pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
          },
          {
            label: t('编码格式'),
            value: `{META:${t('编码')}}`,
            desc: t('媒体编码格式 (如 H264, AAC)'),
            pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
          }
        ]
      },
      {
        category: t('自增序号'),
        badgeColor: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
        tokens: [
          {
            label: t('两位序号(01)'),
            value: '{SEQ:01}',
            desc: t('两位补零自增序号 (01, 02...)'),
            pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20'
          },
          {
            label: t('三位序号(001)'),
            value: '{SEQ:001}',
            desc: t('三位补零自增序号 (001, 002...)'),
            pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20'
          },
          {
            label: t('四位序号(0001)'),
            value: '{SEQ:0001}',
            desc: t('四位补零自增序号 (0001, 0002...)'),
            pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20'
          }
        ]
      }
    ]
  }, [dimensionGroups])

  // 仅针对已分析文件进行批量更名预览与操作
  const analyzedFiles = useMemo(() => {
    return (files || []).filter(f => (f as any).is_analyzed !== 0 && f.isAnalyzed !== false)
  }, [files])

  // 实时更新重命名预览
  useEffect(() => {
    let isMounted = true
    const updatePreview = async () => {
      if (!analyzedFiles || analyzedFiles.length === 0) {
        setPreviewList([])
        return
      }
      setIsLoadingPreview(true)
      try {
        if (window.electronAPI?.organizeBatch?.previewRename) {
          const previews = await window.electronAPI.organizeBatch.previewRename(template, analyzedFiles)
          if (isMounted) setPreviewList(previews)
        }
      } catch (e) {
        console.error('生成重命名预览失败:', e)
      } finally {
        if (isMounted) setIsLoadingPreview(false)
      }
    }

    const timer = setTimeout(updatePreview, 120)
    return () => {
      isMounted = false
      clearTimeout(timer)
    }
  }, [template, analyzedFiles])

  // 插入 Token 到当前模板（严禁重复插入相同 Label）
  const handleInsertToken = useCallback(
    (tokenValue: string) => {
      setTemplate(prev => {
        if (isTokenInTemplate(tokenValue, prev)) {
          return prev
        }
        return getSmartTokenInsertion(tokenValue, prev, useTypeDelimiters)
      })
    },
    [useTypeDelimiters]
  )

  // 将 template 拆解为可视化胶囊数组 (Chip Pills)
  const parsedChips = useMemo(() => {
    if (!template) return []
    const regex = /(\[[^\]]+\]|\([^\)]+\)|<[^>]+>|\{[^}]+\}|[^\s_{}\[\]\(\)<>\-]+|[\s_\-])/g
    const matches = template.match(regex) || []
    return matches.filter(m => m.trim().length > 0 || m === ' ')
  }, [template])

  // 更新胶囊流并同步至 template 字符串
  const updateTemplateFromChips = useCallback((chips: string[]) => {
    let joined = chips.join('')
    // 优雅折叠连续分隔符
    joined = joined.replace(/__+/g, '_').replace(/--+/g, '-').replace(/^\s*[_\-]|[\-_]\s*$/g, '')
    setTemplate(joined)
  }, [])

  // 从胶囊流中移除某个 token 或片段
  const handleRemoveChip = (indexToRemove: number) => {
    const newChips = parsedChips.filter((_, idx) => idx !== indexToRemove)
    updateTemplateFromChips(newChips)
  }

  type TokenCategoryType = 'name' | 'date' | 'tag' | 'meta' | 'seq' | 'literal'

  function getTokenCategory(tokenStr: string): TokenCategoryType {
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
    if (
      tStr.includes('TAG:') ||
      tStr.includes('AUTHOR') ||
      tStr.includes('LANG')
    ) {
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

  function getChipStyle(tokenStr: string): string {
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

  function getSegmentColorClass(type: string): string {
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
   * 结构化色彩渲染新文件名组件（根据 DSL 变量分组语义分段高亮）
   */
  const RenderedFilename: React.FC<{
    segments?: Array<{ text: string; type: string }>
    fallbackName: string
    isChanged: boolean
  }> = ({ segments, fallbackName, isChanged }) => {
    if (segments && segments.length > 0) {
      return (
        <span className="inline-flex items-center flex-wrap font-sans">
          {segments.map((seg, sIdx) => {
            if (!seg.text) return null
            return (
              <span key={sIdx} className={getSegmentColorClass(seg.type)}>
                {seg.text}
              </span>
            )
          })}
        </span>
      )
    }

    return (
      <span
        className={cn(
          'font-semibold font-sans',
          isChanged ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        {fallbackName}
      </span>
    )
  }

  /**
   * 计算单个文件在当前模板与底层数据中具有有效值的标签/属性数量（用于更名实时对照列表由高到低排序）
   */
  function getItemTagScore(item: BatchRenamePreviewItem, file?: FileInfoForAI): number {
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
        totalTagsCount += file.dimensionTags.filter(t => t && t.tag && !isExtensionTriggerTagName(t.tag)).length
      }
      if (Array.isArray(file.tags)) {
        totalTagsCount += file.tags.filter(t => t && typeof t === 'string' && t.trim()).length
      }
      if (file.author && String(file.author).trim()) {
        totalTagsCount += 1
      }
      if (file.metadata && typeof file.metadata === 'object' && Object.keys(file.metadata).length > 0) {
        totalTagsCount += 1
      }
    }

    // 模板内实际匹配生效的标签权重大（x100），加上底层有效标签总数，确保有值标签越多的文件排在越前
    return matchedTokensCount * 100 + totalTagsCount
  }

  /**
   * 判定文件是否相较于智能文件名发生了变动（以智能文件名作为判定基准）
   */
  function isItemChanged(item: BatchRenamePreviewItem): boolean {
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

  // 切换随机模板
  const handleRandomTemplate = async () => {
    try {
      if (window.electronAPI?.organizeBatch?.getRandomTemplate) {
        const rand = await window.electronAPI.organizeBatch.getRandomTemplate()
        if (rand) {
          setTemplate(useTypeDelimiters ? rand : stripTypeDelimiters(rand))
          toast.success(t('已应用随机命名模板'))
          return
        }
      }
    } catch {
      // 降级回退
    }
    const presets = getPresetNamingTemplates()
    const rand = presets[Math.floor(Math.random() * presets.length)].template
    setTemplate(useTypeDelimiters ? rand : stripTypeDelimiters(rand))
    toast.success(t('已应用随机命名模板'))
  }

  // 清空模板
  const handleClearTemplate = () => {
    setTemplate('')
    toast.info(t('已清空模板'))
  }

  // 还原默认模板
  const handleResetTemplate = () => {
    const defaultTpl = `[{TAG:${t('文件类型')}}]{SMART_NAME}_{MOD:YYYY-MM-DD}`
    setTemplate(useTypeDelimiters ? defaultTpl : stripTypeDelimiters(defaultTpl))
    toast.info(t('已还原默认模板'))
  }

  // 复制当前模板
  const handleCopyTemplate = () => {
    if (!template) return
    navigator.clipboard.writeText(template)
    toast.success(t('模板已复制到剪贴板'))
  }

  // 过滤后的推荐模板
  const presetList = useMemo(() => getPresetNamingTemplates(), [])
  const filteredPresets = useMemo(() => {
    if (!templateSearch.trim()) return presetList
    const kw = templateSearch.toLowerCase()
    return presetList.filter(
      p =>
        p.name.toLowerCase().includes(kw) ||
        p.template.toLowerCase().includes(kw) ||
        p.description.toLowerCase().includes(kw)
    )
  }, [presetList, templateSearch])

  const fileMap = useMemo(() => {
    const map = new Map<any, FileInfoForAI>()
    for (const f of analyzedFiles || []) {
      if (f.id !== undefined) map.set(f.id, f)
      if (f.path) map.set(f.path, f)
    }
    return map
  }, [analyzedFiles])

  // 过滤后的预览列表（核心规则：按照标签有值的个数由高到低降序排序）
  const filteredPreviewList = useMemo(() => {
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

  // 限制更名效果实时对照列表最大展示数量（避免海量文件造成前端 DOM 渲染卡顿）
  const MAX_PREVIEW_ITEMS = 200

  // 截取前 200 项用于实际列表渲染
  const displayedPreviewList = useMemo(() => {
    return filteredPreviewList.slice(0, MAX_PREVIEW_ITEMS)
  }, [filteredPreviewList])

  // 统计信息（以智能文件名为基准判定）
  const previewStats = useMemo(() => {
    const total = previewList.length
    const changed = previewList.filter(i => isItemChanged(i)).length
    const unchanged = previewList.filter(i => !isItemChanged(i) && !i.hasError).length
    const errors = previewList.filter(i => i.hasError).length
    const changeRate = total > 0 ? Math.round((changed / total) * 100) : 0
    return { total, changed, unchanged, errors, changeRate }
  }, [previewList])

  // 处理拖拽落点 Drop 事件
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (draggedChipIndex === null || !dropTarget) {
      setDraggedChipIndex(null)
      setDropTarget(null)
      return
    }

    const newChips = [...parsedChips]
    const [movedItem] = newChips.splice(draggedChipIndex, 1)

    let targetIndex = dropTarget.position === 'before' ? dropTarget.index : dropTarget.index + 1
    if (draggedChipIndex < targetIndex) {
      targetIndex -= 1
    }
    targetIndex = Math.max(0, Math.min(targetIndex, newChips.length))
    newChips.splice(targetIndex, 0, movedItem)

    updateTemplateFromChips(newChips)
    setDraggedChipIndex(null)
    setDropTarget(null)
  }

  return (
    <div className="flex-1 flex overflow-hidden bg-background">
      <SplitPane
        direction="horizontal"
        storageKey="organize-batch-rename"
        className="flex-1"
        sections={[
          // ─── 1. 左栏：常用精选模板候选库 ──────────────────────────────────
          {
            id: 'rename-presets',
            type: 'pixel',
            defaultSize: 245,
            minSize: 200,
            content: (
              <div className="h-full flex flex-col bg-background border-r border-border/40 overflow-hidden select-none">
                <div className="p-3 border-b border-border/40 space-y-2 shrink-0 bg-background">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <MaterialIcon icon="bookmarks" className="text-sm text-primary" />
                      {t('精选命名模板')}
                    </span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 h-4 font-mono">
                      {filteredPresets.length}
                    </Badge>
                  </div>
                  <div className="relative">
                    <Input
                      value={templateSearch}
                      onChange={e => setTemplateSearch(e.target.value)}
                      placeholder={t('搜索模板...')}
                      className="h-7 text-xs pl-7 bg-background shadow-2xs border-border/40"
                    />
                    <MaterialIcon
                      icon="search"
                      className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                    />
                    {templateSearch && (
                      <button
                        type="button"
                        onClick={() => setTemplateSearch('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                  {filteredPresets.map((item, idx) => {
                    const isSelected = template === item.template
                    return (
                      <div
                        key={idx}
                        onClick={() => {
                          const finalTpl = useTypeDelimiters ? item.template : stripTypeDelimiters(item.template)
                          setTemplate(finalTpl)
                          toast.success(t('已套用模板: {name}', { name: item.name }))
                        }}
                        className={cn(
                          'p-2 rounded-lg border text-left cursor-pointer transition-all duration-150 group',
                          isSelected
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-transparent hover:border-border/40 hover:bg-muted/40 text-foreground'
                        )}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <div className="flex items-center gap-1 min-w-0">
                            <MaterialIcon icon={item.icon || 'label'} className="text-xs text-primary/70 shrink-0" />
                            <span className="font-medium text-xs truncate">{item.name}</span>
                          </div>
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-muted/60 text-muted-foreground font-mono shrink-0">
                            {item.category}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-muted-foreground mt-1 truncate">
                          {item.template}
                        </div>
                        <div className="text-[10px] text-muted-foreground/70 mt-0.5 line-clamp-1">
                          {item.description}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          },

          // ─── 2. 中栏：模板编排区与变量选择 ──────────────────────────────────
          {
            id: 'rename-editor',
            type: 'flex',
            defaultSize: 1.2,
            minSize: 320,
            content: (
              <div className="h-full flex flex-col bg-background border-r border-border/40 overflow-hidden">
                <div className="p-3.5 border-b border-border/50 space-y-3 shrink-0 bg-muted/40 dark:bg-muted/25">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                        <MaterialIcon icon="tune" className="text-sm text-primary" />
                        {t('模板可视化编排')}
                      </span>
                      <span className="text-[10px] text-muted-foreground bg-background/80 px-1.5 py-0.2 rounded font-mono border border-border/40 shadow-2xs">
                        DSL
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRandomTemplate}
                        className="h-6 text-xs gap-1 rounded-md border-primary/40 bg-background hover:bg-primary/10 text-primary cursor-pointer shadow-2xs"
                        title={t('随机从模板库抽取灵感')}
                      >
                        <MaterialIcon icon="casino" className="text-xs" />
                        <span>{t('随机')}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleCopyTemplate}
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground cursor-pointer hover:bg-background/80"
                        title={t('复制当前模板表达式')}
                      >
                        <MaterialIcon icon="content_copy" className="text-xs" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleResetTemplate}
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground cursor-pointer hover:bg-background/80"
                        title={t('还原默认模板')}
                      >
                        <MaterialIcon icon="restart_alt" className="text-xs" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleClearTemplate}
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive cursor-pointer hover:bg-background/80"
                        title={t('清空当前模板')}
                      >
                        <MaterialIcon icon="delete_sweep" className="text-xs" />
                      </Button>
                    </div>
                  </div>

                  {/* 胶囊编排区 (Chip Pills 流式展示 - 放大、舒展、突出) */}
                  <div
                    onDragOver={e => e.preventDefault()}
                    onDrop={handleDrop}
                    className="p-3.5 rounded-xl border border-border/60 bg-background min-h-[58px] flex flex-wrap items-center gap-2.5 relative shadow-xs"
                  >
                    {parsedChips.length === 0 ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground/60 italic pl-1">
                        <MaterialIcon icon="drag_indicator" className="text-base opacity-50" />
                        <span>{t('模板为空，请从下方点击属性标签开始智能组合...')}</span>
                      </div>
                    ) : (
                      parsedChips.map((chip, idx) => {
                        const isBeingDragged = draggedChipIndex === idx

                        const showBeforeIndicator =
                          dropTarget?.index === idx && dropTarget.position === 'before'
                        const showAfterIndicator =
                          dropTarget?.index === idx && dropTarget.position === 'after'

                        return (
                          <React.Fragment key={idx}>
                            {/* 插入位置前置指示器 */}
                            {showBeforeIndicator && <InsertionIndicator />}

                            <div
                              draggable
                              onDragStart={e => {
                                setDraggedChipIndex(idx)
                                e.dataTransfer.setData('text/plain', String(idx))
                                e.dataTransfer.effectAllowed = 'move'
                              }}
                              onDragOver={e => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                const rect = e.currentTarget.getBoundingClientRect()
                                const isBefore = e.clientX < rect.left + rect.width / 2
                                const position = isBefore ? 'before' : 'after'
                                if (
                                  !dropTarget ||
                                  dropTarget.index !== idx ||
                                  dropTarget.position !== position
                                ) {
                                  setDropTarget({ index: idx, position })
                                }
                              }}
                              onDragEnd={() => {
                                setDraggedChipIndex(null)
                                setDropTarget(null)
                              }}
                              className={cn(
                                'group/chip relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-mono select-none transition-all duration-150',
                                'cursor-grab active:cursor-grabbing hover:scale-[1.02] active:scale-98',
                                getChipStyle(chip),
                                isBeingDragged && 'opacity-30 border-dashed border-primary scale-95'
                              )}
                            >
                              <MaterialIcon
                                icon="drag_indicator"
                                className="text-xs text-muted-foreground/50 -ml-0.5 shrink-0 opacity-40 group-hover/chip:opacity-100 transition-opacity"
                              />
                              <span className="leading-snug">{chip}</span>

                              {/* 右上角浮动删除图标 */}
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation()
                                  handleRemoveChip(idx)
                                }}
                                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[14px] leading-none font-bold opacity-0 group-hover/chip:opacity-100 transition-all duration-150 shadow-xs scale-110 cursor-pointer z-10"
                                title={t('移除')}
                              >
                                ×
                              </button>
                            </div>

                            {/* 插入位置后置指示器 */}
                            {showAfterIndicator && <InsertionIndicator />}
                          </React.Fragment>
                        )
                      })
                    )}
                  </div>

                  {/* 表达式文本输入框与底部开关行 */}
                  <div className="space-y-2">
                    <Input
                      value={template}
                      onChange={e => setTemplate(e.target.value)}
                      placeholder={t('自由编辑或输入 DSL 模板表达式')}
                      className="font-mono text-xs h-8 bg-background focus-visible:ring-primary w-full shadow-2xs border-border/50"
                    />
                    <div className="flex items-center justify-between gap-2 px-0.5 pt-0.5">
                      <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                        <MaterialIcon icon="auto_fix_high" className="text-xs text-primary/70 shrink-0" />
                        <span className="truncate">{t('连接符已根据语义智能生成，缺少变量时自动折叠')}</span>
                      </div>
                      <label className="inline-flex items-center gap-1.5 text-xs text-foreground cursor-pointer select-none bg-background hover:bg-background/80 px-2.5 py-1 rounded-md border border-border/40 transition-colors shrink-0 shadow-2xs" title={t('勾选时自动添加 []、()、<> 等类型修饰符，取消勾选时则移除')}>
                        <input
                          type="checkbox"
                          checked={useTypeDelimiters}
                          onChange={e => handleToggleTypeDelimiters(e.target.checked)}
                          className="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer accent-primary"
                        />
                        <span className="font-medium text-[11px]">{t('添加类型包裹符')}</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* 2. 属性标签资源池（轻量无嵌套外边框） */}
                <div className="flex-1 flex flex-col min-h-0 bg-background overflow-hidden">
                  <div className="p-3 pb-2.5 border-b border-border/40 space-y-2.5 shrink-0 bg-background">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                        <MaterialIcon icon="touch_app" className="text-xs text-primary" />
                        <span>{t('属性标签资源池')}</span>
                      </div>
                      <div className="relative w-36">
                        <Input
                          value={tokenSearch}
                          onChange={e => setTokenSearch(e.target.value)}
                          placeholder={t('过滤属性...')}
                          className="h-6 text-[11px] pl-6 bg-background shadow-2xs border-border/40"
                        />
                        <MaterialIcon
                          icon="filter_list"
                          className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                        />
                      </div>
                    </div>

                    {/* 属性分类快捷 Tab 过滤栏 */}
                    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-0.5">
                      {[
                        { id: t('常用'), label: t('常用'), icon: 'star' },
                        { id: 'all', label: t('全部'), icon: 'apps' },
                        { id: t('核心名称'), label: t('核心与作者'), icon: 'person' },
                        { id: t('时间日期'), label: t('时间日期'), icon: 'calendar_today' },
                        { id: t('分类维度'), label: t('分类维度'), icon: 'category' },
                        { id: t('无数据'), label: t('无数据'), icon: 'aspect_ratio' },
                        { id: t('自增序号'), label: t('自增序号'), icon: 'format_list_numbered' }
                      ].map(tab => {
                        const isSelected = selectedTokenCategory === tab.id
                        return (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setSelectedTokenCategory(tab.id)}
                            className={cn(
                              'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium shrink-0 transition-all cursor-pointer border',
                              isSelected
                                ? 'bg-primary text-primary-foreground border-primary shadow-2xs font-semibold'
                                : 'bg-muted/25 text-muted-foreground hover:text-foreground hover:bg-muted/50 border-border/30'
                            )}
                          >
                            <MaterialIcon icon={tab.icon} className="text-[11px]" />
                            <span>{tab.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
                    {(() => {
                      const visibleCategories = tokenCategories
                        .filter(cat => {
                          if (selectedTokenCategory === 'all') return cat.category !== t('常用')
                          return cat.category === selectedTokenCategory
                        })
                        .map(cat => ({
                          ...cat,
                          tokens: cat.tokens
                            .filter(t => !isTokenInTemplate(t.value, template))
                            .filter(t =>
                              tokenSearch.trim()
                                ? t.label.toLowerCase().includes(tokenSearch.toLowerCase()) ||
                                  t.value.toLowerCase().includes(tokenSearch.toLowerCase())
                                : true
                            )
                        }))
                        .filter(cat => cat.tokens.length > 0)

                      if (visibleCategories.length === 0) {
                        return (
                          <div className="h-40 flex flex-col items-center justify-center text-xs text-muted-foreground gap-1.5 text-center px-4">
                            <MaterialIcon icon="check_circle" className="text-2xl text-primary/60" />
                            <span>
                              {tokenSearch.trim()
                                ? t('没有找到匹配的属性')
                                : t('所有属性标签均已添加至上方模板')}
                            </span>
                          </div>
                        )
                      }

                      return visibleCategories.map((cat, catIdx) => (
                        <div key={catIdx} className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className={cn('px-2 py-0.5 rounded text-[10px] font-bold border', cat.badgeColor)}>
                              {cat.category}
                            </span>
                            <span className="text-[10px] text-muted-foreground/70 font-mono">
                              {t('{count} 个可用', { count: cat.tokens.length })}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {cat.tokens.map((token, tIdx) => {
                              const isSelfNamed =
                                token.value.startsWith('{TAG:') || token.value.startsWith('{META:')

                              return (
                                <button
                                  key={tIdx}
                                  type="button"
                                  title={token.desc}
                                  onClick={() => handleInsertToken(token.value)}
                                  className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium border transition-all duration-150',
                                    'hover:-translate-y-0.5 hover:shadow-2xs active:scale-95 cursor-pointer',
                                    token.pillClass || 'bg-muted/30 hover:bg-primary/15 border-border/40 text-foreground'
                                  )}
                                >
                                  {isSelfNamed ? (
                                    <span className="font-mono">{token.value}</span>
                                  ) : (
                                    <>
                                      <span>{token.label}</span>
                                      <span className="text-[10px] font-mono opacity-60 ml-0.5">
                                        {token.value}
                                      </span>
                                    </>
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))
                    })()}
                  </div>
                </div>
              </div>
            )
          },

          // ─── 3. 右栏：实时更名效果对照与差异高亮 ──────────────────────────
          {
            id: 'rename-preview',
            type: 'flex',
            defaultSize: 1.5,
            minSize: 360,
            content: (
              <div className="h-full flex flex-col bg-background overflow-hidden">
                {/* 右栏顶部看板与搜索 */}
                <div className="p-3 border-b border-border/40 space-y-2.5 shrink-0 bg-background">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                        <MaterialIcon icon="preview" className="text-sm text-primary" />
                        {t('更名效果实时对照')}
                      </span>
                      {filteredPreviewList.length > MAX_PREVIEW_ITEMS && (
                        <span
                          className="text-[10px] text-amber-600 dark:text-amber-400 font-mono bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.2 rounded-full"
                          title={t('为保证性能，实时对照列表仅展示前 {max} 个文件（共 {total} 个）', {
                            max: MAX_PREVIEW_ITEMS,
                            total: filteredPreviewList.length
                          })}
                        >
                          {t('仅展示前 {max} 项', { max: MAX_PREVIEW_ITEMS })}
                        </span>
                      )}
                      {previewStats.total > 0 && (
                        <span className="text-[10px] text-muted-foreground font-mono bg-muted/60 px-1.5 py-0.2 rounded-full">
                          {t('变更率: {rate}%', { rate: previewStats.changeRate })}
                        </span>
                      )}
                    </div>
                    {isLoadingPreview ? (
                      <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <MaterialIcon icon="sync" className="text-xs animate-spin" />
                        {t('计算中...')}
                      </span>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Button
                          variant={rightViewMode === 'card' ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => setRightViewMode('card')}
                          className="h-6 w-6 p-0 cursor-pointer"
                          title={t('卡片对照视图')}
                        >
                          <MaterialIcon icon="view_agenda" className="text-xs" />
                        </Button>
                        <Button
                          variant={rightViewMode === 'table' ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => setRightViewMode('table')}
                          className="h-6 w-6 p-0 cursor-pointer"
                          title={t('表格视图')}
                        >
                          <MaterialIcon icon="table_rows" className="text-xs" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* 状态统计 Filter Tabs 与搜索框 */}
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-1 bg-muted/30 p-0.5 rounded-md border border-border/40">
                      <button
                        type="button"
                        onClick={() => setFilterTab('all')}
                        className={cn(
                          'px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer',
                          filterTab === 'all'
                            ? 'bg-background text-foreground shadow-2xs font-semibold'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {t('全部 ({count})', { count: previewStats.total })}
                      </button>
                      <button
                        type="button"
                        onClick={() => setFilterTab('changed')}
                        className={cn(
                          'px-2 py-0.5 rounded text-[11px] font-medium transition-colors flex items-center gap-1 cursor-pointer',
                          filterTab === 'changed'
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-semibold'
                            : 'text-muted-foreground hover:text-emerald-600'
                        )}
                      >
                        <span>{t('已变动')}</span>
                        <span className="font-mono text-[10px]">({previewStats.changed})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setFilterTab('unchanged')}
                        className={cn(
                          'px-2 py-0.5 rounded text-[11px] font-medium transition-colors flex items-center gap-1 cursor-pointer',
                          filterTab === 'unchanged'
                            ? 'bg-background text-foreground shadow-2xs font-semibold'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        <span>{t('未改变')}</span>
                        <span className="font-mono text-[10px]">({previewStats.unchanged})</span>
                      </button>
                    </div>

                    <div className="relative w-36">
                      <Input
                        value={previewSearch}
                        onChange={e => setPreviewSearch(e.target.value)}
                        placeholder={t('搜索文件名...')}
                        className="h-6 text-[11px] pl-6 bg-background shadow-2xs border-border/40"
                      />
                      <MaterialIcon
                        icon="search"
                        className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                      />
                    </div>
                  </div>
                </div>

                {/* 实时更名对照内容列表（单线条细分隔线，轻量化极简风格，增加内边距与行间距） */}
                <div className="flex-1 overflow-y-auto">
                  {displayedPreviewList.length === 0 ? (
                    <div className="h-40 flex flex-col items-center justify-center text-xs text-muted-foreground gap-1.5">
                      <MaterialIcon icon="folder_open" className="text-2xl text-muted-foreground/50" />
                      <span>{t('没有符合筛选条件的待重命名文件')}</span>
                    </div>
                  ) : rightViewMode === 'card' ? (
                    <div className="divide-y divide-border/30">
                      {displayedPreviewList.map((item, idx) => {
                        const isChanged = isItemChanged(item)
                        const cleanSmartName = (item.rawSmartName || '').replace(/\.[a-zA-Z0-9]{1,10}$/i, '')
                        return (
                          <div
                            key={item.fileId || idx}
                            className={cn(
                              'py-3 px-3.5 hover:bg-muted/25 transition-colors text-xs space-y-1.5 text-left',
                              item.hasError && 'bg-destructive/5'
                            )}
                          >
                            {/* 1. 原文件名 */}
                            <div className="flex items-center justify-between text-muted-foreground/60 text-[11px]">
                              <div className="flex items-center gap-1.5 truncate max-w-full font-sans">
                                <MaterialIcon
                                  icon="insert_drive_file"
                                  className="text-xs shrink-0 text-muted-foreground/60"
                                />
                                <span className="truncate" title={item.currentName}>
                                  {item.currentName}
                                </span>
                              </div>
                              {item.hasError && (
                                <Badge variant="destructive" className="text-[10px] h-4 px-1.5 shrink-0 ml-2">
                                  {t('异常')}
                                </Badge>
                              )}
                            </div>

                            {/* 2. 原始智能文件名（左对齐，纯文本，无背景色框，展示不带扩展名的 rawSmartName） */}
                            {cleanSmartName && (
                              <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground font-sans">
                                <MaterialIcon icon="psychology" className="text-xs text-primary/70 shrink-0" />
                                <span className="truncate" title={cleanSmartName}>
                                  {cleanSmartName}
                                </span>
                              </div>
                            )}

                            {/* 3. 拟更名新名称（左对齐，按变量标签分组色彩结构化渲染） */}
                            <div className="font-sans font-medium text-foreground text-xs break-all flex items-center gap-1.5 pt-1">
                              <MaterialIcon
                                icon="drive_file_rename_outline"
                                className={cn(
                                  'text-sm shrink-0',
                                  isChanged ? 'text-primary' : 'text-muted-foreground/60'
                                )}
                              />
                              <RenderedFilename
                                segments={item.segments}
                                fallbackName={item.newName}
                                isChanged={isChanged}
                              />
                            </div>

                            {item.hasError && (
                              <div className="text-[10px] text-destructive flex items-center gap-1 pt-1">
                                <MaterialIcon icon="error" className="text-xs" />
                                <span>{item.errorMessage}</span>
                              </div>
                            )}
                          </div>
                        )
                      })}

                      {/* 超出 200 项时的底部提示条 */}
                      {filteredPreviewList.length > MAX_PREVIEW_ITEMS && (
                        <div className="py-3 px-3.5 bg-muted/20 text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5">
                          <MaterialIcon icon="info" className="text-xs text-amber-500 shrink-0" />
                          <span>
                            {t('为保证性能，实时对照列表仅展示前 {max} 个文件（共 {total} 个）', {
                              max: MAX_PREVIEW_ITEMS,
                              total: filteredPreviewList.length
                            })}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    // 紧凑表格视图
                    <div className="text-xs">
                      <table className="w-full text-left border-collapse">
                        <thead className="bg-muted/30 border-b border-border/40 text-[11px] text-muted-foreground">
                          <tr>
                            <th className="p-2.5 font-medium">{t('原文件名')}</th>
                            <th className="p-2.5 font-medium">{t('原始智能文件名')}</th>
                            <th className="p-2.5 font-medium">{t('拟更名新名称')}</th>
                            <th className="p-2.5 font-medium w-16 text-right">{t('状态')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/30 font-mono text-[11px]">
                          {displayedPreviewList.map((item, idx) => {
                            const isChanged = isItemChanged(item)
                            const cleanSmartName = (item.rawSmartName || '').replace(/\.[a-zA-Z0-9]{1,10}$/i, '')
                            return (
                              <tr key={item.fileId || idx} className="hover:bg-muted/20 transition-colors">
                                <td className="p-2.5 truncate max-w-[120px] text-muted-foreground" title={item.currentName}>
                                  {item.currentName}
                                </td>
                                <td className="p-2.5 truncate max-w-[120px] text-muted-foreground font-sans" title={cleanSmartName || '-'}>
                                  {cleanSmartName || '-'}
                                </td>
                                <td className="p-2.5 truncate max-w-[160px]" title={item.newName}>
                                  <RenderedFilename
                                    segments={item.segments}
                                    fallbackName={item.newName}
                                    isChanged={isChanged}
                                  />
                                </td>
                                <td className="p-2.5 text-right">
                                  {item.hasError ? (
                                    <span className="text-destructive font-bold">{t('异常')}</span>
                                  ) : isChanged ? (
                                    <span className="text-emerald-500 font-bold">{t('变更')}</span>
                                  ) : (
                                    <span className="text-muted-foreground/60">{t('同名')}</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>

                      {/* 超出 200 项时的底部提示条 */}
                      {filteredPreviewList.length > MAX_PREVIEW_ITEMS && (
                        <div className="py-3 px-3.5 bg-muted/20 text-center text-xs text-muted-foreground border-t border-border/30 flex items-center justify-center gap-1.5">
                          <MaterialIcon icon="info" className="text-xs text-amber-500 shrink-0" />
                          <span>
                            {t('为保证性能，实时对照列表仅展示前 {max} 个文件（共 {total} 个）', {
                              max: MAX_PREVIEW_ITEMS,
                              total: filteredPreviewList.length
                            })}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 隐藏的更名执行触发挂载点（供顶部统一操作栏触发） */}
                <button
                  id="btn-execute-rename-trigger"
                  type="button"
                  onClick={() => onExecuteRename(template)}
                  disabled={isExecuting || previewList.length === 0}
                  className="hidden"
                  aria-hidden="true"
                />
              </div>
            )
          }
        ]}
      />
    </div>
  )
}

