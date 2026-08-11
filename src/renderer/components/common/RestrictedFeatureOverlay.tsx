import React, { useState } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@app/languages'
import { MaterialIcon } from '../../lib/utils'
import { PaymentFlowDialog } from '../tier/PaymentFlowDialog'
import { useTierStore } from '../../stores/tier-store'
import { useConfigStore } from '../../stores/config-store'
import { useSettingsStore } from '../../stores/settings-store'
import { SettingsCategory } from '@firefly/types'
interface RestrictedFeatureOverlayProps {
  type: 'SPEEDY' | 'PRIVATE' | 'VDIR'
  targetName: string
  targetId: number
  workspaceId?: number
  onSuccess: () => void
}

export const RestrictedFeatureOverlay: React.FC<RestrictedFeatureOverlayProps> = ({
  type,
  targetName,
  targetId,
  workspaceId,
  onSuccess
}) => {
  const { t } = useVoerkaI18n(i18nScope)
  const config = useConfigStore(state => state.config)
  const tierConstants = (config as any)?.TIER_CONSTANTS
  const [payingType, setPayingType] = useState<'ONCE' | 'SLOT' | null>(null)
  const openSettings = useSettingsStore(state => state.openSettings)

  // 一次性消费费用及对应类型
  const onceCost =
    type === 'VDIR'
      ? (tierConstants?.prices?.spend_access_vdir ?? Infinity)
      : type === 'SPEEDY'
        ? (tierConstants?.prices?.spend_extra_speedy_dir_slot ?? Infinity)
        : (tierConstants?.prices?.spend_extra_private_dir_slot ?? Infinity)

  const onceFirecoreOp =
    type === 'VDIR'
      ? 'spend_access_vdir'
      : type === 'SPEEDY'
        ? 'spend_extra_speedy_dir_slot'
        : 'spend_extra_private_dir_slot'

  const onceName =
    type === 'VDIR'
      ? t('开通当前虚拟目录访问权限')
      : type === 'SPEEDY'
        ? t('增加一个极速目录槽位')
        : t('增加一个私有目录槽位')

  const onceDesc =
    type === 'VDIR'
      ? t('一次性消费，开通当前虚拟目录。删除此目录后无法免费再建。')
      : type === 'SPEEDY'
        ? t('永久性，为您增加一个极速目录槽位，槽位空缺就可以再免费建目录。')
        : t('永久性，为您增加一个私有目录槽位，槽位空缺就可以再免费建目录。')

  // 槽位费用及对应类型
  const slotCost =
    type === 'SPEEDY'
      ? (tierConstants?.prices?.spend_extra_speedy_dir_slot ?? Infinity)
      : type === 'PRIVATE'
        ? (tierConstants?.prices?.spend_extra_private_dir_slot ?? Infinity)
        : (tierConstants?.prices?.spend_extra_vdir_slot ?? Infinity)

  const slotFirecoreOp =
    type === 'SPEEDY'
      ? 'spend_extra_speedy_dir_slot'
      : type === 'PRIVATE'
        ? 'spend_extra_private_dir_slot'
        : 'spend_extra_vdir_slot'

  const slotName =
    type === 'VDIR'
      ? t('增加一个虚拟目录插槽')
      : type === 'SPEEDY'
        ? t('增加一个极速目录槽位')
        : t('增加一个私有目录槽位')

  const slotDesc =
    type === 'VDIR'
      ? t('永久性，为当前工作目录增加一个虚拟目录槽位，槽位空缺就可以再免费建虚拟目录。')
      : type === 'SPEEDY'
        ? t('永久性，为您增加一个极速目录槽位，槽位空缺就可以再免费建目录。')
        : t('永久性，为您增加一个私有目录槽位，槽位空缺就可以再免费建目录。')

  const handlePaymentSuccess = () => {
    useTierStore.getState().fetchProfile()
    setPayingType(null)
    onSuccess()
  }

  return (
    <div className="absolute inset-0 bg-background/60 backdrop-blur-md z-[40] flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-200">
      <div className="p-4 rounded-full bg-muted/40 mb-4 border border-border/50 shadow-sm">
        <MaterialIcon icon="lock" className="text-4xl text-muted-foreground/80" />
      </div>
      <h3 className="text-xl font-bold mb-2 tracking-wide text-foreground">
        {type === 'VDIR'
          ? t('需要激活虚拟目录「{name}」的访问权限', { name: targetName })
          : t('需要激活当前工作空间「{name}」', { name: targetName })}
      </h3>
      <p className="text-muted-foreground text-sm max-w-md mb-8 leading-relaxed">
        {type === 'VDIR'
          ? t(
              '您当前的工作目录已无可用虚拟目录槽位，需要单独开通「{name}」的访问权限或购买新的槽位。',
              { name: targetName }
            )
          : t('您已超出免费等级 {typeLabel} 目录个数限制。您可以选择开通一个新的目录槽位。', {
              typeLabel: type === 'SPEEDY' ? t('极速') : t('私有')
            })}
      </p>

      <div className="flex flex-col sm:flex-row gap-6 max-w-4xl px-4">
        {/* 卡片一：一次性激活 / 槽位购买 */}
        <div
          onClick={() => setPayingType('ONCE')}
          className="group flex flex-col p-8 rounded-2xl border-2 border-border/80 bg-card hover:border-green-500/50 hover:shadow-lg hover:shadow-green-500/5 transition-all duration-300 cursor-pointer w-80 text-left relative overflow-hidden"
        >
          <div className="absolute -top-16 -right-16 w-32 h-32 bg-green-500/5 rounded-full blur-3xl group-hover:bg-green-500/10 transition-colors" />
          <h4 className="font-bold text-base mb-3 text-foreground group-hover:text-green-500 transition-colors">
            {onceName}
          </h4>
          <p className="text-sm text-muted-foreground mb-6 leading-relaxed flex-1">{onceDesc}</p>
          <div className="text-sm font-bold text-green-600 bg-green-500/10 dark:bg-green-500/20 px-4 py-2 rounded-lg w-fit flex items-center gap-1.5">
            <MaterialIcon icon="local_fire_department" className="text-sm" />
            {onceCost} {t('萤火')}
          </div>
        </div>

        {/* 卡片二：购买插槽 */}
        {type === 'VDIR' && (
          <div
            onClick={() => setPayingType('SLOT')}
            className="group flex flex-col p-8 rounded-2xl border-2 border-border/80 bg-card hover:border-amber-400/50 hover:shadow-lg hover:shadow-amber-400/5 transition-all duration-300 cursor-pointer w-80 text-left relative overflow-hidden"
          >
            <div className="absolute -top-16 -right-16 w-32 h-32 bg-amber-400/5 rounded-full blur-3xl group-hover:bg-amber-400/10 transition-colors" />
            <h4 className="font-bold text-base mb-3 text-foreground group-hover:text-amber-500 transition-colors">
              {slotName}
            </h4>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed flex-1">{slotDesc}</p>
            <div className="text-sm font-bold text-amber-600 bg-amber-400/10 dark:bg-amber-400/20 px-4 py-2 rounded-lg w-fit flex items-center gap-1.5">
              <MaterialIcon icon="local_fire_department" className="text-sm" />
              {slotCost} {t('萤火')}
            </div>
          </div>
        )}

        {/* 卡片三：管理工作目录 - 仅在开通工作目录时显示（SPEEDY/PRIVATE），激活虚拟目录时不显示 */}
        {type !== 'VDIR' && (
          <div
            onClick={() => openSettings(SettingsCategory.MONITORING)}
            className="group flex flex-col p-8 rounded-2xl border-2 border-border/80 bg-card hover:border-blue-500/50 hover:shadow-lg hover:shadow-blue-500/5 transition-all duration-300 cursor-pointer w-80 text-left relative overflow-hidden"
          >
            <div className="absolute -top-16 -right-16 w-32 h-32 bg-blue-500/5 rounded-full blur-3xl group-hover:bg-blue-500/10 transition-colors" />
            <h4 className="font-bold text-base mb-3 text-foreground group-hover:text-blue-500 transition-colors">
              {t('管理工作目录')}
            </h4>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed flex-1">
              {t('你可以删除不需要的工作目录，以腾出槽位')}
            </p>
            <div className="text-sm font-bold text-blue-600 bg-blue-500/10 dark:bg-blue-500/20 px-4 py-2 rounded-lg w-fit flex items-center gap-1.5">
              <MaterialIcon icon="settings" className="text-sm" />
              {t('打开设置')}
            </div>
          </div>
        )}
      </div>

      {/* 支付弹窗一：一次性开通 */}
      <PaymentFlowDialog
        open={payingType === 'ONCE'}
        onOpenChange={o => {
          if (!o) setPayingType(null)
        }}
        cost={onceCost}
        firecoreOperationType={onceFirecoreOp as any}
        operationName={onceName}
        onSuccess={handlePaymentSuccess}
        metadata={{
          reference_type: type === 'VDIR' ? 'virtual_directory' : 'workspace',
          reference_id: String(targetId),
          workspaceId: type === 'VDIR' ? undefined : targetId,
          virtual_directory_id: type === 'VDIR' ? targetId : undefined
        }}
      />

      {/* 支付弹窗二：购买插槽 */}
      <PaymentFlowDialog
        open={payingType === 'SLOT'}
        onOpenChange={o => {
          if (!o) setPayingType(null)
        }}
        cost={slotCost}
        firecoreOperationType={slotFirecoreOp}
        operationName={slotName}
        onSuccess={handlePaymentSuccess}
        metadata={{
          reference_type: 'workspace',
          reference_id: String(targetId),
          workspaceId: type === 'VDIR' ? workspaceId : targetId,
          virtual_directory_id: type === 'VDIR' ? targetId : undefined
        }}
      />
    </div>
  )
}
