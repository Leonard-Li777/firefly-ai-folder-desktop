import React from 'react'
import { Stage } from '../types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'

interface RootModeSelectViewProps {
  onSelectStage: (stage: Stage) => void
  totalFilesCount: number
}

export const RootModeSelectView: React.FC<RootModeSelectViewProps> = ({
  onSelectStage,
  totalFilesCount
}) => {
  const satelliteModes = [
    {
      stage: 'batch-rename' as Stage,
      title: t('批量更名'),
      tag: t('预处理 · 命名'),
      icon: 'drive_file_rename_outline',
      description: t('基于智能文件名、修改日期、维度标签与自增序号等 DSL 属性，一键批量重命名智能文件名。'),
      accentColor: 'from-blue-500/10 via-indigo-500/5 to-transparent',
      hoverBorder: 'hover:border-blue-500/50 hover:shadow-blue-500/10',
      iconColor: 'text-blue-500 bg-blue-500/10',
      badgeVariant: 'secondary' as const
    },
    {
      stage: 'batch-tag' as Stage,
      title: t('批量标签'),
      tag: t('预处理 · 打标'),
      icon: 'label',
      description: t('支持批量对目标文件标签进行多维点选新增与批量移除，补齐文件语义画像。'),
      accentColor: 'from-emerald-500/10 via-teal-500/5 to-transparent',
      hoverBorder: 'hover:border-emerald-500/50 hover:shadow-emerald-500/10',
      iconColor: 'text-emerald-500 bg-emerald-500/10',
      badgeVariant: 'secondary' as const
    },
    {
      stage: 'batch-duplicate' as Stage,
      title: t('批量清理'),
      tag: t('安全查重'),
      icon: 'cleaning_services',
      description: t('基于FireFly Omni智能分析并安全清理冗余重复文件，所有删除均移入系统回收站。'),
      accentColor: 'from-amber-500/10 via-orange-500/5 to-transparent',
      hoverBorder: 'hover:border-amber-500/50 hover:shadow-amber-500/10',
      iconColor: 'text-amber-500 bg-amber-500/10',
      badgeVariant: 'secondary' as const,
      badgeClassName: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    }
  ]

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-10 flex flex-col items-center justify-center min-h-[500px]">
      <div className="max-w-4xl w-full space-y-6">
        {/* 顶部引导与统计 */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold">
            <MaterialIcon icon="hub" className="text-sm" />
            <span>{t('已勾选 {count} 个目标文件', { count: totalFilesCount })}</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            {t('选择整理主流程或前置预处理')}
          </h2>
          <p className="text-sm text-muted-foreground max-w-xl mx-auto">
            {t('推荐直接进入【批量整理】由 AI 为您构建目录体系；亦可在整理前选用卫星工具进行规范更名、补充打标或安全查重清理。')}
          </p>
        </div>

        {/* ========================================================================= */}
        {/* 1. 核心主流程 Hero 旗舰卡片 (Primary Hero Pathway) */}
        {/* ========================================================================= */}
        <div
          onClick={() => onSelectStage('mode-select')}
          className={cn(
            'group relative rounded-2xl border-2 border-primary/35 p-6 md:p-7 transition-all duration-300 cursor-pointer',
            'hover:shadow-xl hover:shadow-primary/10 hover:border-primary hover:scale-[1.01]',
            'bg-card text-card-foreground flex flex-col justify-between overflow-hidden shadow-sm'
          )}
        >
          {/* 背景旗舰级渐变微光 */}
          <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-purple-500/10 to-transparent opacity-80 group-hover:opacity-100 transition-opacity pointer-events-none" />

          <div className="relative space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-13 h-13 rounded-xl flex items-center justify-center transition-all duration-300 group-hover:scale-110 shadow-sm text-purple-600 dark:text-purple-300 bg-purple-500/15 border border-purple-500/20">
                  <MaterialIcon icon="auto_fix_high" className="text-2xl" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-bold text-foreground group-hover:text-primary transition-colors">
                      {t('批量整理')}
                    </h3>
                    <Badge className="font-semibold text-xs bg-primary text-primary-foreground shadow-xs">
                      <MaterialIcon icon="star" className="text-xs mr-0.5" />
                      {t('AI 核心主流程')}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('一站式 AI 目录智能规划、方案比选与文件归档')}
                  </p>
                </div>
              </div>

              <Button
                size="sm"
                className="rounded-xl px-4 py-2 font-bold shadow-md shadow-primary/20 text-xs shrink-0 self-start sm:self-auto group-hover:bg-primary/95 transition-all group-hover:translate-x-0.5"
              >
                <span>{t('立即开始批量整理')}</span>
                <MaterialIcon icon="arrow_forward" className="text-sm ml-1" />
              </Button>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed max-w-2xl">
              {t('基于 AI 智能多维度分析或虚拟目录规则，将勾选文件智能归类并输出至物理目录或新建虚拟目录。无需繁琐前置操作，直接生成高效文件大纲。')}
            </p>

            {/* 核心特性胶囊 */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {[
                { icon: 'speed', text: t('快速整理直出') },
                { icon: 'psychology', text: t('深度多方案比选') },
                { icon: 'folder_open', text: t('虚拟与物理目录归档') },
                { icon: 'healing', text: t('未归类自动救援') }
              ].map((feat, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-background/80 dark:bg-zinc-800/80 border border-border/50 text-[11px] font-medium text-foreground/80 shadow-2xs"
                >
                  <MaterialIcon icon={feat.icon} className="text-xs text-primary shrink-0" />
                  <span>{feat.text}</span>
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* 2. 卫星功能坞 (Satellite Preprocessing Dock) */}
        {/* ========================================================================= */}
        <div className="space-y-3 pt-2">
          {/* 卫星功能语义引导栏 */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <MaterialIcon icon="satellite_alt" className="text-sm text-muted-foreground/80" />
                {t('前置预处理工具 (整理前卫星功能)')}
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground/70 hidden sm:inline">
              {t('整理前先规范文件名、打全维度标签或排除冗余，可让整理效果更佳')}
            </span>
          </div>

          {/* 三列并排卫星卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
            {satelliteModes.map(mode => (
              <div
                key={mode.stage}
                onClick={() => onSelectStage(mode.stage)}
                className={cn(
                  'group relative rounded-xl border p-4.5 transition-all duration-300 cursor-pointer',
                  'hover:shadow-md hover:scale-[1.01] bg-card text-card-foreground',
                  'flex flex-col justify-between overflow-hidden',
                  mode.hoverBorder
                )}
              >
                {/* 背景渐变微光 */}
                <div
                  className={cn(
                    'absolute inset-0 bg-gradient-to-br opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none',
                    mode.accentColor
                  )}
                />

                <div className="relative space-y-3">
                  <div className="flex items-center justify-between">
                    <div
                      className={cn(
                        'w-10 h-10 rounded-lg flex items-center justify-center transition-transform duration-300 group-hover:scale-110 shadow-2xs',
                        mode.iconColor
                      )}
                    >
                      <MaterialIcon icon={mode.icon} className="text-xl" />
                    </div>
                    <Badge
                      variant={mode.badgeVariant}
                      className={cn('font-medium text-[11px] px-2 py-0.5', mode.badgeClassName)}
                    >
                      {mode.tag}
                    </Badge>
                  </div>

                  <div className="space-y-1">
                    <h4 className="text-sm font-bold text-foreground group-hover:text-primary transition-colors flex items-center gap-1">
                      {mode.title}
                      <MaterialIcon
                        icon="arrow_forward"
                        className="text-xs opacity-0 -translate-x-1.5 group-hover:opacity-100 group-hover:translate-x-0 transition-all text-primary"
                      />
                    </h4>
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                      {mode.description}
                    </p>
                  </div>
                </div>

                <div className="relative pt-3 mt-3 border-t border-border/40 flex items-center justify-between text-[11px] text-muted-foreground group-hover:text-foreground">
                  <span className="font-medium">{t('进入工作台')}</span>
                  <MaterialIcon icon="chevron_right" className="text-xs" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
