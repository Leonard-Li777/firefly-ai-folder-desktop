import { toast } from '../components/common/Toast'
import { t } from '@app/languages'
import { useSettingsStore } from '../stores/settings-store'
import { SettingsCategory } from '@firefly/types'
import type { EnqueueResult } from '../../shared/types/electron-api'

/**
 * 统一处理入队操作的 Toast 提示与门闩拦截引导
 */
export function notifyEnqueueResult(result?: EnqueueResult | null) {
  if (!result) {
    toast.success(t('已加入分析队列'))
    return
  }

  // 1. 全部被调度门闩拦截（工作区未完成策略配置）
  if (result.blockedCount > 0 && result.addedCount === 0 && result.updatedCount === 0) {
    const wsId = result.blockedWorkspaces?.[0]
    toast.warning(
      t('当前工作区尚未配置 AI 策略，已拦截入队。请先完成工作区配置。'),
      6000,
      undefined,
      {
        label: t('前往配置'),
        onClick: () => {
          useSettingsStore.getState().openSettings(SettingsCategory.WORKSPACE_CONFIG, {
            workspaceId: wsId
          })
        }
      }
    )
    return
  }

  // 2. 部分被门闩拦截，部分入队成功
  if (result.blockedCount > 0 && (result.addedCount > 0 || result.updatedCount > 0)) {
    const wsId = result.blockedWorkspaces?.[0]
    toast.info(
      t('已添加 {count} 项，另有 {blocked} 项因工作区尚未配置策略被跳过', {
        count: result.addedCount + result.updatedCount,
        blocked: result.blockedCount
      }),
      6000,
      undefined,
      {
        label: t('前往配置'),
        onClick: () => {
          useSettingsStore.getState().openSettings(SettingsCategory.WORKSPACE_CONFIG, {
            workspaceId: wsId
          })
        }
      }
    )
    return
  }

  // 3. 入队或更新成功
  if (result.addedCount > 0 || result.updatedCount > 0) {
    toast.success(t('已加入分析队列'))
    return
  }

  // 4. 重复或无需重复分析
  toast.info(t('未添加新文件（文件可能已在队列中或已分析）'))
}
