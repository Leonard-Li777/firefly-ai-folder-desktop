import { useConfigStore, useWelcomeStore } from './config-store'
import { useSettingsStore } from './settings-store'
import { useModelStore } from './model-store'

// 添加模型缓存以减少重复请求
const modelsCache = new Map<string, string | any[]>();

declare global {
  interface Window {
    __yonucConfigSyncRegistered?: boolean
  }
}

function registerRendererConfigSync(): void {
  if (typeof window === 'undefined') {
    return
  }

  if (window.__yonucConfigSyncRegistered) {
    return
  }

  if (!window.electronAPI?.onConfigChange) {
    return
  }

  window.__yonucConfigSyncRegistered = true
  window.electronAPI.onConfigChange(newConfig => {
    useConfigStore.getState().setConfig(newConfig)
    useSettingsStore.setState({ config: newConfig })

    if (typeof newConfig.isFirstRun === 'boolean') {
      useWelcomeStore.setState({ isFirstRun: newConfig.isFirstRun })
    }

    // 同步模型选择到 ModelStore
    // 当 SELECTED_MODEL_ID 配置变化时，更新 ModelStore 的 modelName
    // 只有在 selectedModelId 真正变化时才获取模型列表
    const currentModelName = useModelStore.getState().modelName;
    if (newConfig.selectedModelId) {
      // 检查是否真的需要更新模型名称
      if (!currentModelName || !modelsCache.has(newConfig.selectedModelId)) {
        // 获取模型列表，查找对应的模型名称
        if (window.electronAPI?.listModels) {
          window.electronAPI.listModels().then((models: any[]) => {
            // 缓存模型列表以减少重复请求
            modelsCache.set('lastModels', models);
            
            const model = models.find((m: any) => m.id === newConfig.selectedModelId)
            if (model && model.name && newConfig.selectedModelId) {
              modelsCache.set(newConfig.selectedModelId, model.name);
              useModelStore.getState().setModelName(model.name)
              console.log(`[ConfigSync] 同步模型名称: ${model.name} (ID: ${newConfig.selectedModelId})`)
            }
          }).catch((error: any) => {
            console.warn('[ConfigSync] 获取模型列表失败:', error)
          })
        }
      } else {
        // 使用缓存的模型名称
        const cachedName = modelsCache.get(newConfig.selectedModelId);
        if (cachedName && typeof cachedName === 'string' && currentModelName !== cachedName) {
          useModelStore.getState().setModelName(cachedName)
          console.log(`[ConfigSync] 使用缓存的模型名称: ${cachedName} (ID: ${newConfig.selectedModelId})`)
        }
      }
    } else {
      // 如果 selectedModelId 为空，清除 modelName
      useModelStore.getState().setModelName(null)
      console.log('[ConfigSync] 清除模型名称 (selectedModelId 为空)')
    }
  })
}

registerRendererConfigSync()
