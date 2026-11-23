import React from 'react'
import { FileItem, DirectoryItem, SettingsCategory } from '@firefly/types'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon } from '../../../../lib/utils'
import { Button } from '../../../ui/button'
import { getUnitTypeLabel, getUnitTheme } from '../../FileList/utils'
import { useSettingsStore } from '../../../../stores/settings-store'

interface DetailsPinnedBannerProps {
  item?: FileItem | DirectoryItem
  analysisResult?: any
}

export const DetailsPinnedBanner: React.FC<DetailsPinnedBannerProps> = ({ item, analysisResult }) => {
  const { t } = useVoerkaI18n(i18nScope)
  const openSettings = useSettingsStore(s => s.openSettings)

  const isMissing =
    (item && 'status' in item && (item as any).status === 0) ||
    (analysisResult && 'status' in analysisResult && (analysisResult as any).status === 0)

  const isUnit = Boolean(item && (item as any).isUnit)

  if (!isMissing && !isUnit) return null

  return (
    <div data-testid="details-pinned-banner" className="px-3.5 pt-3 space-y-2 shrink-0">
      {/* 丢失文件告警 */}
      {isMissing && (
        <div className="p-2.5 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-xs font-semibold">
            <MaterialIcon icon="warning" className="text-red-500 text-base shrink-0" />
            <span>{t('原文件丢失')}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="text-xs border-red-500/40 hover:bg-red-500/20 text-red-600 dark:text-red-400 h-6 px-2"
            onClick={() => openSettings(SettingsCategory.FILE_DISPLAY)}
          >
            {t('关闭显示')}
          </Button>
        </div>
      )}

      {/* 最小单元识别徽标 */}
      {isUnit && (
        <div
          className="p-2.5 rounded-xl border border-border/50 bg-card/40 space-y-1.5"
          data-testid="details-unit-banner"
        >
          {(() => {
            const uType = (item as any).unitType
            const uReason = (item as any).unitReason || ''
            const uConfidence = (item as any).unitConfidence
            const uLabel = getUnitTypeLabel(uType)
            const uTheme = getUnitTheme(uType)
            return (
              <>
                <div className="flex items-center gap-1.5">
                  <span className={`material-icons text-base ${uTheme.color} ${uTheme.darkColor}`}>
                    {uTheme.icon}
                  </span>
                  <span className={`text-xs font-semibold ${uTheme.color} ${uTheme.darkColor}`}>
                    {uLabel}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${uTheme.color} ${uTheme.darkColor} ${uTheme.border} ${uTheme.darkBorder} bg-white/80 dark:bg-gray-900/80`}
                  >
                    {t('最小单元')}
                  </span>
                  {uConfidence !== undefined && (
                    <span className="text-[11px] text-muted-foreground ml-auto">
                      {t('置信度')}: {Math.round(uConfidence * 100)}%
                    </span>
                  )}
                </div>
                {uReason && (
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{uReason}</p>
                )}
                <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                  {t('已经有序，目录内文件不进行逐一分析')}
                </p>
                {['design_project', 'album', 'series'].includes(uType || '') && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 text-xs h-6 px-2 text-orange-600 dark:text-orange-400 border-orange-300/50 dark:border-orange-700/50 hover:bg-orange-500/10"
                    onClick={() => openSettings(SettingsCategory.UNIT_RECOGNITION)}
                  >
                    <MaterialIcon icon="tune" className="text-xs mr-1" />
                    {t('关闭最小单元识别')}
                  </Button>
                )}
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}
