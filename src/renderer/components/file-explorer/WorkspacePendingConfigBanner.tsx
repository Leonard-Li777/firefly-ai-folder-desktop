import React, { useState, useEffect } from 'react'
import { Sparkles } from 'lucide-react'
import {
  WorkspaceDirectory,
  SettingsCategory,
  parseWorkspaceConfig,
  isWorkspaceConfigReady
} from '@firefly/types'
import { HintBanner, HintBannerLink } from '../ui/hint-banner'
import { useSettingsStore } from '../../stores/settings-store'
import { t } from '@app/languages'

interface WorkspacePendingConfigBannerProps {
  currentWorkspaceDirectory: WorkspaceDirectory | null
}

/**
 * 工作区未就绪调度门闩拦截提示横条 (TASK-01 / PRD-0044)
 */
export const WorkspacePendingConfigBanner: React.FC<WorkspacePendingConfigBannerProps> = ({
  currentWorkspaceDirectory
}) => {
  const [dismissedWorkspaceId, setDismissedWorkspaceId] = useState<number | null>(null)

  useEffect(() => {
    setDismissedWorkspaceId(null)
  }, [currentWorkspaceDirectory?.id])

  if (!currentWorkspaceDirectory) return null

  // 解析并检测当前工作区是否就绪
  const config = parseWorkspaceConfig(currentWorkspaceDirectory.workspace_config)
  const isReady = isWorkspaceConfigReady(config)

  if (isReady || (currentWorkspaceDirectory.id != null && dismissedWorkspaceId === currentWorkspaceDirectory.id)) {
    return null
  }

  const handleOpenConfig = () => {
    useSettingsStore.getState().openSettings(SettingsCategory.WORKSPACE_CONFIG, {
      workspaceId: currentWorkspaceDirectory.id
    })
  }

  return (
    <HintBanner
      icon={<Sparkles className="w-3.5 h-3.5 shrink-0 text-amber-500" />}
      actions={
        <HintBannerLink onClick={handleOpenConfig}>
          {t('立即配置以开启分析 ➔')}
        </HintBannerLink>
      }
      onClose={() => setDismissedWorkspaceId(currentWorkspaceDirectory.id ?? null)}
    >
      {t('当前工作区尚未确认 AI 分析策略，文件分析已拦截。')}
    </HintBanner>
  )
}
