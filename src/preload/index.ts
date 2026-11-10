/**
 * ModularResourceService 预加载 IPC 桥定义
 *
 * 供渲染进程 usePluginCenterStore 通过 window.electronAPI.modularResource 调用主进程
 * ModularResourceService 的生命周期编排能力与实时下载进度订阅。
 */

import { ipcRenderer } from 'electron'
import type {
  EnvironmentVisibilityEnvelope,
  IModularResourceBridge,
  ModularResourceProgressPayload,
  PluginModuleItem
} from '../renderer/stores/plugin-center-store'

export const modularResourcePreloadBridge: IModularResourceBridge = {
  list: (filter?: {
    scope?: 'market' | 'installed'
    category?: string
    includeDraft?: boolean
  }): Promise<PluginModuleItem[]> => ipcRenderer.invoke('modular-resource:list', filter),
  getDevMode: () => ipcRenderer.invoke('modular-resource:get-dev-mode'),
  setDevMode: (payload: { enabled: boolean }) =>
    ipcRenderer.invoke('modular-resource:set-dev-mode', payload),
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
  abortAll: (): Promise<boolean> => ipcRenderer.invoke('modular-resource:abort-all'),
  smokeTest: (payload: {
    profile: 'classic_light' | 'gemma_unified'
    model_paths?: Record<string, string>
    test_tokens?: string[]
  }): Promise<{ success: boolean; latency_ms?: number; error?: string }> =>
    ipcRenderer.invoke('modular-resource:smoke-test', payload),
  getPendingTombstones: () => ipcRenderer.invoke('modular-resource:get-pending-tombstones'),
  hasPendingTombstones: () => ipcRenderer.invoke('modular-resource:has-pending-tombstones'),
  restartApp: () => ipcRenderer.invoke('modular-resource:restart-app'),
  exportOfflinePackage: (payload: { moduleId: string; targetFilePath?: string }) =>
    ipcRenderer.invoke('modular-resource:export-offline-package', payload),
  importOfflinePackage: (payload?: { archivePath?: string }) =>
    ipcRenderer.invoke('modular-resource:import-offline-package', payload),
  exportOfflineBundle: (): Promise<string | null> =>
    ipcRenderer.invoke('modular-resource:export-offline-bundle'),
  getEnvironmentVisibility: (): Promise<EnvironmentVisibilityEnvelope> =>
    ipcRenderer.invoke('modular-resource:get-environment-visibility'),
  setDeveloperMode: (payload: { enabled: boolean }): Promise<EnvironmentVisibilityEnvelope> =>
    ipcRenderer.invoke('modular-resource:set-developer-mode', payload),
  onEnvironmentVisibilityChanged: (callback: (envelope: EnvironmentVisibilityEnvelope) => void) => {
    const handler = (_event: unknown, envelope: EnvironmentVisibilityEnvelope) => callback(envelope)
    ipcRenderer.on('modular-resource:environment-visibility-changed', handler as any)
    return () => {
      ipcRenderer.removeListener('modular-resource:environment-visibility-changed', handler as any)
    }
  },
  pickAndImportLocalPlugin: () =>
    ipcRenderer.invoke('modular-resource:pick-and-import-local-plugin'),
  pickDirectory: async (): Promise<string | null> => {
    const res: any = await ipcRenderer.invoke('modular-resource:pick-directory')
    if (!res || res.canceled || !res.selectedPath) return null
    return res.selectedPath
  },
  getPluginDirInfo: () => ipcRenderer.invoke('modular-resource:get-plugin-dir-info'),
  validatePluginDir: (targetPath: string) =>
    ipcRenderer.invoke('modular-resource:validate-plugin-dir', { targetPath }),
  changePluginDir: (targetPath: string) =>
    ipcRenderer.invoke('modular-resource:change-plugin-dir', { targetPath }),
  cancelDirMigration: () => ipcRenderer.invoke('modular-resource:cancel-dir-migration'),
  cleanupOldDir: () => ipcRenderer.invoke('modular-resource:cleanup-old-dir'),
  dismissOldDirCleanup: () => ipcRenderer.invoke('modular-resource:dismiss-old-dir-cleanup'),
  isOldDirCleanupDismissed: () =>
    ipcRenderer.invoke('modular-resource:is-old-dir-cleanup-dismissed'),
  onDirMigrationProgress: (callback: (payload: any) => void) => {
    const handler = (_event: unknown, payload: any) => callback(payload)
    ipcRenderer.on('modular-resource:dir-migration-progress', handler as any)
    return () => {
      ipcRenderer.removeListener('modular-resource:dir-migration-progress', handler as any)
    }
  },
  onProgress: (callback: (event: ModularResourceProgressPayload) => void) => {
    const handler = (_event: unknown, payload: ModularResourceProgressPayload) => callback(payload)
    ipcRenderer.on('modular-resource:progress', handler as any)
    return () => {
      ipcRenderer.removeListener('modular-resource:progress', handler as any)
    }
  }
}

export default modularResourcePreloadBridge
