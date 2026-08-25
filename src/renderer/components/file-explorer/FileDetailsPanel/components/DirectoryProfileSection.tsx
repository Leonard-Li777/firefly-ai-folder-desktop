import React, { useState, useEffect } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { ProgressBar } from '../../../ui/ProgressBar'
import { toast } from '../../../common/Toast'
import { Button } from '../../../ui/button'
import { LogCategory, logger } from '@firefly/shared'
import { PersistentTooltip } from '../../../common/PersistentTooltip'

/**
 * 预设更名模板列表
 */
const getPresetNamingTemplates = () => [
  {
    name: `${t('文件类型')} + ${t('智能文件名')} + ${t('日期')}`,
    template: `[{TAG:${t('文件类型')}}]{SMART_NAME}_{MOD:YYYY-MM-DD}`,
    description: t('文件类型前置，后接智能文件名与修改日期')
  },
  {
    name: `${t('修改日期')} + ${t('智能文件名')}`,
    template: '{MOD:YYYY-MM-DD}_{SMART_NAME}',
    description: t('日期前缀，便于按时间排序')
  },
  {
    name: `${t('题材维度')} + ${t('智能文件名')}`,
    template: `[{TAG:${t('题材')}}]_{SMART_NAME}`,
    description: t('题材标签前置，强化分类属性')
  },
  {
    name: `${t('作者')} + ${t('智能文件名')}`,
    template: '[{AUTHOR}]_{SMART_NAME}',
    description: t('作者或创作者前置')
  },
  {
    name: `${t('智能文件名')} + ${t('分辨率')} + ${t('序号')}`,
    template: `{SMART_NAME}_<{META:${t('分辨率')}}>_({SEQ:01})`,
    description: t('多模态媒体专用命名')
  },
  {
    name: `${t('创建日期')} + ${t('原文件名')} + ${t('序号')}`,
    template: '{CRE:YYYY-MM-DD}_{ORIG_NAME}_({SEQ:001})',
    description: t('保留原文件名与三位序号')
  },
  {
    name: `${t('智能文件名')} + ${t('质量分')}`,
    template: '{SMART_NAME}_[Q{QUALITY_SCORE}]',
    description: t('标记 AI 质量评分')
  },
  {
    name: t('全维度属性组合'),
    template: `[{TAG:${t('题材')}}]_{SMART_NAME}_{MOD:YYYY-MM-DD}_({SEQ:01})`,
    description: t('题材、名称、日期与序号复合命名')
  }
]

/**
 * 目录画像信息展示
 * 当未选择文件时（item 为 undefined）或选中目录时，显示目录的 AI 画像分析结果
 * 智能文件名格式和AI分析策略支持在线编辑，编辑结果会直接影响后续文件分析
 */
