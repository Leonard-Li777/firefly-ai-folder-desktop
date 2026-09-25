import { useConfigStore, useWelcomeStore } from './config-store'
import { useSettingsStore } from './settings-store'

declare global {
  interface Window {
    __fireflyConfigSyncRegistered?: boolean
  }
}

function registerRendererConfigSync(): void {
  if (typeof window === 'undefined') {
    return
  }

  if (window.__fireflyConfigSyncRegistered) {
    return
  }

  if (!window.electronAPI?.onConfigChange) {
    return
  }

  window.__fireflyConfigSyncRegistered = true
  window.electronAPI.onConfigChange(newConfig => {
    useConfigStore.getState().setConfig(newConfig)
    useSettingsStore.setState({ config: newConfig })

    if (typeof newConfig.isFirstRun === 'boolean') {
      useWelcomeStore.setState({ isFirstRun: newConfig.isFirstRun })
    }

    // PRD-0044：SELECTED_MODEL_ID 配置键删除，原「selectedModelId → ModelStore.modelName」同步链已摘除；
    // 本地模型身份唯一真相 = 萤核AI引擎桥接快照，展示名经 ai-status 事件（model-store）刷新
  })
}

registerRendererConfigSync()
