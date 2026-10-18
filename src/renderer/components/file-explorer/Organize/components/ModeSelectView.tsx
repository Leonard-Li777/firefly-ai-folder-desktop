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
    <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-10 overflow-y-auto relative w-full h-full">
      <div className="relative w-full max-w-5xl my-auto space-y-8 z-10">
        {/* 标题区域 */}
        <div className="text-center space-y-2.5 relative">
          <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight bg-gradient-to-r from-foreground via-foreground/90 to-foreground/70 bg-clip-text text-transparent">
            {t('选择整理模式')}
          </h2>
        </div>

        {/* 模式选择网格 */}
        <div className="space-y-7">
          {/* ==================== 分组 1：新建整理方案 (2x2 经典对称网格) ==================== */}
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
              {/* 1. 身份蓝图 (推荐 · 金色) */}
              <div
                onClick={() => onSelectMode('identity-blueprint')}
                className="group relative cursor-pointer rounded-2xl p-5 border-2 bg-card/90 backdrop-blur-xs border-amber-500/40 hover:border-amber-500/80 hover:bg-amber-500/[0.03] hover:-translate-y-1 hover:shadow-xl hover:shadow-amber-500/10 transition-all duration-300 flex flex-col justify-between select-none overflow-hidden focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-300 bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400 group-hover:bg-gradient-to-br group-hover:from-amber-500 group-hover:to-orange-600 group-hover:text-white group-hover:shadow-md group-hover:shadow-amber-500/20 group-hover:scale-105">
                      <MaterialIcon icon="psychology" className="text-xl" />
                    </div>
                    {/* 金色推荐徽标 */}
                    <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/15 px-2.5 py-0.5 rounded-full border border-amber-500/30 flex items-center gap-1 shadow-xs">
                      <MaterialIcon icon="star" className="text-xs text-amber-500" />
                      {t('推荐 (Recommended)')}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-foreground group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors flex items-center gap-2">
                      {t('身份蓝图')}
                      <span className="text-xs text-muted-foreground font-normal">
                        ({t('职业/生活角色 · 4阶段整理')})
                      </span>
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      {t(
                        '基于权威职业分类标准与生活角色知识库，深度融合用户诉求与文件特征，推荐量身定制的标准目录结构与多候选路径。'
                      )}
                    </p>
                  </div>

                  <div className="pt-3 border-t border-border/40 grid grid-cols-2 gap-2.5 text-[11px] text-muted-foreground font-medium">
                    {[
                      t('60+ 职业与生活身份库'),
                      t('21 套四要素标准模板'),
                      t('动态容差与及格线限定'),
                      t('支持 4 阶段交互微调')
                    ].map((feat, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <MaterialIcon
                          icon="check_circle"
                          className="text-xs text-amber-500 shrink-0"
                        />
                        <span>{feat}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 2. 智能聚类 (极速直出 · 蓝色) */}
              <div
                onClick={() => onSelectMode('smart-clustering')}
                className="group relative cursor-pointer rounded-2xl p-5 border bg-card/80 backdrop-blur-xs border-border/60 hover:border-blue-500/60 hover:bg-blue-500/[0.02] hover:-translate-y-1 hover:shadow-xl hover:shadow-blue-500/5 transition-all duration-300 flex flex-col justify-between select-none overflow-hidden focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-300 bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400 group-hover:bg-gradient-to-br group-hover:from-blue-500 group-hover:to-cyan-600 group-hover:text-white group-hover:shadow-md group-hover:shadow-blue-500/20 group-hover:scale-105">
                      <MaterialIcon icon="hub" className="text-xl" />
                    </div>
                    <span className="text-[11px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 px-2.5 py-0.5 rounded-full border border-blue-500/20 flex items-center gap-1">
                      <MaterialIcon icon="speed" className="text-xs" />
                      {t('极速直出')}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-foreground group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors flex items-center gap-2">
                      {t('智能聚类')}
                      <span className="text-xs text-muted-foreground font-normal">
                        ({t('端侧无监督 · 1个Stage直出')})
                      </span>
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      {t(
                        '基于端侧原生无监督层次凝聚聚类（HAC），毫秒级极速即时出图。支持自然语言提示词引导与内联微调，无需漫长等待。'
                      )}
                    </p>
                  </div>

                  <div className="pt-3 border-t border-border/40 grid grid-cols-2 gap-2.5 text-[11px] text-muted-foreground font-medium">
                    {[
                      t('端侧原生 HAC 引擎'),
                      t('毫秒级即时出图'),
                      t('单 Stage 极简交互'),
                      t('支持内联微调与脏保护')
                    ].map((feat, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <MaterialIcon
                          icon="check_circle"
                          className="text-xs text-blue-500 shrink-0"
                        />
                        <span>{feat}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 3. 精细整理 (高级 AI · 紫色) */}
              <div
                onClick={() => {
                  if (!isAdvancedAiEnabled) {
                    toast.info(t('精细整理需要高级AI引擎支持，请前往“设置 -> AI引擎配置”开启'))
                    return
                  }
                  onSelectMode('fine-organize')
                }}
                className={cn(
                  'group relative rounded-2xl p-5 border transition-all duration-300 flex flex-col justify-between select-none overflow-hidden focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary',
                  isAdvancedAiEnabled
                    ? 'cursor-pointer bg-card/80 backdrop-blur-xs border-border/60 hover:border-purple-500/60 hover:bg-purple-500/[0.02] hover:-translate-y-1 hover:shadow-xl hover:shadow-purple-500/5'
                    : 'cursor-not-allowed opacity-60 bg-muted/20 border-border/40'
                )}
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div
                      className={cn(
                        'w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-300',
                        isAdvancedAiEnabled
                          ? 'bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-400 group-hover:bg-gradient-to-br group-hover:from-purple-500 group-hover:to-indigo-600 group-hover:text-white group-hover:shadow-md group-hover:shadow-purple-500/20 group-hover:scale-105'
                          : 'bg-muted border-border/40 text-muted-foreground'
                      )}
                    >
                      <MaterialIcon icon="auto_stories" className="text-xl" />
                    </div>
                    {isAdvancedAiEnabled ? (
                      <span className="text-[11px] font-bold text-purple-600 dark:text-purple-400 bg-purple-500/10 px-2.5 py-0.5 rounded-full border border-purple-500/20 flex items-center gap-1">
                        <MaterialIcon icon="neurology" className="text-xs" />
                        {t('需高级AI引擎')}
                      </span>
                    ) : (
                      <span className="text-[11px] font-bold text-muted-foreground bg-muted/60 px-2.5 py-0.5 rounded-full border border-border/60 flex items-center gap-1">
                        <MaterialIcon icon="lock" className="text-xs" />
                        {t('需开启高级AI引擎')}
                      </span>
                    )}
                  </div>

                  <div>
                    <h4
                      className={cn(
                        'text-base font-bold transition-colors flex items-center gap-2',
                        isAdvancedAiEnabled
                          ? 'text-foreground group-hover:text-purple-600 dark:group-hover:text-purple-400'
                          : 'text-muted-foreground'
                      )}
                    >
                      {t('精细整理')}
                      <span className="text-xs text-muted-foreground font-normal">
                        ({t('本地/云端大模型 · 3套目录树直选')})
                      </span>
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      {t(
                        '由大模型结合当前文件特征与维度标签，端到端深度规划 3 套最终完整的层级目录树方案，无需繁琐推理直接比选。'
                      )}
                    </p>
                    {isAdvancedAiEnabled && (
                      <div className="mt-2 text-[11px] text-purple-600 dark:text-purple-400 flex items-center gap-1 font-medium bg-purple-500/5 px-2 py-1 rounded-lg border border-purple-500/10">
                        <MaterialIcon icon="info" className="text-xs shrink-0" />
                        <span>{t('建议使用“高中生”级别以上的模型才能获取较好效果')}</span>
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-border/40 grid grid-cols-2 gap-2.5 text-[11px] text-muted-foreground font-medium">
                    {[
                      t('3套最终目录树直选'),
                      t('深度语义推理与命名'),
                      t('消除二次等待耗时'),
                      t('支持容差重塑与微调')
                    ].map((feat, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <MaterialIcon
                          icon={isAdvancedAiEnabled ? 'check_circle' : 'remove_circle_outline'}
                          className={cn(
                            'text-xs shrink-0',
                            isAdvancedAiEnabled ? 'text-purple-500' : 'text-muted-foreground/60'
                          )}
                        />
                        <span>{feat}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 4. 外部AI生成目录结构 (借力外部AI · 青色) */}
              <div
                onClick={() => onSelectMode('external-ai')}
                className="group relative cursor-pointer rounded-2xl p-5 border bg-card/80 backdrop-blur-xs border-border/60 hover:border-cyan-500/60 hover:bg-cyan-500/[0.02] hover:-translate-y-1 hover:shadow-xl hover:shadow-cyan-500/5 transition-all duration-300 flex flex-col justify-between select-none overflow-hidden focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-300 bg-cyan-500/10 border-cyan-500/20 text-cyan-600 dark:text-cyan-400 group-hover:bg-gradient-to-br group-hover:from-cyan-500 group-hover:to-teal-600 group-hover:text-white group-hover:shadow-md group-hover:shadow-cyan-500/20 group-hover:scale-105">
                      <MaterialIcon icon="travel_explore" className="text-xl" />
                    </div>
                    <span className="text-[11px] font-bold text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 px-2.5 py-0.5 rounded-full border border-cyan-500/20 flex items-center gap-1">
                      <MaterialIcon icon="open_in_browser" className="text-xs" />
                      {t('借力外部AI')}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-foreground group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors flex items-center gap-2">
                      {t('外部AI生成目录结构')}
                      <span className="text-xs text-muted-foreground font-normal">
                        ({t('豆包/ChatGPT/Kimi · 引导与导入')})
                      </span>
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      {t(
                        '针对本地算力有限的用户，提供当前文件画像的精准结构化提示词，复制后由外部大模型规划目录结构并一键导入。'
                      )}
                    </p>
                  </div>

                  <div className="pt-3 border-t border-border/40 grid grid-cols-2 gap-2.5 text-[11px] text-muted-foreground font-medium">
                    {[
                      t('精准提示词一键复制'),
                      t('适配外部主流大模型'),
                      t('首行命名智能自动对齐'),
                      t('端侧余弦秒级智能归类')
                    ].map((feat, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <MaterialIcon
                          icon="check_circle"
                          className="text-xs text-cyan-500 shrink-0"
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