export const DirectoryProfileSection: React.FC<{
  analysisResult: any
  isDirAnalysis: (res: any) => boolean
  getTagColor: (index: number) => string
  formatDate: (d: any) => string
  onRefresh?: () => void
  isUnit?: boolean
  workspaceDirectoryPath?: string
}> = ({
  analysisResult,
  isDirAnalysis,
  getTagColor,
  formatDate,
  onRefresh,
  isUnit,
  workspaceDirectoryPath
}) => {
  if (!analysisResult || !isDirAnalysis(analysisResult)) return null

  const ctx = analysisResult.contextAnalysis
  const dirPath = analysisResult.path
  const presetTemplates = getPresetNamingTemplates()

  const isPathEqual =
    window.electronAPI?.utils?.isPathEqual ||
    ((a: string, b: string) =>
      a?.toLowerCase().replace(/[\\/]+$/, '') === b?.toLowerCase().replace(/[\\/]+$/, ''))

  const isWorkspaceRoot = Boolean(
    workspaceDirectoryPath && dirPath && isPathEqual(dirPath, workspaceDirectoryPath)
  )

  const inheritOptions: Array<{ key: 'inherit' | 'current_only' | 'broadcast'; label: string }> =
    isWorkspaceRoot
      ? [
          { key: 'broadcast', label: t('应用到子目录') },
          { key: 'current_only', label: t('仅当前生效') }
        ]
      : [
          { key: 'inherit', label: t('继承父级') },
          { key: 'current_only', label: t('仅当前生效') },
          { key: 'broadcast', label: t('应用到子目录') }
        ]

  // 智能文件名格式编辑状态
  const [editingNamingPattern, setEditingNamingPattern] = useState(false)
  const [namingPatternValue, setNamingPatternValue] = useState('')
  const [savingNamingPattern, setSavingNamingPattern] = useState(false)

  // AI分析策略编辑状态
  const [editingAnalysisStrategy, setEditingAnalysisStrategy] = useState(false)
  const [analysisStrategyValue, setAnalysisStrategyValue] = useState('')
  const [savingAnalysisStrategy, setSavingAnalysisStrategy] = useState(false)

  // 智能文件名附加属性（命名模板）编辑与操作状态
  const [editingNamingTemplate, setEditingNamingTemplate] = useState(false)
  const [namingTemplateValue, setNamingTemplateValue] = useState('')
  const [savingNamingTemplate, setSavingNamingTemplate] = useState(false)
  const [applyingTemplate, setApplyingTemplate] = useState(false)

  // 继承模式
  const inheritMode = ctx?.inheritMode || {
    analysisStrategy: 'inherit',
    namingPattern: 'inherit',
    namingTemplate: 'inherit'
  }
  const inheritedFrom = ctx?.inheritedFrom || {}

  const getEffectiveInheritMode = (
    field: 'analysisStrategy' | 'namingPattern' | 'namingTemplate'
  ): 'inherit' | 'current_only' | 'broadcast' => {
    const rawMode = inheritMode[field]
    if (isWorkspaceRoot) {
      return rawMode === 'current_only' ? 'current_only' : 'broadcast'
    }
    return rawMode || 'inherit'
  }

  const handleUpdateInheritMode = async (
    field: 'analysisStrategy' | 'namingPattern' | 'namingTemplate',
    mode: 'inherit' | 'current_only' | 'broadcast'
  ) => {
    try {
      await window.electronAPI!.updateDirectoryContextAnalysis(dirPath, {
        inheritMode: {
          [field]: mode
        }
      })
      toast.success(t('继承模式已更新'))
      if (onRefresh) onRefresh()
    } catch {
      toast.error(t('更新继承模式失败'))
    }
  }

  // 当 ctx 变化时同步编辑框的值
  useEffect(() => {
    if (ctx?.namingPattern) setNamingPatternValue(ctx.namingPattern)
    if (ctx?.analysisStrategy) setAnalysisStrategyValue(ctx.analysisStrategy)
    setNamingTemplateValue(ctx?.namingTemplate || '')
  }, [ctx?.namingPattern, ctx?.analysisStrategy, ctx?.namingTemplate])

  // 保存智能文件名格式
  const handleSaveNamingPattern = async () => {
    if (!dirPath || !namingPatternValue.trim()) return
    setSavingNamingPattern(true)
    try {
      await window.electronAPI!.updateDirectoryContextAnalysis(dirPath, {
        namingPattern: namingPatternValue.trim()
      })
      toast.success(t('智能文件名格式已更新'))
      setEditingNamingPattern(false)
      if (onRefresh) onRefresh()
    } catch (error: any) {
      logger.error(LogCategory.FILE_ANALYSIS, '更新智能文件名格式失败:', error)
      toast.error(t('保存失败，请重试'))
    } finally {
      setSavingNamingPattern(false)
    }
  }

  // 保存AI分析策略
  const handleSaveAnalysisStrategy = async () => {
    if (!dirPath || !analysisStrategyValue.trim()) return
    setSavingAnalysisStrategy(true)
    try {
      await window.electronAPI!.updateDirectoryContextAnalysis(dirPath, {
        analysisStrategy: analysisStrategyValue.trim()
      })
      toast.success(t('AI分析策略已更新'))
      setEditingAnalysisStrategy(false)
      if (onRefresh) onRefresh()
    } catch (error: any) {
      logger.error(LogCategory.FILE_ANALYSIS, '更新AI分析策略失败:', error)
      toast.error(t('保存失败，请重试'))
    } finally {
      setSavingAnalysisStrategy(false)
    }
  }

  // 保存智能文件名附加属性（命名模板）
  const handleSaveNamingTemplate = async (newVal?: string) => {
    if (!dirPath) return
    const valToSave = (newVal !== undefined ? newVal : namingTemplateValue).trim()
    setSavingNamingTemplate(true)
    try {
      await window.electronAPI!.updateDirectoryContextAnalysis(dirPath, {
        namingTemplate: valToSave
      })
      setNamingTemplateValue(valToSave)
      toast.success(t('智能文件名附加属性已更新'))
      setEditingNamingTemplate(false)
      if (onRefresh) onRefresh()
    } catch (error: any) {
      logger.error(LogCategory.FILE_ANALYSIS, '更新智能文件名附加属性失败:', error)
      toast.error(t('保存失败，请重试'))
    } finally {
      setSavingNamingTemplate(false)
    }
  }

  // 批量应用模板至该目录下所有已分析文件
  const handleApplyTemplateToFiles = async () => {
    if (!dirPath) return
    setApplyingTemplate(true)
    try {
      const res = await window.electronAPI!.applyDirectoryNamingTemplateToFiles(dirPath)
      if (res?.success) {
        toast.success(
          t('已成功将命名模板应用至 {count} 个已分析文件', {
            count: res.updatedCount
          })
        )
        if (onRefresh) onRefresh()
      }
    } catch (err: any) {
      logger.error(LogCategory.FILE_ANALYSIS, '批量应用命名模板失败:', err)
      toast.error(t('批量应用失败，请重试'))
    } finally {
      setApplyingTemplate(false)
    }
  }

  // 编辑按钮（增强显示 — 带背景和文字标签的醒目样式）
  const editButtonClass =
    'inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-border/60 bg-muted/40 hover:bg-primary/10 hover:border-primary/30 text-muted-foreground hover:text-primary text-xs font-medium transition-all duration-200 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'

  return (
    <>
      {/* 目录路径信息 */}
      <div className="border-t border-border pt-4 mb-6">
        <div className="text-sm space-y-2 text-muted-foreground">
          <div>
            <strong className="font-medium text-foreground">{t('路径:')}</strong>{' '}
            <span className="break-all">{analysisResult.path}</span>
          </div>
          <p>
            <strong className="font-medium text-foreground">{t('文件总数:')}</strong>{' '}
            {analysisResult.fileCount} {t('个')}
          </p>
          <p>
            <strong className="font-medium text-foreground">{t('已分析:')}</strong>{' '}
            {analysisResult.analyzedFileCount} {t('个')}
          </p>
          {analysisResult.lastScanAt && (
            <p>
              <strong className="font-medium text-foreground">{t('最后扫描:')}</strong>{' '}
              {formatDate(analysisResult.lastScanAt)}
            </p>
          )}
        </div>
      </div>

      {/* AI 分析策略 + 智能文件名格式 + 智能文件名附加属性 — 组合可编辑区块 */}
      {(ctx?.analysisStrategy || ctx?.namingPattern || ctx?.namingTemplate !== undefined || ctx) && !isUnit && (
        <div className="border-t border-border pt-4 mb-6 group/tooltip">
          <div className="relative">
            {/* 悬浮提示 */}
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full mb-2 px-3 py-1.5 bg-popover text-popover-foreground text-xs leading-relaxed rounded-md shadow-lg border border-border hidden group-hover/tooltip:block z-50 pointer-events-none whitespace-nowrap">
              {t('可通过目录画像再次自动生成')}
            </div>
            <div className="bg-primary/10 rounded-lg px-4 py-3 -mx-4 space-y-5">
              {ctx?.analysisStrategy && (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      {t('AI分析策略')}{' '}
                      {ctx.confidence !== undefined && ctx.confidence !== null && (
                        <span className="text-xs font-light text-muted-foreground ml-2">
                          {t('置信度: ')}
                          {(ctx.confidence * 100).toFixed(0)}%
                        </span>
                      )}
                    </h3>
                    <button
                      onClick={() => {
                        setAnalysisStrategyValue(ctx.analysisStrategy)
                        setEditingAnalysisStrategy(!editingAnalysisStrategy)
                      }}
                      className={editButtonClass}
                      title={t('编辑AI分析策略')}
                    >
                      <MaterialIcon
                        icon={editingAnalysisStrategy ? 'close' : 'edit'}
                        className="text-sm"
                      />
                      <span>{editingAnalysisStrategy ? t('取消') : t('编辑')}</span>
                    </button>
                  </div>

                  {/* 继承模式控制 */}
                  <div className="flex items-center gap-3 text-xs mb-2">
                    {inheritOptions.map(item => (
                      <label key={item.key} className="flex items-center gap-1 cursor-pointer select-none">
                        <input
                          type="radio"
                          name="inherit_analysis_strategy"
                          checked={getEffectiveInheritMode('analysisStrategy') === item.key}
                          onChange={() => handleUpdateInheritMode('analysisStrategy', item.key)}
                          className="accent-primary w-3 h-3"
                        />
                        <span
                          className={cn(
                            getEffectiveInheritMode('analysisStrategy') === item.key
                              ? 'text-primary font-medium'
                              : 'text-muted-foreground'
                          )}
                        >
                          {item.label}
                        </span>
                      </label>
                    ))}
                    {!isWorkspaceRoot &&
                      getEffectiveInheritMode('analysisStrategy') === 'inherit' &&
                      inheritedFrom?.analysisStrategy && (
                        <span
                          className="text-[10px] text-muted-foreground/70 truncate max-w-[120px]"
                          title={inheritedFrom.analysisStrategy}
                        >
                          ({t('源:')} {inheritedFrom.analysisStrategy.split(/[\\/]/).pop()})
                        </span>
                      )}
                  </div>

                  {editingAnalysisStrategy ? (
                    <div className="space-y-2">
                      <textarea
                        value={analysisStrategyValue}
                        onChange={e => setAnalysisStrategyValue(e.target.value)}
                        className="w-full text-sm text-foreground bg-background p-3 rounded-md border border-primary/40 focus:border-primary focus:ring-1 focus:ring-primary/30 whitespace-pre-wrap leading-relaxed resize-y min-h-[80px] outline-none transition-all duration-200"
                        rows={4}
                        autoFocus
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground/70">
                          <MaterialIcon
                            icon="info"
                            className="text-xs inline mr-1 align-text-top text-amber-500"
                          />
                          {t('影响AI文件分析结果如：标签、描述等')}
                        </span>
                        <div className="flex gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setEditingAnalysisStrategy(false)}
                            disabled={savingAnalysisStrategy}
                          >
                            {t('取消')}
                          </Button>
                          <Button
                            variant="default"
                            size="sm"
                            onClick={handleSaveAnalysisStrategy}
                            disabled={savingAnalysisStrategy || !analysisStrategyValue.trim()}
                          >
                            {savingAnalysisStrategy ? (
                              <>
                                <div className="animate-spin rounded-full h-3.5 w-3.5 border-t-2 border-b-2 border-current mr-1.5" />
                                {t('保存中')}
                              </>
                            ) : (
                              <>{t('保存')}</>
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="group relative">
                      <p className="text-sm text-foreground bg-background dark:bg-background/50  p-3 rounded-md border border-border/50 whitespace-pre-wrap leading-relaxed">
                        {ctx.analysisStrategy}
                      </p>
                    </div>
                  )}
                </>
              )}
              {ctx?.namingPattern && (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1">
                      <h3 className="text-sm font-semibold text-foreground">
                        {t('智能文件名格式')}
                      </h3>
                      <div className="relative group/help">
                        <MaterialIcon
                          icon="help_outline"
                          className="text-xs text-muted-foreground cursor-help"
                        />
                        {/* hover 说明：对此处配置作用的解释 */}
                        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 hidden group-hover/help:block z-50 w-56 p-2 bg-popover text-popover-foreground text-xs rounded-md shadow-lg border border-border leading-relaxed whitespace-normal pointer-events-none">
                          {t('此处的配置将影响该目录中文件的智能文件名命名格式')}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setNamingPatternValue(ctx.namingPattern)
                        setEditingNamingPattern(!editingNamingPattern)
                      }}
                      className={editButtonClass}
                      title={t('编辑智能文件名格式')}
                    >
                      <MaterialIcon
                        icon={editingNamingPattern ? 'close' : 'edit'}
                        className="text-sm"
                      />
                      <span>{editingNamingPattern ? t('取消') : t('编辑')}</span>
                    </button>
                  </div>

                  {/* 继承模式控制 */}
                  <div className="flex items-center gap-3 text-xs mb-2">
                    {inheritOptions.map(item => (
                      <label key={item.key} className="flex items-center gap-1 cursor-pointer select-none">
                        <input
                          type="radio"
                          name="inherit_naming_pattern"
                          checked={getEffectiveInheritMode('namingPattern') === item.key}
                          onChange={() => handleUpdateInheritMode('namingPattern', item.key)}
                          className="accent-primary w-3 h-3"
                        />
                        <span
                          className={cn(
                            getEffectiveInheritMode('namingPattern') === item.key
                              ? 'text-primary font-medium'
                              : 'text-muted-foreground'
                          )}
                        >
                          {item.label}
                        </span>
                      </label>
                    ))}
                    {!isWorkspaceRoot &&
                      getEffectiveInheritMode('namingPattern') === 'inherit' &&
                      inheritedFrom?.namingPattern && (
                        <span
                          className="text-[10px] text-muted-foreground/70 truncate max-w-[120px]"
                          title={inheritedFrom.namingPattern}
                        >
                          ({t('源:')} {inheritedFrom.namingPattern.split(/[\\/]/).pop()})
                        </span>
                      )}
                  </div>

                  {editingNamingPattern ? (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={namingPatternValue}
                        onChange={e => setNamingPatternValue(e.target.value)}
                        placeholder={t('[领域]内容描述')}
                        className="w-full text-sm text-foreground bg-background px-3 py-2 rounded-md border border-primary/40 focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none transition-all duration-200"
                        autoFocus
                      />
                      <div className="flex items-center justify-between">
                        <div className="relative group/inputhelp cursor-help flex items-center gap-1 text-xs text-muted-foreground/70">
                          <MaterialIcon icon="info" className="text-xs text-amber-500" />
                          <span className="underline decoration-dotted underline-offset-2">
                            {t('查看格式要求')}
                          </span>
                          <div className="absolute left-0 bottom-full mb-1.5 hidden group-hover/inputhelp:block z-50 w-72 p-3 bg-popover text-popover-foreground text-xs rounded-md shadow-xl border border-border leading-relaxed whitespace-normal space-y-1.5 pointer-events-none">
                            <div className="font-medium text-foreground">
                              {t('智能文件名格式要求')}：
                            </div>
                            <div className="text-muted-foreground text-[11px]">
                              {t(
                                '支持以下命名规则（领域/特征可为题材、作者名、系列名、年份、序号、格式、原文件名等）：'
                              )}
                            </div>
                            <ul className="list-disc list-inside text-[11px] text-muted-foreground/90 space-y-0.5 font-mono">
                              <li>
                                [{t('作者')}]{t('内容描述')} / [{t('领域')}]{t('内容描述')}
                              </li>
                              <li>
                                [{t('题材')}]{t('作者')}_{t('内容描述')}
                              </li>
                              <li>
                                {t('作者')}_{t('内容描述')} / {t('领域')}_{t('内容描述')}
                              </li>
                              <li>
                                {t('作者')}_{t('年份')}_{t('内容描述')}
                              </li>
                              <li>
                                {t('分类')}_{t('作者')}_{t('年份')}_{t('内容描述')}
                              </li>
                              <li>{t('内容描述')}</li>
                            </ul>

                            <div className="text-[10px] text-amber-500/90 pt-1 border-t border-border/40">
                              * {t('不符合格式要求的规则将自动还原为默认值')}[{t('领域')}]
                              {t('内容描述')}
                            </div>
                          </div>
                        </div>

                        <div className="flex gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setEditingNamingPattern(false)}
                            disabled={savingNamingPattern}
                          >
                            {t('取消')}
                          </Button>
                          <Button
                            variant="default"
                            size="sm"
                            onClick={handleSaveNamingPattern}
                            disabled={savingNamingPattern || !namingPatternValue.trim()}
                          >
                            {savingNamingPattern ? (
                              <>
                                <div className="animate-spin rounded-full h-3.5 w-3.5 border-t-2 border-b-2 border-current mr-1.5" />
                                {t('保存中')}
                              </>
                            ) : (
                              <>{t('保存')}</>
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="group relative">
                      <div className="text-sm text-foreground bg-background dark:bg-background/50 p-3 rounded-md border border-border/50 whitespace-pre-wrap leading-relaxed">
                        <PersistentTooltip
                          id="directory_naming_pattern_hint"
                          content={t('请优先配置，影响文件智能命名')}
                          position="bottom"
                          delay={1000}
                        >
                          {ctx.namingPattern}
                        </PersistentTooltip>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* 智能文件名附加属性 (namingTemplate) */}
              <div className="border-t border-border/40 pt-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1">
                    <h3 className="text-sm font-semibold text-foreground">
                      {t('智能文件名附加属性')}
                    </h3>
                    <div className="relative group/help">
                      <MaterialIcon
                        icon="help_outline"
                        className="text-xs text-muted-foreground cursor-help"
                      />
                      <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 hidden group-hover/help:block z-50 w-64 p-2 bg-popover text-popover-foreground text-xs rounded-md shadow-lg border border-border leading-relaxed whitespace-normal pointer-events-none">
                        {t('选择批量更名预设模板，在文件分析完毕后自动按该模板渲染生成最终智能文件名')}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">


                    {/* 自定义编辑切换按钮 */}
                    <button
                      onClick={() => {
                        setNamingTemplateValue(ctx?.namingTemplate || '')
                        setEditingNamingTemplate(!editingNamingTemplate)
                      }}
                      className={editButtonClass}
                      title={t('手动编辑模板表达式')}
                    >
                      <MaterialIcon
                        icon={editingNamingTemplate ? 'close' : 'edit'}
                        className="text-sm"
                      />
                      <span>{editingNamingTemplate ? t('取消') : t('自定义')}</span>
                    </button>
                  </div>
                </div>

                {/* 继承模式控制 */}
                <div className="flex items-center gap-3 text-xs mb-2">
                  {inheritOptions.map(item => (
                    <label key={item.key} className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="radio"
                        name="inherit_naming_template"
                        checked={getEffectiveInheritMode('namingTemplate') === item.key}
                        onChange={() => handleUpdateInheritMode('namingTemplate', item.key)}
                        className="accent-primary w-3 h-3"
                      />
                      <span
                        className={cn(
                          getEffectiveInheritMode('namingTemplate') === item.key
                            ? 'text-primary font-medium'
                            : 'text-muted-foreground'
                        )}
                      >
                        {item.label}
                      </span>
                    </label>
                  ))}
                  {!isWorkspaceRoot &&
                    getEffectiveInheritMode('namingTemplate') === 'inherit' &&
                    inheritedFrom?.namingTemplate && (
                      <span
                        className="text-[10px] text-muted-foreground/70 truncate max-w-[120px]"
                        title={inheritedFrom.namingTemplate}
                      >
                        ({t('源:')} {inheritedFrom.namingTemplate.split(/[\\/]/).pop()})
                      </span>
                    )}
                </div>

                {editingNamingTemplate ? (
                  /* 自定义 DSL 输入编辑框 */
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={namingTemplateValue}
                      onChange={e => setNamingTemplateValue(e.target.value)}
                      placeholder={t('例如: [{TAG:文件类型}]{SMART_NAME}_{MOD:YYYY-MM-DD}')}
                      className="w-full font-mono text-xs text-foreground bg-background px-3 py-2 rounded-md border border-primary/40 focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none transition-all duration-200"
                      autoFocus
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground/70">
                        <MaterialIcon icon="code" className="text-xs inline mr-1 text-primary" />
                        {t('支持 {SMART_NAME}、{TAG:xxx}、{MOD:xxx} 等 DSL 标签')}
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setEditingNamingTemplate(false)}
                          disabled={savingNamingTemplate}
                        >
                          {t('取消')}
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => handleSaveNamingTemplate()}
                          disabled={savingNamingTemplate}
                        >
                          {savingNamingTemplate ? (
                            <>
                              <div className="animate-spin rounded-full h-3.5 w-3.5 border-t-2 border-b-2 border-current mr-1.5" />
                              {t('保存中')}
                            </>
                          ) : (
                            <>{t('保存')}</>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  /* 下拉选择菜单与当前模板展示 */
                  <div className="space-y-2">
                    <div className="relative">
                      <select
                        value={
                          !namingTemplateValue
                            ? '__NONE__'
                            : presetTemplates.some(p => p.template === namingTemplateValue)
                            ? namingTemplateValue
                            : '__CUSTOM__'
                        }
                        onChange={e => {
                          const sel = e.target.value
                          if (sel === '__NONE__') {
                            handleSaveNamingTemplate('')
                          } else if (sel === '__CUSTOM__') {
                            setEditingNamingTemplate(true)
                          } else {
                            handleSaveNamingTemplate(sel)
                          }
                        }}
                        className="w-full h-9 text-xs text-foreground bg-background px-3 py-1.5 rounded-md border border-border/60 hover:border-primary/50 focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none transition-all duration-150 cursor-pointer truncate"
                      >
                        <option value="__NONE__">{t('不使用附加模板 (仅保留原始智能名)')}</option>
                        {presetTemplates.map((preset, pIdx) => (
                          <option key={pIdx} value={preset.template}>
                            {preset.name} - {preset.template}
                          </option>
                        ))}
                        {namingTemplateValue &&
                          !presetTemplates.some(p => p.template === namingTemplateValue) && (
                            <option value="__CUSTOM__">
                              {t('自定义')}: {namingTemplateValue}
                            </option>
                          )}
                      </select>
                    </div>

                    {namingTemplateValue ? (
                      <div className="flex items-center justify-between text-[11px] font-mono px-3 py-1.5 rounded bg-muted/40 text-muted-foreground border border-border/40">
                        <span className="truncate" title={namingTemplateValue}>
                          {t('当前模板:')} <span className="text-foreground font-medium">{namingTemplateValue}</span>
                        </span>
                      </div>
                    ) : (
                      <div className="text-[11px] text-muted-foreground/60 italic px-1">
                        {t('未启用附加模板，将直接采用 AI 输出的智能文件名')}
                      </div>
                    )}
                                        {/* 一键应用至已分析文件按钮 */}
                    <button
                      type="button"
                      onClick={handleApplyTemplateToFiles}
                      disabled={applyingTemplate}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-primary/40 bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium transition-all duration-200 disabled:opacity-50 cursor-pointer"
                      title={t('为当前目录下已分析文件重新应用该命名模板')}
                    >
                      <MaterialIcon
                        icon={applyingTemplate ? 'sync' : 'auto_fix_high'}
                        className={cn('text-sm', applyingTemplate && 'animate-spin')}
                      />
                      <span>{applyingTemplate ? t('应用中...') : t('应用至已分析文件')}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 推荐标签 */}
      {ctx?.recommendedTags && Object.keys(ctx.recommendedTags).length > 0 && (
        <div className="border-t border-border pt-4 mb-6">
          <h3 className="text-sm font-semibold mb-3 text-foreground">{t('推荐标签')}</h3>
          <div className="space-y-3">
            {Object.entries(ctx.recommendedTags).map(
              ([dimension, tags]: [string, any], dimIdx: number) => (
                <div key={dimIdx}>
                  <p className="text-xs font-medium text-foreground mb-1.5">{dimension}:</p>
                  <div className="flex flex-wrap gap-2">
                    {Array.isArray(tags) &&
                      tags.map((tag: string, tagIdx: number) => (
                        <span
                          key={tagIdx}
                          className={cn(
                            'text-xs px-3 py-1.5 rounded-full font-medium',
                            getTagColor(dimIdx * 10 + tagIdx)
                          )}
                        >
                          {tag}
                        </span>
                      ))}
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* 文件类型分布 */}
      {ctx?.fileTypeDistribution && Object.keys(ctx.fileTypeDistribution).length > 0 && (
        <div className="border-t border-border pt-4 mb-6">
          <h3 className="text-sm font-semibold mb-3 text-foreground">{t('文件类型分布')}</h3>
          <div className="space-y-2">
            {Object.entries(ctx.fileTypeDistribution as Record<string, number>)
              .sort(([, a], [, b]) => b - a)
              .map(([type, count], idx) => {
                const total = Object.values(
                  ctx.fileTypeDistribution as Record<string, number>
                ).reduce((sum: number, c: number) => sum + c, 0)
                const percentage = total > 0 ? (count / total) * 100 : 0
                return (
                  <div key={idx} className="flex items-center text-xs text-muted-foreground">
                    <span className="w-20 capitalize">{type}</span>
                    <div className="flex-1 mx-2 min-w-0">
                      <ProgressBar
                        value={count}
                        max={total}
                        className="h-1.5"
                        colorClass="bg-primary"
                      />
                    </div>
                    <span className="w-16 text-right">
                      {count} ({percentage.toFixed(0)}%)
                    </span>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {/* 目录特征 - 元数据：特殊文件、分析时间 */}
      {ctx && (
        <div className="border-t border-border pt-4 mb-6">
          <div className="text-sm space-y-2 text-muted-foreground">
            {ctx.specialFiles && ctx.specialFiles.length > 0 && (
              <div>
                <strong className="font-medium text-foreground">{t('特殊文件:')}</strong>
                <div className="flex flex-wrap gap-2 mt-1">
                  {Array.isArray(ctx.specialFiles) &&
                    ctx.specialFiles.map((file: string, idx: number) => (
                      <span
                        key={idx}
                        className="text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 px-2 py-1 rounded font-mono"
                      >
                        {file}
                      </span>
                    ))}
                </div>
              </div>
            )}
            {ctx.analyzedAt && (
              <p>
                <strong className="font-medium text-foreground">{t('分析时间:')}</strong>{' '}
                {formatDate(ctx.analyzedAt)}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  )
}
