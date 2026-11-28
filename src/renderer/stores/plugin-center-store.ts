/**
 * R-27（W6）超大文件物理拆分后的容器文件：展示前置区已迁至 `plugin-center-store.support.ts`。
 * 容器只保留主组件与编排逻辑，既有实现与注释零改动。
 */
import { create } from 'zustand'
import { t } from '@app/languages'
import {
  normalizeCapabilitySlot,
  BUILTIN_MODULE_CATALOG_META,
  BUILTIN_PLUGIN_CATALOG_META,
  type BuiltinSharedResourceId
} from '@firefly/shared'
import { DownloadProgress, EnvironmentVisibilityEnvelope, PluginCenterState, getInitialPlugins, getModularResourceBridge, normalizeRemoteModuleItem, syncDevModeFromBridge } from './plugin-center-store.support'

export const usePluginCenterStore = create<PluginCenterState>((set, get) => ({
  isOverlayOpen: false,
  focusSlot: null,
  configuringModuleId: null,
  searchKeyword: '',
  selectedCategory: 'all',
  modules: getInitialPlugins(),
  isLoading: false,
  isDeveloperMode: false,
  scope: 'market',
  environmentVisibility: null,
  isExportingBundle: false,
  isImportingBundle: false,
  isTogglingSlot: false,
  hasPendingTombstones: false,
  pendingTombstones: [],

  setOverlayOpen: async (open: boolean) => {
    set({
      isOverlayOpen: open,
      // 关闭弹层时若在配置子界面，重置回主列表
      ...(open ? {} : { configuringModuleId: null })
    })
    if (open) {
      const envVis = await get().loadEnvironmentVisibility()
      if (!envVis) {
        await syncDevModeFromBridge(set)
      }
      await get().loadModules()
    }
  },

  openOverlay: async options => {
    const focusSlot = options?.focusSlot ?? null
    set({
      isOverlayOpen: true,
      focusSlot,
      ...(focusSlot
        ? {
            scope: 'market' as const,
            selectedCategory: 'all',
            searchKeyword: ''
          }
        : {})
    })
    const envVis = await get().loadEnvironmentVisibility()
    if (!envVis) {
      await syncDevModeFromBridge(set)
    }
    await get().loadModules()
  },

  clearFocusSlot: () => {
    set({ focusSlot: null })
  },

  closeOverlay: () => {
    set({ isOverlayOpen: false, configuringModuleId: null, focusSlot: null })
  },

  toggleOverlay: async () => {
    const next = !get().isOverlayOpen
    set({
      isOverlayOpen: next,
      ...(next ? {} : { configuringModuleId: null })
    })
    if (next) {
      const envVis = await get().loadEnvironmentVisibility()
      if (!envVis) {
        await syncDevModeFromBridge(set)
      }
      await get().loadModules()
    }
  },

  setSearchKeyword: (keyword: string) => {
    set({ searchKeyword: keyword })
  },

  setSelectedCategory: (category: string) => {
    set({ selectedCategory: category })
  },

  applyVisibilityEnvelope: (envelope: EnvironmentVisibilityEnvelope) => {
    if (!envelope || typeof envelope !== 'object') return false
    const current = get().environmentVisibility
    // 双锚定时钟防护：仅当跨 epoch 或同一 epoch 内 revision 递增时才采纳
    if (!current || envelope.epoch !== current.epoch || envelope.revision > current.revision) {
      set({
        environmentVisibility: envelope,
        isDeveloperMode: !!envelope.visibility?.developerModeEnabled
      })
      return true
    }
    // 旧 revision 迟到或倒流，丢弃更新
    return false
  },

  loadEnvironmentVisibility: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.getEnvironmentVisibility !== 'function') return null
    try {
      const envelope = await bridge.getEnvironmentVisibility()
      if (envelope) {
        get().applyVisibilityEnvelope(envelope)
        return envelope
      }
      return null
    } catch {
      return null
    }
  },

  subscribeEnvironmentVisibility: () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.onEnvironmentVisibilityChanged !== 'function') {
      return () => undefined
    }
    return bridge.onEnvironmentVisibilityChanged(envelope => {
      get().applyVisibilityEnvelope(envelope)
    })
  },

  setDeveloperMode: async (enabled: boolean) => {
    set({ isDeveloperMode: enabled })
    const bridge = getModularResourceBridge()
    if (bridge) {
      if (typeof bridge.setDeveloperMode === 'function') {
        try {
          const envelope = await bridge.setDeveloperMode({ enabled })
          if (envelope) {
            get().applyVisibilityEnvelope(envelope)
          }
        } catch {
          // 降级忽略
        }
      } else if (typeof bridge.setDevMode === 'function') {
        try {
          await bridge.setDevMode({ enabled })
        } catch {
          // 降级忽略
        }
      }
    }
    await get().loadModules()
  },

  setScope: (scope: 'market' | 'installed') => {
    set({ scope })
    void get().loadModules()
  },

  setConfiguringModuleId: (id: string | null) => {
    set({ configuringModuleId: id })
  },

  pickAndImportLocalPlugin: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.pickAndImportLocalPlugin !== 'function') {
      return false
    }
    try {
      const res = await bridge.pickAndImportLocalPlugin()
      if (res && !res.canceled && res.module) {
        await get().loadModules()
        return true
      }
      return false
    } catch {
      return false
    }
  },

  loadModules: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.list !== 'function') {
      return get().modules
    }
    set({ isLoading: true })
    try {
      const filter = {
        scope: get().scope,
        includeDraft: get().isDeveloperMode
      }
      const list = await bridge.list(filter)
      if (Array.isArray(list)) {
        const normalized = list.map(normalizeRemoteModuleItem)
        set({ modules: normalized, isLoading: false })
        get()
          .checkPendingTombstones()
          .catch(() => undefined)
        return normalized
      }
      set({ isLoading: false })
      return get().modules
    } catch {
      set({ isLoading: false })
      return get().modules
    }
  },

  installPlugin: async (id: string) => {
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          install_state: 'downloading',
          error_message: null,
          download_progress: {
            percentage: 0,
            speed_bytes_per_sec: 0,
            is_resumed: false
          }
        }
      })
    }))

    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.install === 'function') {
      try {
        const updated = await bridge.install(id)
        if (updated) {
          const norm = normalizeRemoteModuleItem(updated)
          set(state => ({
            modules: state.modules.map(m => (m.id === id ? norm : m))
          }))
          get()
            .checkPendingTombstones()
            .catch(() => undefined)
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err)
        set(state => ({
          modules: state.modules.map(m =>
            m.id === id ? { ...m, install_state: 'error', error_message: errMsg } : m
          )
        }))
      }
    }
  },

  uninstallPlugin: async (id: string) => {
    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.uninstall === 'function') {
      const updated = await bridge.uninstall(id)
      // 卸载可能触发必选底座原子接替或跨模块状态变化，重新同步后端权威事实源
      await get().loadModules()
      if (updated) {
        const norm = normalizeRemoteModuleItem(updated)
        set(state => ({
          modules: state.modules.map(m => (m.id === id ? norm : m))
        }))
      }
      get()
        .checkPendingTombstones()
        .catch(() => undefined)
    } else {
      set(state => ({
        modules: state.modules.map(m =>
          m.id === id
            ? {
                ...m,
                install_state: 'not_installed',
                is_crashed: false,
                download_progress: undefined
              }
            : m
        )
      }))
    }
  },

  togglePluginActive: async (id: string, active: boolean) => {
    if (get().isTogglingSlot) return
    const currentModules = get().modules
    const target = currentModules.find(m => m.id === id)
    if (!target) return

    // 核心不变量：必选底座禁止停用 (TC-02)
    if (target.slot_policy === 'exclusive_required' && !active) {
      console.warn(`[PluginCenterStore] 拒绝停用必选底座: ${id}`)
      return
    }

    set({ isTogglingSlot: true })
    try {
      // 检查槽位排他策略 (exclusive_required / exclusive_optional)
      const isExclusive =
        target.slot_policy === 'exclusive_required' || target.slot_policy === 'exclusive_optional'
      const targetSlot = normalizeCapabilitySlot(target.capability_slot)

      set(state => ({
        modules: state.modules.map(m => {
          if (m.id === id) {
            return {
              ...m,
              install_state: active ? 'active' : 'installed_inactive',
              can_activate: active ? false : true
            }
          }
          if (
            active &&
            isExclusive &&
            targetSlot &&
            normalizeCapabilitySlot(m.capability_slot) === targetSlot &&
            m.id !== id
          ) {
            return {
              ...m,
              install_state: 'installed_inactive',
              can_activate: true
            }
          }
          return m
        })
      }))

      const bridge = getModularResourceBridge()
      if (bridge && typeof bridge.updateState === 'function') {
        try {
          const updated = await bridge.updateState(id, { active })
          if (typeof bridge.list === 'function') {
            await get().loadModules()
          } else if (updated) {
            const norm = normalizeRemoteModuleItem(updated)
            set(state => ({
              modules: state.modules.map(m => (m.id === id ? norm : m))
            }))
          }
        } catch (err) {
          // 后端拒绝切换或模型拉起失败：坚决还原真实状态，拒绝虚假乐观假死
          set({ modules: currentModules })
          throw err
        }
      }
    } finally {
      set({ isTogglingSlot: false })
    }
  },

  updateUserConfig: async (id: string, userConfig: string | null) => {
    const currentModules = get().modules
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          user_config: userConfig
        }
      })
    }))

    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.updateState === 'function') {
      try {
        const updated = await bridge.updateState(id, { userConfig })
        if (updated) {
          const norm = normalizeRemoteModuleItem(updated)
          set(state => ({
            modules: state.modules.map(m => (m.id === id ? norm : m))
          }))
        }
      } catch (err) {
        // 保存失败或参数格式非法：强制回滚本地配置状态并将错误显式上抛
        set({ modules: currentModules })
        throw err
      }
    }
  },

  updateDownloadProgress: (id: string, progress: DownloadProgress) => {
    set(state => ({
      modules: state.modules.map(m => {
        if (m.id !== id) return m
        return {
          ...m,
          install_state: m.install_state === 'active' ? 'active' : 'downloading',
          download_progress: progress
        }
      })
    }))
  },

  subscribeProgress: () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.onProgress !== 'function') {
      return () => undefined
    }
    return bridge.onProgress(evt => {
      if (evt.state === 'failed') {
        set(state => ({
          modules: state.modules.map(m =>
            m.id === evt.moduleId
              ? {
                  ...m,
                  install_state: 'error',
                  error_message: evt.errorMessage || t('下载失败')
                }
              : m
          )
        }))
        return
      }
      if (evt.state === 'completed') {
        // 先将进度置为 100%（防止资源解压完成后等待 Omni 挂载激活期间界面一直停在 0%），再拉取权威事实源刷新状态
        get().updateDownloadProgress(evt.moduleId, {
          percentage: 100,
          speed_bytes_per_sec: 0,
          is_resumed: false
        })
        void get().loadModules()
        return
      }
      get().updateDownloadProgress(evt.moduleId, {
        percentage: evt.percentage,
        speed_bytes_per_sec: evt.speedBytesPerSec,
        is_resumed: evt.isResumed
      })
    })
  },

  checkPendingTombstones: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.getPendingTombstones !== 'function') return
    try {
      const items = await bridge.getPendingTombstones()
      const has = Array.isArray(items) && items.length > 0
      set({ pendingTombstones: items || [], hasPendingTombstones: has })
    } catch {
      // 忽略墓碑读取异常
    }
  },

  restartApp: async () => {
    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.restartApp === 'function') {
      await bridge.restartApp()
    }
  },

  markPluginCrashed: (pluginId: string) => {
    set(state => ({
      modules: state.modules.map(m =>
        m.id === pluginId
          ? {
              ...m,
              is_crashed: true,
              is_running: false,
              error_message: t('插件宿主已崩溃，点击重试恢复')
            }
          : m
      )
    }))
  },

  restartPlugin: async (pluginId: string) => {
    set(state => ({
      modules: state.modules.map(m =>
        m.id === pluginId ? { ...m, is_crashed: false, is_running: true, error_message: null } : m
      )
    }))
    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.updateState === 'function') {
      try {
        await bridge.updateState(pluginId, { active: true })
      } catch (err) {
        console.error(`[PluginCenterStore] Failed to restart plugin ${pluginId}:`, err)
        set(state => ({
          modules: state.modules.map(m =>
            m.id === pluginId
              ? { ...m, is_crashed: true, is_running: false, error_message: String(err) }
              : m
          )
        }))
        return false
      }
    }
    await get().loadModules()
    return true
  },

  exportOfflinePackage: async (moduleId: string) => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.exportOfflinePackage !== 'function') return null
    return bridge.exportOfflinePackage({ moduleId })
  },

  exportOfflineBundle: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.exportOfflineBundle !== 'function') return null
    set({ isExportingBundle: true })
    try {
      return await bridge.exportOfflineBundle()
    } finally {
      set({ isExportingBundle: false })
    }
  },

  importOfflinePackage: async (archivePath?: string) => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.importOfflinePackage !== 'function') return null
    set({ isImportingBundle: true })
    try {
      const res = await bridge.importOfflinePackage({ archivePath })
      if (res) {
        await get().loadModules()
        return res
      }
      return null
    } finally {
      set({ isImportingBundle: false })
    }
  },

  // 目录管理与安全迁移状态 (Issue 02 - 06)
  dirInfo: null,
  dirPhase: 'STABLE',
  isOldDirCleanupDismissed: false,
  dirMigrationProgress: null,

  pickDirectory: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.pickDirectory !== 'function') {
      return null
    }
    return await bridge.pickDirectory()
  },

  loadDirInfo: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.getPluginDirInfo !== 'function') return null
    try {
      const info = await bridge.getPluginDirInfo()
      if (info) {
        set({ dirInfo: info, dirPhase: info.phase || 'STABLE' })
      }
      if (typeof bridge.isOldDirCleanupDismissed === 'function') {
        const dismissed = await bridge.isOldDirCleanupDismissed()
        set({ isOldDirCleanupDismissed: !!dismissed })
      }
      return info
    } catch {
      return null
    }
  },

  validatePluginDir: async (targetPath: string) => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.validatePluginDir !== 'function') {
      return { valid: false, errorCode: 'PATH_NOT_WRITABLE', errorMessage: 'Bridge unavailable' }
    }
    return await bridge.validatePluginDir(targetPath)
  },

  changePluginDir: async (targetPath: string) => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.changePluginDir !== 'function') {
      return { success: false, errorCode: 'PATH_NOT_WRITABLE' }
    }
    set({ dirPhase: 'MIGRATING' })
    try {
      const res = await bridge.changePluginDir(targetPath)
      await get().loadDirInfo()
      return res
    } catch (err: any) {
      await get().loadDirInfo()
      return { success: false, errorCode: err?.code || 'UNKNOWN_ERROR' }
    }
  },

  cancelDirMigration: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.cancelDirMigration !== 'function') {
      return { cancelled: false }
    }
    const res = await bridge.cancelDirMigration()
    await get().loadDirInfo()
    return res
  },

  cleanupOldDir: async () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.cleanupOldDir !== 'function') {
      return { success: false, freedBytes: 0 }
    }
    const res = await bridge.cleanupOldDir()
    await get().loadDirInfo()
    return res
  },

  dismissOldDirCleanup: async () => {
    const bridge = getModularResourceBridge()
    if (bridge && typeof bridge.dismissOldDirCleanup === 'function') {
      await bridge.dismissOldDirCleanup()
    }
    set({ isOldDirCleanupDismissed: true })
  },

  subscribeDirMigrationProgress: () => {
    const bridge = getModularResourceBridge()
    if (!bridge || typeof bridge.onDirMigrationProgress !== 'function') {
      return () => {}
    }
    return bridge.onDirMigrationProgress((payload: any) => {
      set({ dirMigrationProgress: payload })
      if (payload) {
        const isDone =
          payload.phase === 'DONE' ||
          (payload.phase === 'committing' && (payload.percentage ?? 0) >= 100)
        set({ dirPhase: isDone ? 'PENDING_RESTART' : 'MIGRATING' })
      }
    })
  },

  resetForTest: () => {
    set({
      isOverlayOpen: false,
      configuringModuleId: null,
      searchKeyword: '',
      selectedCategory: 'all',
      modules: getInitialPlugins(),
      isLoading: false,
      isDeveloperMode: false,
      scope: 'market',
      environmentVisibility: null,
      isExportingBundle: false,
      isImportingBundle: false,
      isTogglingSlot: false,
      hasPendingTombstones: false,
      pendingTombstones: [],
      dirInfo: null,
      dirPhase: 'STABLE',
      isOldDirCleanupDismissed: false,
      dirMigrationProgress: null
    })
  }
}))

// 渲染层全局挂载插件崩溃事件监听 (支持生产环境 modularResource.onCrash 与 E2E 探针)
if (typeof window !== 'undefined') {
  const win = window as any
  const modular = win.electronAPI?.modularResource
  const e2eProbe = win.__e2e_probe_bridge
  const e2eApi = win.electronAPI

  const onCrashHandler = (data: any) => {
    if (data?.pluginId) {
      usePluginCenterStore.getState().markPluginCrashed(data.pluginId)
    }
  }

  if (modular && typeof modular.onCrash === 'function') {
    modular.onCrash(onCrashHandler)
  } else if (e2eProbe && typeof e2eProbe.onPluginCrash === 'function') {
    e2eProbe.onPluginCrash(onCrashHandler)
  } else if (e2eApi && typeof e2eApi.onPluginCrash === 'function') {
    e2eApi.onPluginCrash(onCrashHandler)
  }
}


/**
 * 兼容出口（R-27 拆分后）：类型与纯工具函数仍从本模块统一导入，
 * 历史调用点（preload / 弹层 / 欢迎向导等）零改动。
 */
export * from './plugin-center-store.support'
