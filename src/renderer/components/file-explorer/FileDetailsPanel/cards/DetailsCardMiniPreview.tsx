import React from 'react'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon } from '../../../../lib/utils'
import { PreviewSection } from '../components/PreviewSection'

interface DetailsCardMiniPreviewProps {
  displayUrl: string | null
  item?: any
  isDirectory: boolean
  showDirectory: boolean
  analysisResult?: any
  isFileAnalysis: (res: any) => boolean
  /** 全局大预览面板是否被折叠（true = 已折叠，开启富文本预览；false = 展开中，切换为紧凑预览） */
  previewCollapsed?: boolean
}

export const DetailsCardMiniPreview: React.FC<DetailsCardMiniPreviewProps> = ({
  displayUrl,
  item,
  isDirectory,
  showDirectory,
  analysisResult,
  isFileAnalysis,
  previewCollapsed = true
}) => {
  const { t } = useVoerkaI18n(i18nScope)
  const isCompact = !previewCollapsed
  const previewMode = isCompact ? 'compact' : 'rich'

  return (
    <div
      data-testid="details-card-mini-preview"
      data-preview-mode={previewMode}
      className="w-full flex flex-col items-center justify-center min-h-[140px]"
    >
      <div className="w-full flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <MaterialIcon icon="image" className="text-sm text-primary" />
          {t('迷你预览')}
        </span>
      </div>

      <div className="w-full flex-1 flex flex-col items-center justify-center">
        <PreviewSection
          displayUrl={displayUrl}
          item={item}
          isDirectory={isDirectory}
          showDirectory={showDirectory}
          analysisResult={analysisResult}
          isFileAnalysis={isFileAnalysis}
        />
      </div>
    </div>
  )
}
