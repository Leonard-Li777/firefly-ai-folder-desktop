import React from 'react'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon } from '../../../../lib/utils'
import { Button } from '../../../ui/button'
import {
  DetailsCardId,
  ALL_DETAILS_CARD_IDS,
  getDetailsCardTitle,
  getDetailsCardIcon
} from '../stores/details-cards-store'

interface DetailsMicroActionStripProps {
  pageId: string
  visibleCards: DetailsCardId[]
  isDirMode?: boolean
  onToggleCard: (pageId: string, cardId: DetailsCardId) => void
  onClose?: () => void
}

export const DetailsMicroActionStrip: React.FC<DetailsMicroActionStripProps> = ({
  pageId,
  visibleCards,
  isDirMode = false,
  onToggleCard,
  onClose
}) => {
  const { t } = useVoerkaI18n(i18nScope)
  // 目录模式下仅支持分析指标，不呈现其它 3 类单文件卡片的复原胶囊
  const closedCards = isDirMode
    ? []
    : ALL_DETAILS_CARD_IDS.filter(id => !visibleCards.includes(id))

  return (
    <div
      data-testid="details-micro-action-strip"
      className="min-h-[34px] px-3.5 py-1.5 flex items-center justify-between shrink-0 select-none text-xs text-muted-foreground border-b border-border/30 bg-muted/20"
    >
      {/* 左侧：已关闭卡片的复原胶囊区 */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 my-0.5">
        {closedCards.length > 0 ? (
          closedCards.map(id => (
            <button
              key={id}
              type="button"
              data-testid={`restore-card-${id}`}
              onClick={() => onToggleCard(pageId, id)}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-primary/10 hover:bg-primary/20 text-primary text-[11px] font-medium transition-colors cursor-pointer shrink-0 shadow-2xs"
              title={t('点击复原卡片')}
            >
              <MaterialIcon icon="add" className="text-[12px]" />
              <MaterialIcon icon={getDetailsCardIcon(id)} className="text-[11px] opacity-70" />
              <span>{getDetailsCardTitle(id)}</span>
            </button>
          ))
        ) : (
          <span className="text-[11px] text-muted-foreground/60 select-none">
            {isDirMode ? t('目录指标') : t('微宫格视图')}
          </span>
        )}
      </div>

      {/* 右侧：全局面板关闭按钮（常驻，接通父级 closePanel） */}
      {onClose && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="details-close-button"
          onClick={onClose}
          title={t('关闭属性面板')}
          className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-foreground rounded-md"
        >
          <MaterialIcon icon="close" className="text-sm" />
        </Button>
      )}
    </div>
  )
}
