import React, { useState, useEffect } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { ProgressBar } from '../../../ui/ProgressBar'
import { toast } from '../../../common/Toast'
import { Button } from '../../../ui/button'
import { LogCategory, logger } from '@firefly/shared'
import { PersistentTooltip } from '../../../common/PersistentTooltip'

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
}> = ({ analysisResult, isDirAnalysis, getTagColor, formatDate, onRefresh, isUnit }) => {
  if (!analysisResult || !isDirAnalysis(analysisResult)) return null

  const ctx = analysisResult.contextAnalysis
  const dirPath = analysisResult.path

  // 智能文件名格式编辑状态
  const [editingNamingPattern, setEditingNamingPattern] = useState(false)
  const [namingPatternValue, setNamingPatternValue] = useState('')
  const [savingNamingPattern, setSavingNamingPattern] = useState(false)

  // AI分析策略编辑状态
  const [editingAnalysisStrategy, setEditingAnalysisStrategy] = useState(false)
  const [analysisStrategyValue, setAnalysisStrategyValue] = useState('')
  const [savingAnalysisStrategy, setSavingAnalysisStrategy] = useState(false)

  // 当 ctx 变化时同步编辑框的值
  useEffect(() => {
    if (ctx?.namingPattern) setNamingPatternValue(ctx.namingPattern)
    if (ctx?.analysisStrategy) setAnalysisStrategyValue(ctx.analysisStrategy)
  }, [ctx?.namingPattern, ctx?.analysisStrategy])

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

      {/* AI 分析策略 + 智能文件名格式 — 组合可编辑区块 */}
      {(ctx?.analysisStrategy || ctx?.namingPattern) && !isUnit && (
        <div className="border-t border-border pt-4 mb-6 group/tooltip">
          <div className="relative">
            {/* 悬浮提示 */}
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full mb-2 px-3 py-1.5 bg-popover text-popover-foreground text-xs leading-relaxed rounded-md shadow-lg border border-border hidden group-hover/tooltip:block z-50 pointer-events-none whitespace-nowrap">
              {t('可通过目录画像再次自动生成')}
            </div>
            <div className="bg-primary/10 rounded-lg px-4 py-3 -mx-4 space-y-5">
              {ctx?.analysisStrategy && (
                <>
                  <div className="flex items-center justify-between mb-3">
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
                      {/* 悬停提示条 */}
                      <div className="absolute -top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <span className="text-[10px] text-muted-foreground bg-popover px-2 py-0.5 rounded shadow-sm border border-border/50 whitespace-nowrap">
                          <MaterialIcon icon="edit" className="text-[10px] inline mr-0.5" />
                          {t('点击编辑')}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}
              {ctx?.namingPattern && (
                <>
                  <div className="flex items-center justify-between mb-3">
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
                      {/* 悬停提示条 */}
                      <div className="absolute -top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <span className="text-[10px] text-muted-foreground bg-popover px-2 py-0.5 rounded shadow-sm border border-border/50 whitespace-nowrap">
                          <MaterialIcon icon="edit" className="text-[10px] inline mr-0.5" />
                          {t('点击编辑')}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}
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
