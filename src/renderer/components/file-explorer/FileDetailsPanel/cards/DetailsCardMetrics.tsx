import React from 'react'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon } from '../../../../lib/utils'
import { AnalysisTabs } from '../tabs/AnalysisTabs'
import { DirectoryProfileSection } from '../components/DirectoryProfileSection'

interface DetailsCardMetricsProps {
  item?: any
  analysisResult?: any
  isDirectory: boolean
  showDirectory: boolean
  availableTabs: any[]
  activeTab: string
  setActiveTab: (tab: string) => void
  maskClass?: string
  formatDate: (d: any) => string
  getTagColor: (index: number) => string
  refreshAnalysis: () => void
  workspaceDirectoryPath?: string
  isDirAnalysis: (res: any) => boolean
}

export const DetailsCardMetrics: React.FC<DetailsCardMetricsProps> = ({
  item,
  analysisResult,
  isDirectory,
  showDirectory,
  availableTabs,
  activeTab,
  setActiveTab,
  maskClass,
  formatDate,
  getTagColor,
  refreshAnalysis,
  workspaceDirectoryPath,
  isDirAnalysis
}) => {
  const { t } = useVoerkaI18n(i18nScope)
  const isDirMode = isDirectory || showDirectory

  return (
    <div data-testid="details-card-metrics" className="w-full flex flex-col min-h-[140px]">
      <div className="w-full flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <MaterialIcon icon="analytics" className="text-sm text-primary" />
          {t('分析指标')}
        </span>
      </div>

      <div className="flex-1 flex flex-col justify-start">
        {/* 目录态画像 */}
        {isDirMode && analysisResult && isDirAnalysis(analysisResult) && (
          <div className="mb-4">
            <DirectoryProfileSection
              analysisResult={analysisResult}
              isDirAnalysis={isDirAnalysis}
              getTagColor={getTagColor}
              formatDate={formatDate}
              onRefresh={refreshAnalysis}
              isUnit={!!item?.isUnit}
              workspaceDirectoryPath={workspaceDirectoryPath || item?.workspaceDirectoryPath}
            />
          </div>
        )}

        {/* 目录基础元数据 */}
        {isDirMode && !analysisResult && item && (
          <div className="mb-4">
            <h3 className="text-xs font-semibold mb-2 text-foreground">{t('目录属性')}</h3>
            <div className="bg-muted/30 rounded-xl p-3 space-y-2 text-xs border border-border/50">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t('目录名')}</span>
                <span className="font-semibold break-all ml-2 text-right">{item.name}</span>
              </div>
              {item.path && (
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground">{t('路径')}</span>
                  <span className="text-[11px] break-all text-muted-foreground/80 font-mono bg-muted/50 p-1.5 rounded w-full border border-border/30">
                    {item.path}
                  </span>
                </div>
              )}
              {item.fileCount !== undefined && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{t('文件数量')}</span>
                  <span className="font-semibold">
                    {item.fileCount} {t('个')}
                  </span>
                </div>
              )}
              {item.size !== undefined && item.size > 0 && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{t('大小')}</span>
                  <span className="font-semibold">
                    {((item.size || 0) / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 分析 Tabs (质量评分、OCR、音频文本、耗时等) */}
        {availableTabs && availableTabs.length > 0 ? (
          <AnalysisTabs
            availableTabs={availableTabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            analysisResult={analysisResult}
            maskClass={maskClass}
            formatDate={formatDate}
          />
        ) : !isDirMode ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-muted-foreground/60 text-xs">
            <MaterialIcon icon="hourglass_empty" className="text-2xl mb-1 opacity-50" />
            <span>{t('暂无分析指标')}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
