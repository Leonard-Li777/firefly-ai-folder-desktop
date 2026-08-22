import { useConfigStore, useWelcomeStore } from './config-store'
import { useSettingsStore } from './settings-store'
import { useModelStore } from './model-store'

// 添加模型缓存以减少重复请求
const modelsCache = new Map<string, string | any[]>()
// 记录上次处理的 selectedModelId，避免缓存导致 modelName 永远不更新
let lastHandledSelectedModelId: string | undefined = undefined

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

    const aiServiceMode = newConfig.aiServiceMode || 'local'
    if (aiServiceMode !== 'cloud') {
      // 同步模型选择到 ModelStore
      // 当 SELECTED_MODEL_ID 配置变化时，更新 ModelStore 的 modelName
      // 关键修复：以 lastHandledSelectedModelId 为"是否需要重新查询"的判断依据，
      // 避免因 currentModelName 巧合等于缓存中的旧值，导致 selectedModelId 变化时 modelName 不刷新
      if (newConfig.selectedModelId) {
        if (newConfig.selectedModelId !== lastHandledSelectedModelId) {
          lastHandledSelectedModelId = newConfig.selectedModelId
          // 获取模型列表，查找对应的模型名称
          if (window.electronAPI?.listModels) {
            window.electronAPI
              .listModels()
              .then((models: any[]) => {
                // 缓存模型列表以减少重复请求
                modelsCache.set('lastModels', models)

                const matches = models.filter((m: any) => m.id === newConfig.selectedModelId)
                const model = matches[0]
                if (model && model.name && newConfig.selectedModelId) {
                  // 关键修复：缓存 key 加上 source，避免多源配置下不同 source 模型共用同一 name 缓存导致错乱
                  const cacheKey = `${newConfig.selectedModelId}::${model.source || 'default'}`
                  modelsCache.set(cacheKey, model.name)
                  modelsCache.set(newConfig.selectedModelId, model.name) // 兼容旧逻辑
                  useModelStore.getState().setModelName(model.name)
                  console.log(
                    `[ConfigSync] 同步模型名称: ${model.name} (ID: ${newConfig.selectedModelId}, source: ${model.source})`
                  )
                }
              })
              .catch((error: any) => {
                console.warn('[ConfigSync] 获取模型列表失败:', error)
              })
          }
        }
      } else {
        // 如果 selectedModelId 为空，清除 modelName
        if (lastHandledSelectedModelId !== undefined) {
          lastHandledSelectedModelId = undefined
        }
        useModelStore.getState().setModelName(null)
        console.log('[ConfigSync] 清除模型名称 (selectedModelId 为空)')
      }
    }
  })
}

registerRendererConfigSync()
