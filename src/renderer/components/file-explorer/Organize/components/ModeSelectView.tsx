import React from 'react'
import { OrganizeMode } from '../types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { useSettingsStore } from '../../../../stores/settings-store'
import { toast } from '../../../common/Toast'

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
  const aiServiceMode = useSettingsStore(s => s.config?.aiServiceMode) ?? 'local'
  const isAdvancedAiEnabled = aiServiceMode !== 'disabled'

  return (
    <div className="flex-1 overflow-y-auto w-full h-full">
      <div className="w-full max-w-5xl mx-auto px-6 py-6 md:py-8 space-y-6">
        {/* 标题区域 */}
        <div className="text-center space-y-1.5">
          <h2 className="text-xl md:text-2xl font-extrabold tracking-tight bg-gradient-to-r from-foreground via-foreground/90 to-foreground/70 bg-clip-text text-transparent">
            {t('选择整理模式')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('根据文件特征与整理诉求选择适合的路径，高效构建清晰有序的目录体系')}
          </p>
        </div>

        {/* 模式选择网格 */}
        <div className="space-y-6">
          {/* ==================== 分组 1：新建整理方案 (精炼自适应网格) ==================== */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-0.5">
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 flex items-center gap-1">
                <MaterialIcon icon="auto_awesome" className="text-xs" />
                {t('新建整理')}
              </span>
              <h3 className="text-xs font-bold text-foreground/80">
                {t('从零开始构建全新的虚拟目录')}
              </h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {/* 1. 身份蓝图 (推荐 · 琥珀金) */}
              <div
                onClick={() => onSelectMode('identity-blueprint')}
                className="group relative cursor-pointer rounded-xl p-4 border-2 bg-card/90 backdrop-blur-xs border-amber-500/40 hover:border-amber-500/80 hover:bg-amber-500/[0.03] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-amber-500/10 transition-all duration-200 flex flex-col justify-between select-none overflow-hidden"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center border transition-all duration-200 bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400 group-hover:bg-gradient-to-br group-hover:from-amber-500 group-hover:to-orange-600 group-hover:text-white group-hover:shadow-sm group-hover:scale-105 shrink-0">
                      <MaterialIcon icon="psychology" className="text-lg" />
                    </div>
                    <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded-full border border-amber-500/30 flex items-center gap-1 shadow-2xs shrink-0">
                      <MaterialIcon icon="star" className="text-[11px] text-amber-500" />
                      {t('推荐')}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-sm font-bold text-foreground group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors flex items-center gap-1.5">
                      {t('身份蓝图')}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                      {t('基于权威职业与生活角色库，精准推荐量身定制的标准目录结构与多候选路径。')}
                    </p>
                  </div>
                </div>
              </div>

              {/* 2. 外部AI生成目录结构 (借力外部AI · 青色) */}
              <div
                onClick={() => onSelectMode('external-ai')}
                className="group relative cursor-pointer rounded-xl p-4 border bg-card/80 backdrop-blur-xs border-border/60 hover:border-cyan-500/60 hover:bg-cyan-500/[0.02] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-cyan-500/5 transition-all duration-200 flex flex-col justify-between select-none overflow-hidden"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center border transition-all duration-200 bg-cyan-500/10 border-cyan-500/20 text-cyan-600 dark:text-cyan-400 group-hover:bg-gradient-to-br group-hover:from-cyan-500 group-hover:to-teal-600 group-hover:text-white group-hover:shadow-sm group-hover:scale-105 shrink-0">
                      <MaterialIcon icon="travel_explore" className="text-lg" />
                    </div>
                    <span className="text-[10px] font-bold text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded-full border border-cyan-500/20 flex items-center gap-1 shrink-0">
                      <MaterialIcon icon="open_in_browser" className="text-[11px]" />
                      {t('借力外部AI')}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-sm font-bold text-foreground group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors flex items-center gap-1.5">
                      {t('外部AI生成目录结构')}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                      {t('一键复制当前文件画像提示词至豆包/ChatGPT/Kimi规划目录，支持极速导入。')}
                    </p>
                  </div>
                </div>
              </div>

              {/* 3. 智能聚类 (极速直出 · 蓝色) */}
              <div
                onClick={() => onSelectMode('smart-clustering')}
                className="group relative cursor-pointer rounded-xl p-4 border bg-card/80 backdrop-blur-xs border-border/60 hover:border-blue-500/60 hover:bg-blue-500/[0.02] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-blue-500/5 transition-all duration-200 flex flex-col justify-between select-none overflow-hidden"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center border transition-all duration-200 bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400 group-hover:bg-gradient-to-br group-hover:from-blue-500 group-hover:to-cyan-600 group-hover:text-white group-hover:shadow-sm group-hover:scale-105 shrink-0">
                      <MaterialIcon icon="hub" className="text-lg" />
                    </div>
                    <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full border border-blue-500/20 flex items-center gap-1 shrink-0">
                      <MaterialIcon icon="speed" className="text-[11px]" />
                      {t('极速直出')}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-sm font-bold text-foreground group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors flex items-center gap-1.5">
                      {t('智能聚类')}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                      {t('端侧原生无监督层次聚类，毫秒级即时出图，支持自然语言提示词引导与内联微调。')}
                    </p>
                  </div>
                </div>
              </div>

              {/* 4. 由文件推导目录树 (高级 AI · 紫色) */}
              <div
                onClick={() => {
                  if (!isAdvancedAiEnabled) {
                    toast.info(t('由文件推导目录树需要高级AI引擎支持，请前往“设置 -> AI引擎配置”开启'))
                    return
                  }
                  onSelectMode('fine-organize')
                }}
                className={cn(
                  'group relative rounded-xl p-4 border transition-all duration-200 flex flex-col justify-between select-none overflow-hidden',
                  isAdvancedAiEnabled
                    ? 'cursor-pointer bg-card/80 backdrop-blur-xs border-border/60 hover:border-purple-500/60 hover:bg-purple-500/[0.02] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-purple-500/5'
                    : 'cursor-not-allowed opacity-60 bg-muted/20 border-border/40'
                )}
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div
                      className={cn(
                        'w-9 h-9 rounded-lg flex items-center justify-center border transition-all duration-200 shrink-0',
                        isAdvancedAiEnabled
                          ? 'bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-400 group-hover:bg-gradient-to-br group-hover:from-purple-500 group-hover:to-indigo-600 group-hover:text-white group-hover:shadow-sm group-hover:scale-105'
                          : 'bg-muted border-border/40 text-muted-foreground'
                      )}
                    >
                      <MaterialIcon icon="auto_stories" className="text-lg" />
                    </div>
                    {isAdvancedAiEnabled ? (
                      <span className="text-[10px] font-bold text-purple-600 dark:text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-full border border-purple-500/20 flex items-center gap-1 shrink-0">
                        <MaterialIcon icon="bolt" className="text-[11px]" />
                        {t('需高级AI引擎')}
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-full border border-border/60 flex items-center gap-1 shrink-0">
                        <MaterialIcon icon="lock" className="text-[11px]" />
                        {t('需开启高级AI引擎')}
                      </span>
                    )}
                  </div>

                  <div>
                    <h4
                      className={cn(
                        'text-sm font-bold transition-colors flex items-center gap-1.5',
                        isAdvancedAiEnabled
                          ? 'text-foreground group-hover:text-purple-600 dark:group-hover:text-purple-400'
                          : 'text-muted-foreground'
                      )}
                    >
                      {t('由文件推导目录树')}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                      {t('由大模型端到端深度规划 3 套最终完整的层级目录树方案，无需繁琐步骤直接比选。')}
                    </p>
                    {isAdvancedAiEnabled && (
                      <p className="text-[10px] text-purple-600 dark:text-purple-400 mt-1 flex items-center gap-1 font-medium truncate">
                        <MaterialIcon icon="info" className="text-[11px] shrink-0" />
                        <span className="truncate">{t('建议使用“高中生”级别以上的模型才能获取较好效果')}</span>
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* 5. 自定义目录树 (灵活自由 · 翡翠绿) */}
              <div
                onClick={() => onSelectMode('custom-tree')}
                className="group relative cursor-pointer rounded-xl p-4 border bg-card/80 backdrop-blur-xs border-border/60 hover:border-emerald-500/60 hover:bg-emerald-500/[0.02] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-emerald-500/5 transition-all duration-200 flex flex-col justify-between select-none overflow-hidden"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center border transition-all duration-200 bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 group-hover:bg-gradient-to-br group-hover:from-emerald-500 group-hover:to-teal-600 group-hover:text-white group-hover:shadow-sm group-hover:scale-105 shrink-0">
                      <MaterialIcon icon="account_tree" className="text-lg" />
                    </div>
                    <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 flex items-center gap-1 shrink-0">
                      <MaterialIcon icon="bolt" className="text-[11px]" />
                      {t('灵活自由')}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-sm font-bold text-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors flex items-center gap-1.5">
                      {t('自定义目录树')}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                      {t('直接手写或粘贴 Markdown 格式目录大纲，右侧实时语法解析，端侧秒级向量归类。')}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ==================== 分组 2：修改已有目录 (编辑/更新组，轻量紧凑) ==================== */}
          <div className="pt-4 border-t border-border/50 space-y-3">
            <div className="flex items-center justify-between px-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                  <MaterialIcon icon="edit_document" className="text-xs" />
                  {t('修改/更新')}
                </span>
                <h3 className="text-xs font-bold text-foreground/80">
                  {t('修改与追加已有草稿和虚拟目录')}
                </h3>
              </div>
            </div>

            {hasVirtualDirectories && virtualDirectories.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
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
                        'group relative cursor-pointer rounded-xl p-3.5 transition-all duration-200 flex items-center justify-between select-none',
                        isDraft
                          ? 'border border-dashed border-amber-500/30 hover:border-amber-500/60 bg-amber-500/[0.04] hover:bg-amber-500/[0.08] hover:-translate-y-0.5'
                          : 'border bg-card/80 backdrop-blur-xs border-border/60 hover:border-emerald-500/60 hover:bg-emerald-500/[0.03] hover:-translate-y-0.5 hover:shadow-sm'
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                        <div
                          className={cn(
                            'w-8 h-8 rounded-lg flex items-center justify-center border shrink-0 transition-colors',
                            isDraft
                              ? 'bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400 group-hover:bg-amber-500 group-hover:text-white'
                              : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 group-hover:bg-emerald-500 group-hover:text-white'
                          )}
                        >
                          <MaterialIcon
                            icon={isDraft ? 'edit_note' : 'folder'}
                            className="text-base"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              'text-xs font-bold text-foreground truncate',
                              isDraft
                                ? 'group-hover:text-amber-600 dark:group-hover:text-amber-400'
                                : 'group-hover:text-emerald-600 dark:group-hover:text-emerald-400'
                            )}
                          >
                            {vd.name}
                          </p>
                          {isDraft ? (
                            <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
                              <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 shrink-0">
                                {t('草稿')}
                              </span>
                              <p className="text-[10px] text-muted-foreground truncate">
                                {t('未保存草稿 · 点击恢复')}
                              </p>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 min-w-0 mt-0.5 text-[10px] text-muted-foreground truncate">
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
                          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-background dark:bg-card border border-amber-500/50 text-muted-foreground/70 hover:text-red-500 hover:border-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all duration-200 shadow-md flex items-center justify-center z-20"
                        >
                          <MaterialIcon icon="close" className="text-[11px]" />
                        </button>
                      )}

                      <MaterialIcon
                        icon="arrow_forward_ios"
                        className={cn(
                          'text-[10px] text-muted-foreground/40 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200',
                          isDraft ? 'group-hover:text-amber-500' : 'group-hover:text-emerald-500'
                        )}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="bg-card/80 backdrop-blur-xs border border-border/60 rounded-xl p-5 text-center space-y-1.5">
                <div className="w-8 h-8 rounded-full bg-muted/40 flex items-center justify-center mx-auto text-muted-foreground">
                  <MaterialIcon icon="folder_off" className="text-base" />
                </div>
                <h4 className="text-xs font-bold text-foreground">{t('暂无已保存的虚拟目录')}</h4>
                <p className="text-[11px] text-muted-foreground max-w-md mx-auto leading-relaxed">
                  {t(
                    '增量整理用于在已有虚拟目录的基础上追加新文件。您当前工作区尚未保存任何虚拟目录，请先从上方选择适合的整理模式完成并保存虚拟目录。'
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
