import React from 'react'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon } from '../../../../lib/utils'
import { TagList } from '../components/TagList'

interface DetailsCardTagsProps {
  analysisResult?: any
  getTagColor: (index: number) => string
  onTagDeleted?: () => void
  isDirectory: boolean
  showDirectory: boolean
  isFileAnalysis: (res: any) => boolean
}

export const DetailsCardTags: React.FC<DetailsCardTagsProps> = ({
  analysisResult,
  getTagColor,
  onTagDeleted,
  isDirectory,
  showDirectory,
  isFileAnalysis
}) => {
  const { t } = useVoerkaI18n(i18nScope)
  const isFile = !isDirectory && !showDirectory && isFileAnalysis(analysisResult)

  const hasFileTags = Boolean(
    analysisResult &&
      ((Array.isArray(analysisResult.tagGroups) && analysisResult.tagGroups.length > 0) ||
        (Array.isArray(analysisResult.dimensionTags) && analysisResult.dimensionTags.length > 0))
  )

  return (
    <div data-testid="details-card-tags" className="w-full flex flex-col min-h-[140px]">
      <div className="w-full flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <MaterialIcon icon="label" className="text-sm text-primary" />
          {t('受控标签')}
        </span>
      </div>

      <div className="flex-1 flex flex-col justify-start">
        {isFile && hasFileTags ? (
          <TagList
            analysisResult={analysisResult}
            getTagColor={getTagColor}
            onTagDeleted={onTagDeleted}
          />
        ) : isFile ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-muted-foreground/60 text-xs">
            <MaterialIcon icon="label_off" className="text-2xl mb-1 opacity-50" />
            <span>{t('暂无受控标签')}</span>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-muted-foreground/60 text-xs">
            <MaterialIcon icon="folder_special" className="text-2xl mb-1 opacity-50" />
            <span>{t('目录通过子文件汇聚标签')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
