import React from 'react'
import { t } from '@app/languages'
import { MaterialIcon } from '../../../../lib/utils'
import { EmptyState } from '../../../common/EmptyState'

interface ExportSelectorProps {
  currentWorkspaceDirectoryPath: string | null
  isVdirActive: boolean
  computed_limits: any
  handleExportVdir: () => void
  handleExportReal: () => void
}

export const ExportSelector: React.FC<ExportSelectorProps> = React.memo(
  ({
    currentWorkspaceDirectoryPath,
    isVdirActive,
    computed_limits,
    handleExportVdir,
    handleExportReal
  }) => {
    return (
      <div className="flex-1 h-full w-full flex flex-col overflow-auto">
        <EmptyState
          icon="share"
          title={t('预览并导出')}
          description={
            <>
              <p className="text-muted-foreground/80 max-w-lg mb-6 leading-relaxed">
                {t('您可以将当前勾选的分类结构一键物理化。我们提供两种物理化方案：')}
              </p>
              <span className="text-xs bg-muted px-2.5 py-1 rounded-full text-muted-foreground mb-12 select-all inline-block">
                {currentWorkspaceDirectoryPath}
              </span>
            </>
          }
          // 覆盖 EmptyState 内部 max-w-sm 宽度限制：卡片区域按比例占满可用宽度，但限制最大宽度避免窗口过宽时被拉得过宽
          className="[&>div.z-10]:!max-w-4xl [&>div.z-10]:!w-full"
        >
          <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-8 px-8 pb-10">
            {/* 导出虚拟目录卡片 */}
            <div
              onClick={handleExportVdir}
              className="group relative flex flex-col p-8 rounded-3xl border-2 border-border/50 bg-background hover:border-green-500/50 hover:shadow-2xl hover:shadow-green-500/10 transition-all duration-300 cursor-pointer overflow-hidden"
            >
              <div className="absolute -top-12 -right-12 w-32 h-32 bg-green-500/5 rounded-full blur-3xl group-hover:bg-green-500/10 transition-colors" />
              <h3 className="text-2xl font-bold mb-5">{t('导出虚拟目录')}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed mb-5 text-left">
                {t('将当前虚拟目录结构完整导出到指定物理路径')}
              </p>
              <ul className="text-muted-foreground text-sm leading-relaxed mb-8 flex-1 space-y-1.5 text-left">
                <li className="flex items-start gap-2">
                  <MaterialIcon
                    icon="check_circle"
                    className="text-green-500 text-base mt-0.5 shrink-0"
                  />
                  <span>{t('不会影响原始文件')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <MaterialIcon
                    icon="check_circle"
                    className="text-green-500 text-base mt-0.5 shrink-0"
                  />
                  <span>{t('不会占用物理硬盘空间')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <MaterialIcon
                    icon="check_circle"
                    className="text-green-500 text-base mt-0.5 shrink-0"
                  />
                  <span>{t('可以当作真实文件一样使用')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <MaterialIcon
                    icon="warning"
                    className="text-amber-500 text-base mt-0.5 shrink-0"
                  />
                  <span>{t('如想删除原始文件，请一并删除导出')}</span>
                </li>
              </ul>
              <div className="flex items-center justify-between pt-6 border-t border-border/50">
                {isVdirActive && ((computed_limits?.export_vdir_cost as number) ?? 0) > 0 && (
                  <div className="flex items-center gap-1.5 text-xs font-bold text-green-600 bg-green-500/10 px-3 py-1.5 rounded-full">
                    <MaterialIcon icon="local_fire_department" className="text-sm" />
                    {(computed_limits?.export_vdir_cost as number) ?? 0} {t('萤火')}
                  </div>
                )}
                <MaterialIcon
                  icon="arrow_forward"
                  className="ml-auto text-xl text-muted-foreground group-hover:text-green-500 group-hover:translate-x-1.5 transition-all"
                />
              </div>
            </div>

            {/* 导出真实目录卡片 */}
            <div
              onClick={handleExportReal}
              className="group relative flex flex-col p-8 rounded-3xl border-2 border-border/50 bg-background hover:border-orange-500/50 hover:shadow-2xl hover:shadow-orange-500/10 transition-all duration-300 cursor-pointer overflow-hidden"
            >
              <div className="absolute -top-12 -right-12 w-32 h-32 bg-orange-500/5 rounded-full blur-3xl group-hover:bg-orange-500/10 transition-colors" />
              <h3 className="text-2xl font-bold mb-5">{t('导出真实目录')}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed mb-5 text-left">
                {t('将物理文件按照当前的虚拟目录结构进行整理')}
              </p>
              <ul className="text-muted-foreground text-sm leading-relaxed mb-8 flex-1 space-y-1.5 text-left">
                <li className="flex items-start gap-2">
                  <MaterialIcon
                    icon="warning"
                    className="text-orange-500 text-base mt-0.5 shrink-0"
                  />
                  <span>{t('原始文件位置 and 命名会发生改变')}</span>
                </li>
              </ul>
              <div className="flex items-center justify-between pt-6 border-t border-border/50">
                {isVdirActive && ((computed_limits?.export_rdir_cost as number) ?? 0) > 0 && (
                  <div className="flex items-center gap-1.5 text-xs font-bold text-orange-600 bg-orange-500/10 px-3 py-1.5 rounded-full">
                    <MaterialIcon icon="local_fire_department" className="text-sm" />
                    {(computed_limits?.export_rdir_cost as number) ?? 0} {t('萤火')}
                  </div>
                )}
                <MaterialIcon
                  icon="arrow_forward"
                  className="ml-auto text-xl text-muted-foreground group-hover:text-orange-500 group-hover:translate-x-1.5 transition-all"
                />
              </div>
            </div>
          </div>
        </EmptyState>
      </div>
    )
  }
)

ExportSelector.displayName = 'ExportSelector'
