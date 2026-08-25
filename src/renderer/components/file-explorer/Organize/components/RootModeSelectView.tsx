import React from 'react'
import { Stage } from '../types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Badge } from '../../../ui/badge'

interface RootModeSelectViewProps {
  onSelectStage: (stage: Stage) => void
  totalFilesCount: number
}

export const RootModeSelectView: React.FC<RootModeSelectViewProps> = ({
  onSelectStage,
  totalFilesCount
}) => {
  const modes = [
    {
      stage: 'batch-rename' as Stage,
      title: t('批量更名'),
      tag: t('DSL 模板'),
      icon: 'drive_file_rename_outline',
      description: t('基于智能文件名、修改日期、维度标签与自增序号等 DSL 属性，一键批量重命名智能文件名。'),
      accentColor: 'from-blue-500/10 via-indigo-500/5 to-transparent',
      iconColor: 'text-blue-500 bg-blue-500/10',
      badgeVariant: 'secondary' as const
    },
    {
      stage: 'batch-tag' as Stage,
      title: t('批量标签'),
      tag: t('覆盖率三态'),
      icon: 'label',
      description: t('支持批量对文件标签进行点选新增和删除。'),
      accentColor: 'from-emerald-500/10 via-teal-500/5 to-transparent',
      iconColor: 'text-emerald-500 bg-emerald-500/10',
      badgeVariant: 'secondary' as const
    },
    {
      stage: 'batch-duplicate' as Stage,
      title: t('批量清理'),
      tag: t('双轨多模态'),
      icon: 'cleaning_services',
      description: t('基于 Omni Rust 快速多模态指纹与本地文档语义双轨并行，智能分析并安全清理重复与冗余文件。'),
      accentColor: 'from-amber-500/10 via-orange-500/5 to-transparent',
      iconColor: 'text-amber-500 bg-amber-500/10',
      badgeVariant: 'secondary' as const
    },
    {
      stage: 'mode-select' as Stage,
      title: t('批量整理'),
      tag: t('AI 智能重构'),
      icon: 'auto_fix_high',
      description: t('基于 AI 智能多维度分析或虚拟目录规则，将勾选文件归类并输出至物理目录或新建虚拟目录。'),
      accentColor: 'from-purple-500/10 via-pink-500/5 to-transparent',
      iconColor: 'text-purple-500 bg-purple-500/10',
      badgeVariant: 'default' as const
    }
  ]

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-10 flex flex-col items-center justify-center min-h-[500px]">
      <div className="max-w-4xl w-full space-y-8">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold">
            <MaterialIcon icon="hub" className="text-sm" />
            <span>{t('已勾选 {count} 个目标文件', { count: totalFilesCount })}</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            {t('选择预处理或整理模式')}
          </h2>
          <p className="text-sm text-muted-foreground max-w-xl mx-auto">
            {t('在进入物理目录整理前，您可以先执行智能批量更名、标签批量打标或双轨查重清理。')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {modes.map(mode => (
            <div
              key={mode.stage}
              onClick={() => onSelectStage(mode.stage)}
              className={cn(
                'group relative rounded-2xl border p-6 transition-all duration-300 cursor-pointer',
                'hover:shadow-lg hover:border-primary/50 hover:scale-[1.01] bg-card text-card-foreground',
                'flex flex-col justify-between overflow-hidden'
              )}
            >
              {/* 背景渐变微光 */}
              <div
                className={cn(
                  'absolute inset-0 bg-gradient-to-br opacity-60 group-hover:opacity-100 transition-opacity pointer-events-none',
                  mode.accentColor
                )}
              />

              <div className="relative space-y-4">
                <div className="flex items-center justify-between">
                  <div
                    className={cn(
                      'w-12 h-12 rounded-xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110 shadow-xs',
                      mode.iconColor
                    )}
                  >
                    <MaterialIcon icon={mode.icon} className="text-2xl" />
                  </div>
                  <Badge variant={mode.badgeVariant} className="font-medium text-xs">
                    {mode.tag}
                  </Badge>
                </div>

                <div className="space-y-1.5">
                  <h3 className="text-lg font-semibold text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                    {mode.title}
                    <MaterialIcon
                      icon="arrow_forward"
                      className="text-base opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all text-primary"
                    />
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {mode.description}
                  </p>
                </div>
              </div>

              <div className="relative pt-4 mt-2 border-t border-border/40 flex items-center justify-between text-xs text-muted-foreground group-hover:text-foreground">
                <span className="font-medium">{t('点击进入工作台')}</span>
                <MaterialIcon icon="chevron_right" className="text-sm" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
