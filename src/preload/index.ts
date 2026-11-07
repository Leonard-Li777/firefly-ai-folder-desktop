/**
 * ModularResourceService 预加载 IPC 桥定义
 *
 * 供渲染进程 usePluginCenterStore 通过 window.electronAPI.modularResource 调用主进程
 * ModularResourceService 的生命周期编排能力与实时下载进度订阅。
 */

import { ipcRenderer } from 'electron'
import type {
  IModularResourceBridge,
  ModularResourceProgressPayload,
  PluginModuleItem
} from '../renderer/stores/plugin-center-store'

export const modularResourcePreloadBridge: IModularResourceBridge = {
  list: (): Promise<PluginModuleItem[]> => ipcRenderer.invoke('modular-resource:list'),
  install: (moduleId: string): Promise<PluginModuleItem> =>
    ipcRenderer.invoke('modular-resource:install', moduleId),
  uninstall: (moduleId: string): Promise<PluginModuleItem> =>
    ipcRenderer.invoke('modular-resource:uninstall', moduleId),
  updateState: (
    moduleId: string,
    patch: {
      active?: boolean
      userConfig?: Record<string, unknown> | string | null
      selectedVariant?: string
      userConsent?: boolean
    }
  ): Promise<PluginModuleItem> =>
    ipcRenderer.invoke('modular-resource:update-state', moduleId, patch),
  onProgress: (callback: (event: ModularResourceProgressPayload) => void) => {
    const handler = (_event: unknown, payload: ModularResourceProgressPayload) => callback(payload)
    ipcRenderer.on('modular-resource:progress', handler as any)
    return () => {
      ipcRenderer.removeListener('modular-resource:progress', handler as any)
    }
  }
}

export default modularResourcePreloadBridge
