import React, { useEffect } from 'react'
import { useTierStore } from '../../stores/tier-store'
import { UserTier } from '@firefly/shared'
import { Badge } from '../ui/badge'
import { t } from '@app/languages'
import { Flame as Firecores, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { FirecoresRulesDialog } from './FirecoresRulesDialog'
import { UpgradeAccountDialog } from './UpgradeAccountDialog'

export const UserTierBadge: React.FC<{ className?: string }> = ({ className }) => {
  const { tier, firecores, fetchProfile, isLoading } = useTierStore()
  const [isConsumptionOpen, setIsConsumptionOpen] = React.useState(false)
  const [isUpgradeOpen, setIsUpgradeOpen] = React.useState(false)

  useEffect(() => {
    fetchProfile()
  }, [fetchProfile])

  const getTierInfo = (tier: UserTier) => {
    switch (tier) {
      case UserTier.ENTERPRISE:
        return {
          label: t('企业版'),
          className: 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white border-none'
        }
      case UserTier.PRO:
        return {
          label: t('专业版'),
          className: 'bg-gradient-to-r from-amber-500 to-orange-600 text-white border-none'
        }
      default:
        return {
          label: t('免费版'),
          className: 'bg-secondary text-secondary-foreground'
        }
    }
  }

  const tierInfo = getTierInfo(tier)

  return (
    <>
      <div className={cn('flex items-center gap-3', className)}>
        <Badge
          className={cn(
            'px-2 py-0.5 font-bold shadow-sm cursor-pointer hover:opacity-80 transition-opacity flex items-center gap-1',
            tierInfo.className
          )}
          onClick={() => setIsUpgradeOpen(true)}
        >
          {tierInfo.label}
          <ChevronDown className="w-3 h-3 opacity-50" />
        </Badge>
        <div
          className="flex items-center gap-1.5 px-2 py-1 bg-accent/50 rounded-full border border-border/50 cursor-pointer hover:bg-accent transition-colors"
          onClick={() => setIsConsumptionOpen(true)}
        >
          <Firecores className="w-3.5 h-3.5 text-yellow-500" />
          <span className="text-xs font-medium tabular-nums">
            {isLoading ? '...' : firecores.toLocaleString()}
          </span>
        </div>
      </div>

      <FirecoresRulesDialog
        open={isConsumptionOpen}
        onOpenChange={setIsConsumptionOpen}
        defaultTab="consumption"
      />
      <UpgradeAccountDialog open={isUpgradeOpen} onOpenChange={setIsUpgradeOpen} />
    </>
  )
}
