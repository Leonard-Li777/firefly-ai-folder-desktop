import React, { useState, useEffect, useCallback } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Badge } from '../../../ui/badge'
import { toast } from '../../../common/Toast'
import { SplitPane } from '../../../common/SplitPane'
import { BatchRenamePreviewItem, DimensionGroup } from '@firefly/types'
import { BatchRenameTokenPool } from './batch-rename-view/BatchRenameTokenPool'
import { BatchRenamePreviewPane } from './batch-rename-view/BatchRenamePreviewPane'
import {
  useBatchRenameDerived,
  getPresetNamingTemplates,
  stripTypeDelimiters,
  applyTypeDelimiters,
  getSmartTokenInsertion,
  getChipStyle,
  isTokenInTemplate
} from './useBatchRenameDerived'

export { stripTypeDelimiters, applyTypeDelimiters }

interface BatchRenameViewProps {
  files: any[]
  dimensionGroups?: DimensionGroup[]
  onExecuteRename: (template: string) => Promise<void>
  isExecuting?: boolean
}

type ViewMode = 'card' | 'table'
type FilterTab = 'all' | 'changed' | 'unchanged' | 'error'

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
  const { t } = useVoerkaI18n(i18nScope)
  const [template, setTemplate] = useState<string>(
    `[{TAG:${t('文件类型')}}]{SMART_NAME}_{MOD:YYYY-MM-DD}`
  )
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
  const [dropTarget, setDropTarget] = useState<{
    index: number
    position: 'before' | 'after'
  } | null>(null)

  // 左栏模板搜索
  const [templateSearch, setTemplateSearch] = useState('')

  // 中栏属性标签搜索与分类筛选，默认选中「常用」
  const [tokenSearch, setTokenSearch] = useState('')
  const [selectedTokenCategory, setSelectedTokenCategory] = useState<string>('common')

  // 右栏视图设置与筛选
  const [rightViewMode, setRightViewMode] = useState<ViewMode>('card')
  const [filterTab, setFilterTab] = useState<FilterTab>('all')
  const [previewSearch, setPreviewSearch] = useState('')

  // 快捷插值 Token 分类列表（全量接入 t() 多语言体系与层级体系）
  const {
    tokenCategories,
    analyzedFiles,
    parsedChips,
    filteredPresets,
    filteredPreviewList,
    displayedPreviewList,
    previewStats
  } = useBatchRenameDerived({
    files,
    dimensionGroups,
    template,
    templateSearch,
    filterTab,
    previewSearch,
    previewList
  })

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
          const previews = await window.electronAPI.organizeBatch.previewRename(
            template,
            analyzedFiles
          )
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

  // 更新胶囊流并同步至 template 字符串
  const updateTemplateFromChips = useCallback((chips: string[]) => {
    let joined = chips.join('')
    // 优雅折叠连续分隔符
    joined = joined
      .replace(/__+/g, '_')
      .replace(/--+/g, '-')
      .replace(/^\s*[_-]|[-_]\s*$/g, '')
    setTemplate(joined)
  }, [])

  // 从胶囊流中移除某个 token 或片段
  const handleRemoveChip = (indexToRemove: number) => {
    const newChips = parsedChips.filter((_, idx) => idx !== indexToRemove)
    updateTemplateFromChips(newChips)
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
    <div data-testid="batch-rename-view" className="flex-1 flex overflow-hidden bg-background">
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
                          const finalTpl = useTypeDelimiters
                            ? item.template
                            : stripTypeDelimiters(item.template)
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
                            <MaterialIcon
                              icon={item.icon || 'label'}
                              className="text-xs text-primary/70 shrink-0"
                            />
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
                      data-testid="batch-rename-template-input"
                      value={template}
                      onChange={e => setTemplate(e.target.value)}
                      placeholder={t('自由编辑或输入 DSL 模板表达式')}
                      className="font-mono text-xs h-8 bg-background focus-visible:ring-primary w-full shadow-2xs border-border/50"
                    />
                    <div className="flex items-center justify-between gap-2 px-0.5 pt-0.5">
                      <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                        <MaterialIcon
                          icon="auto_fix_high"
                          className="text-xs text-primary/70 shrink-0"
                        />
                        <span className="truncate">
                          {t('连接符已根据语义智能生成，缺少变量时自动折叠')}
                        </span>
                      </div>
                      <label
                        className="inline-flex items-center gap-1.5 text-xs text-foreground cursor-pointer select-none bg-background hover:bg-background/80 px-2.5 py-1 rounded-md border border-border/40 transition-colors shrink-0 shadow-2xs"
                        title={t('勾选时自动添加 []、()、<> 等类型修饰符，取消勾选时则移除')}
                      >
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
                <BatchRenameTokenPool
                  tokenCategories={tokenCategories}
                  tokenSearch={tokenSearch}
                  onTokenSearchChange={setTokenSearch}
                  selectedTokenCategory={selectedTokenCategory}
                  onSelectTokenCategory={setSelectedTokenCategory}
                  template={template}
                  onInsertToken={handleInsertToken}
                />
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
              <BatchRenamePreviewPane
                filteredPreviewList={filteredPreviewList}
                displayedPreviewList={displayedPreviewList}
                previewStats={previewStats}
                isLoadingPreview={isLoadingPreview}
                rightViewMode={rightViewMode}
                onRightViewModeChange={setRightViewMode}
                filterTab={filterTab}
                onFilterTabChange={setFilterTab}
                previewSearch={previewSearch}
                onPreviewSearchChange={setPreviewSearch}
                isExecuting={isExecuting}
                hasPreviewItems={previewList.length > 0}
                onExecuteRename={() => onExecuteRename(template)}
              />
            )
          }
        ]}
      />
    </div>
  )
}
