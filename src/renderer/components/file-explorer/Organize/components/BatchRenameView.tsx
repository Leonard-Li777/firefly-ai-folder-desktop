import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Badge } from '../../../ui/badge'
import { toast } from '../../../common/Toast'
import { SplitPane } from '../../../common/SplitPane'
import { BatchRenamePreviewItem, DimensionGroup } from '@firefly/types'

/**
 * 常用/精选命名模板预置列表（与后端 NamingDSLEngine 多语言对齐）
 */
const getPresetNamingTemplates = () => [
  {
    name: `${t('智能文件名')} + ${t('日期')}`,
    template: '{SMART_NAME}_{MOD:YYYY-MM-DD}',
    category: t('常用'),
    icon: 'auto_awesome',
    description: t('标准智能文件名后追加修改日期，适合日常整理归档')
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
    template: `{SMART_NAME}_{META:${t('分辨率')}}_{SEQ:01}`,
    category: t('多模态'),
    icon: 'aspect_ratio',
    description: t('多模态媒体专用命名，附带分辨率规格与两位序号')
  },
  {
    name: `${t('创建日期')} + ${t('原文件名')} + ${t('序号')}`,
    template: '{CRE:YYYY-MM-DD}_{ORIG_NAME}_{SEQ:001}',
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
    template: `[{TAG:${t('题材')}}]_{SMART_NAME}_{MOD:YYYY-MM-DD}_{SEQ:01}`,
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
 * 根据所选 DSL Token 类型与语义，动态计算其最佳包裹形态与前置连接符
 */
function getSmartTokenInsertion(tokenValue: string, currentTemplate: string): string {
  let mappedToken = tokenValue

  // 1. 维度与作者标签默认包覆方括号前置修饰符
  if (tokenValue.startsWith('{TAG:') && !tokenValue.startsWith('[{TAG:')) {
    mappedToken = `[${tokenValue}]`
  } else if (tokenValue === '{AUTHOR}') {
    mappedToken = `[{AUTHOR}]`
  } else if (tokenValue === '{QUALITY_SCORE}') {
    mappedToken = `[Q{QUALITY_SCORE}]`
  }

  if (!currentTemplate || !currentTemplate.trim()) {
    return mappedToken
  }

  // 2. 扩展名 Token 特殊处理：动态映射为前置点号 `.{EXT}`
  if (tokenValue === '{EXT}') {
    if (currentTemplate.endsWith('.')) {
      return `${currentTemplate}{EXT}`
    }
    return `${currentTemplate}.{EXT}`
  }

  // 3. 检查当前 template 末尾是否已有连接符或括号
  const endsWithSeparator = /[\s_\-\.\[]$/.test(currentTemplate)
  if (endsWithSeparator) {
    return `${currentTemplate}${mappedToken}`
  }

  // 4. 默认采用下划线 `_` 动态连接
  return `${currentTemplate}_${mappedToken}`
}

/**
 * 插入位置指示竖线组件
 */
const InsertionIndicator: React.FC = () => (
  <div className="w-1.5 h-6 bg-primary rounded-full shadow-md shadow-primary/40 -mx-1 z-20 animate-in fade-in zoom-in-75 duration-150 transition-all flex items-center justify-center pointer-events-none">
    <div className="w-0.5 h-3.5 bg-primary-foreground/90 rounded-full" />
  </div>
)

export const BatchRenameView: React.FC<BatchRenameViewProps> = ({
  files,
  dimensionGroups = [],
  onExecuteRename,
  isExecuting = false
}) => {
  const [template, setTemplate] = useState<string>('{SMART_NAME}_{MOD:YYYY-MM-DD}')
  const [previewList, setPreviewList] = useState<BatchRenamePreviewItem[]>([])
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)

  // 胶囊拖拽排序状态
  const [draggedChipIndex, setDraggedChipIndex] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<{ index: number; position: 'before' | 'after' } | null>(null)

  // 左栏模板搜索
  const [templateSearch, setTemplateSearch] = useState('')

  // 中栏属性标签搜索
  const [tokenSearch, setTokenSearch] = useState('')

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
        category: t('分类维度与作者'),
        badgeColor: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
        tokens: [
          ...dimTokens,
          {
            label: t('作者/创作者'),
            value: '{AUTHOR}',
            desc: t('内容作者标签 (如 [{AUTHOR}])'),
            pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
          },
          {
            label: t('语言代码'),
            value: '{LANG}',
            desc: t('文档语言代码 (如 zh-CN, en)'),
            pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
          }
        ]
      },
      {
        category: t('多模态与序号'),
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
          },
          {
            label: t('质量评分'),
            value: '{QUALITY_SCORE}',
            desc: t('AI 质量分值 (如 [Q{QUALITY_SCORE}])'),
            pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
          },
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

  // 实时更新重命名预览
  useEffect(() => {
    let isMounted = true
    const updatePreview = async () => {
      if (!files || files.length === 0) {
        setPreviewList([])
        return
      }
      setIsLoadingPreview(true)
      try {
        if (window.electronAPI?.organizeBatch?.previewRename) {
          const previews = await window.electronAPI.organizeBatch.previewRename(template, files)
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
  }, [template, files])

  // 插入 Token 到当前模板
  const handleInsertToken = useCallback((tokenValue: string) => {
    setTemplate(prev => getSmartTokenInsertion(tokenValue, prev))
  }, [])

  // 将 template 拆解为可视化胶囊数组 (Chip Pills)
  const parsedChips = useMemo(() => {
    if (!template) return []
    const regex = /(\[[^\]]+\]|\{[^}]+\}|[^\s_{}\[\]\-]+|[\s_\-])/g
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
      return 'border-blue-500/35 bg-blue-500/12 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20 font-medium'
    case 'date':
      return 'border-purple-500/35 bg-purple-500/12 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20 font-medium'
    case 'tag':
      return 'border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 font-medium'
    case 'meta':
      return 'border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 font-medium'
    case 'seq':
      return 'border-cyan-500/35 bg-cyan-500/12 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20 font-medium'
    default:
      return 'bg-muted/60 text-muted-foreground border border-border/40 hover:bg-muted/80 font-normal'
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
  // 切换随机模板
  const handleRandomTemplate = async () => {
    try {
      if (window.electronAPI?.organizeBatch?.getRandomTemplate) {
        const rand = await window.electronAPI.organizeBatch.getRandomTemplate()
        if (rand) {
          setTemplate(rand)
          toast.success(t('已应用随机命名模板'))
          return
        }
      }
    } catch {
      // 降级回退
    }
    const presets = getPresetNamingTemplates()
    const rand = presets[Math.floor(Math.random() * presets.length)].template
    setTemplate(rand)
    toast.success(t('已应用随机命名模板'))
  }

  // 清空模板
  const handleClearTemplate = () => {
    setTemplate('')
    toast.info(t('已清空模板'))
  }

  // 还原默认模板
  const handleResetTemplate = () => {
    setTemplate('{SMART_NAME}_{MOD:YYYY-MM-DD}')
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

  // 过滤后的预览列表
  const filteredPreviewList = useMemo(() => {
    let list = previewList
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
    return list
  }, [previewList, filterTab, previewSearch])

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
              <div className="h-full flex flex-col bg-muted/15 border-r border-border/50 overflow-hidden select-none">
                <div className="p-3 border-b border-border/50 space-y-2 shrink-0 bg-background/40">
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
                      className="h-7 text-xs pl-7 bg-background shadow-2xs"
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

                <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
                  {filteredPresets.map((item, idx) => {
                    const isSelected = template === item.template
                    return (
                      <div
                        key={idx}
                        onClick={() => {
                          setTemplate(item.template)
                          toast.success(t('已套用模板: {name}', { name: item.name }))
                        }}
                        className={cn(
                          'p-2.5 rounded-xl border text-left cursor-pointer transition-all duration-200 group relative',
                          isSelected
                            ? 'border-primary/60 bg-primary/10 text-primary shadow-xs ring-1 ring-primary/30'
                            : 'border-border/40 hover:border-border hover:bg-muted/40 text-foreground'
                        )}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <div className="flex items-center gap-1 min-w-0">
                            <MaterialIcon icon={item.icon || 'label'} className="text-xs text-primary/70 shrink-0" />
                            <span className="font-medium text-xs truncate">{item.name}</span>
                          </div>
                          <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-muted text-muted-foreground font-mono shrink-0">
                            {item.category}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-muted-foreground mt-1.5 truncate bg-background/80 px-2 py-0.5 rounded-lg border border-border/30 group-hover:border-primary/30 transition-colors">
                          {item.template}
                        </div>
                        <div className="text-[10px] text-muted-foreground/80 mt-1 line-clamp-1">
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
              <div className="h-full flex flex-col bg-card/25 border-r border-border/50 overflow-hidden">
                {/* 中栏顶部工具与编排区 */}
                <div className="p-3.5 border-b border-border/50 space-y-3 bg-background/60 shrink-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <MaterialIcon icon="tune" className="text-sm text-primary" />
                      {t('模板可视化编排')}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRandomTemplate}
                        className="h-7 text-xs gap-1 rounded-lg border-primary/30 hover:bg-primary/10 text-primary cursor-pointer shadow-2xs"
                        title={t('随机从模板库抽取灵感')}
                      >
                        <MaterialIcon icon="casino" className="text-sm" />
                        <span>{t('随机')}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleCopyTemplate}
                        className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground cursor-pointer"
                        title={t('复制当前模板表达式')}
                      >
                        <MaterialIcon icon="content_copy" className="text-sm" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleResetTemplate}
                        className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground cursor-pointer"
                        title={t('还原默认模板')}
                      >
                        <MaterialIcon icon="restart_alt" className="text-sm" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleClearTemplate}
                        className="h-7 text-xs px-2 text-muted-foreground hover:text-destructive cursor-pointer"
                        title={t('清空当前模板')}
                      >
                        <MaterialIcon icon="delete_sweep" className="text-sm" />
                      </Button>
                    </div>
                  </div>

                  {/* 胶囊编排区 (Chip Pills 流式展示，支持拖拽插入指示竖线与右上角半浮动删除) */}
                  <div
                    onDragOver={e => e.preventDefault()}
                    onDrop={handleDrop}
                    className="p-3 rounded-xl border border-border/50 bg-background/90 min-h-[58px] flex flex-wrap items-center gap-2.5 pt-3.5 transition-all shadow-inner relative"
                  >
                    {parsedChips.length === 0 ? (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60 italic pl-1">
                        <MaterialIcon icon="drag_indicator" className="text-sm opacity-50" />
                        <span>{t('模板为空，请从下方点击属性标签开始智能组合...')}</span>
                      </div>
                    ) : (
                      parsedChips.map((chip, idx) => {
                        const isToken = chip.startsWith('{') || chip.startsWith('[')
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
                                'group/chip relative inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono select-none transition-all duration-150',
                                'cursor-grab active:cursor-grabbing hover:shadow-xs',
                                getChipStyle(chip),
                                isBeingDragged && 'opacity-30 border-dashed border-primary scale-95'
                              )}
                            >
                              <MaterialIcon
                                icon="drag_indicator"
                                className="text-[11px] text-muted-foreground/50 -ml-1 shrink-0 opacity-40 group-hover/chip:opacity-100 transition-opacity"
                              />
                              <span>{chip}</span>

                              {/* 右上角浮动一半在外部的删除图标 */}
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation()
                                  handleRemoveChip(idx)
                                }}
                                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-[11px] leading-none font-bold opacity-0 group-hover/chip:opacity-100 transition-all duration-150 shadow-md hover:scale-115 active:scale-95 cursor-pointer z-10"
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

                  {/* 表达式文本输入框（与胶囊实时双向同步） */}
                  <div className="space-y-1.5">
                    <Input
                      value={template}
                      onChange={e => setTemplate(e.target.value)}
                      placeholder={t('自由编辑或输入 DSL 模板表达式')}
                      className="font-mono text-xs h-8 bg-background focus-visible:ring-primary w-full shadow-2xs"
                    />
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1 px-1">
                      <MaterialIcon icon="auto_fix_high" className="text-xs text-primary/70" />
                      <span>{t('连接符已根据 DSL 语义智能生成，支持在输入框中自由修改；缺少变量时将自动折叠')}</span>
                    </div>
                  </div>
                </div>

                {/* 下半部分：插值 Label 分组选择区 */}
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="p-3 pb-1 flex items-center justify-between gap-2 shrink-0">
                    <div className="text-xs font-semibold text-foreground flex items-center gap-1">
                      <MaterialIcon icon="touch_app" className="text-xs text-primary" />
                      {t('点击属性标签插入至模板：')}
                    </div>
                    <div className="relative w-36">
                      <Input
                        value={tokenSearch}
                        onChange={e => setTokenSearch(e.target.value)}
                        placeholder={t('过滤属性...')}
                        className="h-6 text-[11px] pl-6 bg-background shadow-2xs"
                      />
                      <MaterialIcon
                        icon="filter_list"
                        className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                      />
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-3 space-y-4">
                    {tokenCategories.map((cat, catIdx) => {
                      const matchedTokens = tokenSearch.trim()
                        ? cat.tokens.filter(
                            t =>
                              t.label.toLowerCase().includes(tokenSearch.toLowerCase()) ||
                              t.value.toLowerCase().includes(tokenSearch.toLowerCase())
                          )
                        : cat.tokens

                      if (matchedTokens.length === 0) return null

                      return (
                        <div key={catIdx} className="space-y-1.5">
                          <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/80">
                            <span className={cn('px-1.5 py-0.5 rounded border text-[10px] font-bold', cat.badgeColor)}>
                              {cat.category}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {matchedTokens.map((token, tIdx) => (
                              <button
                                key={tIdx}
                                type="button"
                                title={token.desc}
                                onClick={() => handleInsertToken(token.value)}
                                className={cn(
                                  'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-all duration-150',
                                  'hover:-translate-y-0.5 hover:shadow-xs active:scale-95 cursor-pointer',
                                  token.pillClass || 'bg-muted/40 hover:bg-primary/15 border-border/50 text-foreground'
                                )}
                              >
                                <MaterialIcon icon="add" className="text-[10px] opacity-70" />
                                <span>{token.label}</span>
                                <span className="text-[10px] font-mono opacity-60 ml-0.5">
                                  {token.value}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    })}
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
                <div className="p-3 border-b border-border/50 space-y-2 shrink-0 bg-background/60">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                        <MaterialIcon icon="preview" className="text-sm text-primary" />
                        {t('更名效果实时对照')}
                      </span>
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
                    <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-lg border border-border/40">
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
                        className="h-6 text-[11px] pl-6 bg-background shadow-2xs"
                      />
                      <MaterialIcon
                        icon="search"
                        className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                      />
                    </div>
                  </div>
                </div>

                {/* 实时更名对照内容列表 */}
                <div className="flex-1 overflow-y-auto p-3">
                  {filteredPreviewList.length === 0 ? (
                    <div className="h-40 flex flex-col items-center justify-center text-xs text-muted-foreground gap-1.5">
                      <MaterialIcon icon="folder_open" className="text-2xl text-muted-foreground/50" />
                      <span>{t('没有符合筛选条件的待重命名文件')}</span>
                    </div>
                  ) : rightViewMode === 'card' ? (
                    // 卡片式对照视图（全部左对齐，无多余标签，无智能名背景，无右上角新名称label）
                    <div className="space-y-2.5">
                      {filteredPreviewList.map((item, idx) => {
                        const isChanged = isItemChanged(item)
                        const cleanSmartName = (item.rawSmartName || '').replace(/\.[a-zA-Z0-9]{1,10}$/i, '')
                        return (
                          <div
                            key={item.fileId || idx}
                            className={cn(
                              'p-3 rounded-xl border text-xs space-y-1.5 transition-all text-left',
                              item.hasError
                                ? 'border-destructive/40 bg-destructive/5'
                                : isChanged
                                  ? 'border-primary/40 bg-primary/5 hover:border-primary/60 hover:shadow-xs'
                                  : 'border-border/50 bg-card/60 hover:border-border'
                            )}
                          >
                            {/* 1. 原文件名 */}
                            <div className="flex items-center justify-between text-muted-foreground text-[11px]">
                              <div className="flex items-center gap-1.5 truncate max-w-full font-sans">
                                <MaterialIcon
                                  icon="insert_drive_file"
                                  className="text-xs shrink-0 text-muted-foreground/70"
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

                            {/* 2. 原始智能文件名（左对齐，纯文本，无背景色框，剥离扩展名后缀） */}
                            {cleanSmartName && (
                              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/90 font-sans">
                                <MaterialIcon icon="psychology" className="text-xs text-primary/80 shrink-0" />
                                <span className="truncate" title={cleanSmartName}>
                                  {cleanSmartName}
                                </span>
                              </div>
                            )}

                            {/* 3. 拟更名新名称（左对齐，按变量标签分组色彩结构化渲染） */}
                            <div className="font-sans font-medium text-foreground text-xs break-all flex items-center gap-1.5 pt-0.5">
                              <MaterialIcon
                                icon="drive_file_rename_outline"
                                className={cn(
                                  'text-sm shrink-0',
                                  isChanged ? 'text-primary' : 'text-muted-foreground'
                                )}
                              />
                              <RenderedFilename
                                segments={item.segments}
                                fallbackName={item.newName}
                                isChanged={isChanged}
                              />
                            </div>

                            {item.hasError && (
                              <div className="text-[10px] text-destructive flex items-center gap-1 pt-0.5">
                                <MaterialIcon icon="error" className="text-xs" />
                                <span>{item.errorMessage}</span>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    // 紧凑表格视图
                    <div className="rounded-lg border border-border/60 overflow-hidden text-xs shadow-2xs">
                      <table className="w-full text-left border-collapse">
                        <thead className="bg-muted/50 border-b border-border/50 text-[11px] text-muted-foreground">
                          <tr>
                            <th className="p-2 font-medium">{t('原文件名')}</th>
                            <th className="p-2 font-medium">{t('原始智能名')}</th>
                            <th className="p-2 font-medium">{t('拟更名新名称')}</th>
                            <th className="p-2 font-medium w-16 text-right">{t('状态')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40 font-mono text-[11px]">
                          {filteredPreviewList.map((item, idx) => {
                            const isChanged = isItemChanged(item)
                            const cleanSmartName = (item.rawSmartName || '').replace(/\.[a-zA-Z0-9]{1,10}$/i, '')
                            return (
                              <tr key={item.fileId || idx} className="hover:bg-muted/20 transition-colors">
                                <td className="p-2 truncate max-w-[120px] text-muted-foreground" title={item.currentName}>
                                  {item.currentName}
                                </td>
                                <td className="p-2 truncate max-w-[120px] text-muted-foreground font-sans" title={cleanSmartName || '-'}>
                                  {cleanSmartName || '-'}
                                </td>
                                <td className="p-2 truncate max-w-[160px]" title={item.newName}>
                                  <RenderedFilename
                                    segments={item.segments}
                                    fallbackName={item.newName}
                                    isChanged={isChanged}
                                  />
                                </td>
                                <td className="p-2 text-right">
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
