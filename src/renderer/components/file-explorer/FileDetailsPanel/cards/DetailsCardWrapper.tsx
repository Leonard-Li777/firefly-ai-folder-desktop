import React from 'react'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { cn, MaterialIcon } from '../../../../lib/utils'
import { Button } from '../../../ui/button'
import { DetailsCardId, getDetailsCardTitle } from '../stores/details-cards-store'

interface DetailsCardWrapperProps {
  id: DetailsCardId
  isOnlyOneVisible: boolean
  onCloseCard: () => void
  className?: string
  children: React.ReactNode
}

export const DetailsCardWrapper: React.FC<DetailsCardWrapperProps> = ({
  id,
  isOnlyOneVisible,
  onCloseCard,
  className,
  children
}) => {
  const { t } = useVoerkaI18n(i18nScope)
  const title = getDetailsCardTitle(id)

  return (
    <div
      data-testid={`details-card-${id}`}
      className={cn(
        'relative group rounded-xl border border-border/50 bg-card/60 backdrop-blur-xs p-3.5 shadow-2xs flex flex-col min-w-0 transition-all',
        className
      )}
    >
      {/* 右上角悬浮关闭按钮 */}
      <Button
        variant="ghost"
        size="icon"
        disabled={isOnlyOneVisible}
        data-testid={`close-card-${id}`}
        onClick={onCloseCard}
        title={
          isOnlyOneVisible
            ? t('至少保留一张卡片，或点击右上角折叠面板')
            : t('关闭{title}', { title })
        }
        className={cn(
          'absolute top-2 right-2 h-6 w-6 p-0 z-10 rounded-md text-muted-foreground/60 transition-all duration-150',
          isOnlyOneVisible
            ? 'opacity-30 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground/60'
            : 'opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted/50 cursor-pointer'
        )}
      >
        <MaterialIcon icon="close" className="text-xs" />
      </Button>

      {/* 卡片正文 */}
      <div className="w-full flex-1 flex flex-col min-h-0 min-w-0">{children}</div>
    </div>
  )
}
