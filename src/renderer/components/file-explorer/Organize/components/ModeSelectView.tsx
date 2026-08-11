import React from 'react'
import { OrganizeMode } from '../types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'

export function ModeSelectView({
  onSelectMode,
  hasVirtualDirectories = false,
  virtualDirectories = [],
  onSelectIncrementalVd,
  onSelectDraftVDir,
  onDeleteDraftVDir
}: {
  organizeMode?: OrganizeMode
  onSelectMode: (mode: OrganizeMode) => void
  hasVirtualDirectories?: boolean
  virtualDirectories?: Array<{
    id: number
    name: string
    source?: string
    fileCount?: number
    unclassifiedCount?: number
    dirCount?: number
    directoryCount?: number
  }>
  onSelectIncrementalVd?: (vdId: number) => void
  onSelectDraftVDir?: (vdId: number) => void
  onDeleteDraftVDir?: (vdId: number) => void
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-10 overflow-y-auto relative w-full h-full">
      {/* 渐变高光背景氛围层 */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden select-none">
        <div
          className="absolute -top-40 -right-40 w-[600px] h-[600px] bg-amber-500/8 dark:bg-amber-500/12 rounded-full blur-[120px] animate-pulse"
          style={{ animationDuration: '8s' }}
        />
        <div
          className="absolute -bottom-40 -left-40 w-[600px] h-[600px] bg-indigo-500/8 dark:bg-indigo-500/12 rounded-full blur-[120px] animate-pulse"
          style={{ animationDuration: '10s', animationDelay: '2s' }}
        />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-primary/[0.03] dark:bg-primary/[0.06] rounded-full blur-[140px]" />
      </div>

      <div className="relative w-full max-w-5xl my-auto space-y-8 z-10">
        {/* 标题区域 */}
        <div className="text-center space-y-2.5 relative">
          <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight bg-gradient-to-r from-foreground via-foreground/90 to-foreground/70 bg-clip-text text-transparent">
            {t('选择整理模式')}
          </h2>
        </div>

        {/* 模式选择网格 */}
        <div className="space-y-7">
          {/* ==================== 分组 1：新建整理方案 (直出/精细组) ==================== */}
          <div className="space-y-3.5">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 flex items-center gap-1">
                  <MaterialIcon icon="auto_awesome" className="text-xs" />
                  {t('新建整理')}
                </span>
                <h3 className="text-sm font-bold text-foreground/90">
                  {t('从零开始构建全新的虚拟目录')}
                </h3>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4.5">
              {/* 快速整理 (骨架直出) — 无默认选中态，hover 高亮 */}
              <div
                onClick={() => onSelectMode('fast-organize')}
                className="group relative cursor-pointer rounded-2xl p-5 border bg-card/80 backdrop-blur-xs border-border/60 hover:border-emerald-500/60 hover:bg-emerald-500/[0.02] hover:-translate-y-1 hover:shadow-xl hover:shadow-emerald-500/5 transition-all duration-300 flex flex-col justify-between select-none overflow-hidden focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-300 bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 group-hover:bg-gradient-to-br group-hover:from-emerald-500 group-hover:to-teal-600 group-hover:text-white group-hover:shadow-md group-hover:shadow-emerald-500/20 group-hover:scale-105">
                      <MaterialIcon icon="bolt" className="text-xl" />
                    </div>
                    <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 rounded-full border border-emerald-500/20 flex items-center gap-1">
                      <MaterialIcon icon="speed" className="text-xs" />
                      {t('推荐 · 极速分类')}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors flex items-center gap-2">
                      {t('快速整理')}
                      <span className="text-xs text-muted-foreground font-normal">
                        ({t('骨架直出')})
                      </span>
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      {t(
                        '基于现有的高频标签命名目录，对于命中标签的文件无需AI归类。特别适合海量文件快速整理。'
                      )}
                    </p>
                  </div>

                  <div className="pt-3 border-t border-border/40 grid grid-cols-2 gap-2.5 text-[11px] text-muted-foreground font-medium">
                    {[
                      t('无需AI漫长推理'),
                      t('生成大纲即完成分类'),
                      t('适合海量文件整理'),
                      t('分类体验顺畅极致')
                    ].map((feat, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <MaterialIcon
                          icon="check_circle"
                          className="text-xs text-emerald-500 shrink-0"
                        />
                        <span>{feat}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 精细整理 (AI深度推理) — 无默认选中态，hover 高亮 */}
              <div
                onClick={() => onSelectMode('fine-organize')}
                className="group relative cursor-pointer rounded-2xl p-5 border bg-card/80 backdrop-blur-xs border-border/60 hover:border-purple-500/60 hover:bg-purple-500/[0.02] hover:-translate-y-1 hover:shadow-xl hover:shadow-purple-500/5 transition-all duration-300 flex flex-col justify-between select-none overflow-hidden focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-300 bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-400 group-hover:bg-gradient-to-br group-hover:from-purple-500 group-hover:to-indigo-600 group-hover:text-white group-hover:shadow-md group-hover:shadow-purple-500/20 group-hover:scale-105">
                      <MaterialIcon icon="psychology" className="text-xl" />
                    </div>
                    <span className="text-[11px] font-bold text-purple-600 dark:text-purple-400 bg-purple-500/10 px-2.5 py-0.5 rounded-full border border-purple-500/20 flex items-center gap-1">
                      <MaterialIcon icon="auto_awesome" className="text-xs" />
                      {t('高精准度')}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-foreground group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors flex items-center gap-2">
                      {t('精细整理')}
                      <span className="text-xs text-muted-foreground font-normal">
                        ({t('AI深度分析')})
                      </span>
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      {t(
                        '调用大语言模型对每个文件逐一进行语义分析和深度推理，精准匹配最佳归类路径。适合要求极高的精准文档分类。'
                      )}
                    </p>
                  </div>

                  <div className="pt-3 border-t border-border/40 grid grid-cols-2 gap-2.5 text-[11px] text-muted-foreground font-medium">
                    {[
                      t('AI分批文件推理'),
                      t('精准语义归类匹配'),
                      t('适合重要文档归档'),
                      t('分类准确度极高')
                    ].map((feat, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <MaterialIcon
                          icon="check_circle"
                          className="text-xs text-purple-500 shrink-0"
                        />
                        <span>{feat}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ==================== 分组 2：修改已有目录 (编辑/更新组) ==================== */}
          <div className="space-y-3.5 mt-20">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                  <MaterialIcon icon="edit_document" className="text-xs" />
                  {t('修改/更新')}
                </span>
                <h3 className="text-sm font-bold text-foreground/90">
                  {t('修改与追加已有草稿和虚拟目录')}
                </h3>
              </div>
            </div>

            {hasVirtualDirectories && virtualDirectories.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5">
                {virtualDirectories.map(vd => {
                  const isDraft = vd.source === 'draft'
                  return (
                    <div
                      key={vd.id}
                      onClick={() => {
                        if (isDraft) {
                          onSelectDraftVDir?.(vd.id)
                        } else {
                          onSelectMode('incremental-organize')
                          onSelectIncrementalVd?.(vd.id)
                        }
                      }}
                      className={cn(
                        'group relative cursor-pointer rounded-xl p-4 transition-all duration-200 flex items-center justify-between select-none',
                        isDraft
                          ? 'border border-dashed border-amber-500/10 hover:border-amber-500/30 bg-amber-500/[0.04] hover:bg-amber-500/[0.08] hover:-translate-y-0.5 opacity-50 hover:opacity-100'
                          : 'border bg-card/80 backdrop-blur-xs border-border/60 hover:border-emerald-500/60 hover:bg-emerald-500/[0.03] hover:-translate-y-0.5 hover:shadow-md hover:shadow-emerald-500/5'
                      )}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                        <div
                          className={cn(
                            'w-9 h-9 rounded-lg flex items-center justify-center border shrink-0 transition-colors',
                            isDraft
                              ? 'bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400 group-hover:bg-amber-500 group-hover:text-white'
                              : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 group-hover:bg-emerald-500 group-hover:text-white'
                          )}
                        >
                          <MaterialIcon
                            icon={isDraft ? 'edit_note' : 'folder'}
                            className="text-lg"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              'text-sm font-bold text-foreground truncate',
                              isDraft
                                ? 'group-hover:text-amber-600 dark:group-hover:text-amber-400'
                                : 'group-hover:text-emerald-600 dark:group-hover:text-emerald-400'
                            )}
                          >
                            {vd.name}
                          </p>
                          {isDraft ? (
                            <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
                              <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 shrink-0">
                                {t('草稿')}
                              </span>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {t('未保存草稿 · 点击恢复')}
                              </p>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 min-w-0 mt-0.5 text-[11px] text-muted-foreground truncate">
                              <span>
                                <span className="font-semibold text-foreground">
                                  {vd.dirCount ?? vd.directoryCount ?? 0}
                                </span>{' '}
                                {t('个目录')}
                              </span>
                              <span className="opacity-30">•</span>
                              <span>
                                {t('未归类')}{' '}
                                <span className="font-semibold text-amber-600 dark:text-amber-400">
                                  {vd.unclassifiedCount ?? 0}
                                </span>{' '}
                                {t('个')}
                              </span>
                              <span className="opacity-30">•</span>
                              <span>
                                {t('共')}{' '}
                                <span className="font-semibold text-foreground">
                                  {vd.fileCount ?? 0}
                                </span>{' '}
                                {t('个文件')}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      {isDraft && (
                        <button
                          type="button"
                          title={t('删除草稿')}
                          onClick={e => {
                            e.stopPropagation()
                            onDeleteDraftVDir?.(vd.id)
                          }}
                          className="absolute -top-2.5 -right-2.5 w-5 h-5 rounded-full bg-background dark:bg-card border border-amber-500/50 text-muted-foreground/70 hover:text-red-500 hover:border-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all duration-200 shadow-md flex items-center justify-center z-20"
                        >
                          <MaterialIcon icon="close" className="text-[11px]" />
                        </button>
                      )}

                      <MaterialIcon
                        icon="arrow_forward_ios"
                        className={cn(
                          'text-xs text-muted-foreground/40 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200',
                          isDraft ? 'group-hover:text-amber-500' : 'group-hover:text-emerald-500'
                        )}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="bg-card/80 backdrop-blur-xs border border-border/60 rounded-2xl p-6 text-center space-y-2">
                <div className="w-10 h-10 rounded-full bg-muted/40 flex items-center justify-center mx-auto text-muted-foreground">
                  <MaterialIcon icon="folder_off" className="text-xl" />
                </div>
                <h4 className="text-sm font-bold text-foreground">{t('暂无已保存的虚拟目录')}</h4>
                <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
                  {t(
                    '增量整理用于在已有虚拟目录的基础上追加新文件。您当前工作区尚未保存任何虚拟目录，请先从上方选择“快速整理”或“精细整理”完成并保存虚拟目录。'
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
