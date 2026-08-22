import { t } from '@app/languages'

export interface FirecoreEarnRule {
  operation: string
  description: string
  reward: number
  bonus?: number
  conditions?: string
}

export interface FirecoreSpendRule {
  operation: string
  description: string
  freePrice: number
  proPrice: number
  enterprisePrice: number
  isPermanent?: boolean
  note?: string
}

export const getFirecoreRules = (prices: Record<string, number>) => ({
  earn: [
    {
      operation: 'invite_friend',
      description: t('邀请好友'),
      reward: prices['inviteFirecoreReward'] ?? 0,
      bonus: prices['inviteQuotaBonus'] ?? 0,
      conditions: t('每成功邀请一位好友')
    }
  ],
  spend: [
    {
      operation: 'unlock_private_unlimited',
      description: t('解锁私有目录无限额度（邀请3人即可解锁）'),
      freePrice: prices['spend_unlock_analysis'] ?? 0,
      proPrice: 0,
      enterprisePrice: 0,
      isPermanent: true
    },
    {
      operation: 'add_private_dir',
      description: t('+1 私有目录槽位'),
      freePrice: prices['spend_extra_private_dir_slot'] ?? 0,
      proPrice: 0,
      enterprisePrice: 0,
      isPermanent: true
    },
    {
      operation: 'add_speedy_dir',
      description: t('+1 极速目录槽位'),
      freePrice: prices['spend_extra_speedy_dir_slot'] ?? 0,
      proPrice: 0,
      enterprisePrice: 0,
      isPermanent: true
    },
    {
      operation: 'add_vdir_slot',
      description: t('+1 虚拟目录槽位（指定工作目录）'),
      freePrice: prices['spend_extra_vdir_slot'] ?? 0,
      proPrice: 0,
      enterprisePrice: 0,
      isPermanent: true
    },
    {
      operation: 'access_vdir',
      description: t('+1 虚拟目录（单次）'),
      freePrice: prices['spend_access_vdir'] ?? 0,
      proPrice: 0,
      enterprisePrice: 0,
      isPermanent: false
    },
    {
      operation: 'regenerate_vdir',
      description: t('重新生成虚拟目录（单次）'),
      freePrice: prices['spend_regenerate_vdir'] ?? 0,
      proPrice: 0,
      enterprisePrice: 0
    },
    {
      operation: 'export_vdir',
      description: t('导出虚拟目录（单次）'),
      freePrice: prices['spend_export_vdir'] ?? 0,
      proPrice: 0,
      enterprisePrice: 0
    },
    {
      operation: 'export_real_dir',
      description: t('导出真实目录（单次）'),
      freePrice: prices['spend_export_rdir'] ?? 0,
      proPrice: 0,
      enterprisePrice: 0
    }
  ]
})
