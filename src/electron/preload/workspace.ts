// 由 preload.ts 按领域分片（工单 01 preload IPC 桥拆分）。正文为原 electronAPI 区间逐字节等价搬运、零行为改动、零顶层 key 增删。

import type { WorkspaceDirectory } from '@firefly/types'
import { ipcRenderer } from 'electron'
import { logger } from './shared-context'

export const workspaceApi = {
  // Window controls
  window: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    close: () => ipcRenderer.invoke('window-close')
  },

  // 文件预览相关（预览窗口 + 临时图片转码 + 文本限流读取 + 会话级流式挂载）
  preview: {
    openNewWindow: (filePath: string) => ipcRenderer.invoke('preview/open-new-window', filePath),
    getTempImage: (filePath: string) => ipcRenderer.invoke('preview/get-temp-image', filePath),
    readTextLimit: (filePath: string, limit?: number) =>
      ipcRenderer.invoke('preview/read-text-limit', filePath, limit),
    mountSession: (sessionId: string, filePath: string): Promise<boolean> =>
      ipcRenderer.invoke('preview:mount-session', sessionId, filePath),
    unmountSession: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('preview:unmount-session', sessionId)
  },

  // 用户等级和萤火
  userTier: {
    getProfile: (): Promise<{
      tier: string
      firecores: number
      ref_code?: string
      computed_limits: any
      entitlements: string[]
      counters?: Record<string, any>
      subscription?: {
        status: string
        expires_at?: string
        plan_id: string
      }
    }> => ipcRenderer.invoke('userTier/getProfile'),
    redeemInvitationCode: (inviterRef: string) =>
      ipcRenderer.invoke('invitation/redeem', inviterRef),
    syncFromCloud: (): Promise<any> => ipcRenderer.invoke('userTier/syncFromCloud'),
    getConsumptionDetails: (): Promise<any[]> =>
      ipcRenderer.invoke('userTier/getConsumptionDetails'),
    spendFirecores: (
      firecores: number,
      type?: string,
      metadata?: Record<string, any>
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('userTier/spendFirecores', firecores, type, metadata),
    checkQuota: (operation: {
      type: string
      currentCount: number
      amount?: number
    }): Promise<{ allowed: boolean; current: number; limit: number; reason?: string }> =>
      ipcRenderer.invoke('userTier/checkQuota', operation),
    onFirecoreTransactionsUpdated: (callback: (data: any[]) => void) => {
      ipcRenderer.on('userTier/firecoreTransactionsUpdated', (_event, data) => callback(data))
    },
    removeFirecoreTransactionsUpdated: () => {
      ipcRenderer.removeAllListeners('userTier/firecoreTransactionsUpdated')
    },
    onProfileChanged: (callback: () => void) => {
      ipcRenderer.on('userTier/profileChanged', () => callback())
    },
    removeProfileChanged: () => {
      ipcRenderer.removeAllListeners('userTier/profileChanged')
    },
    onTransactionFailed: (callback: (data: { message: string }) => void) => {
      ipcRenderer.on('userTier/transactionFailed', (_event, data) => callback(data))
    },
    removeTransactionFailed: () => {
      ipcRenderer.removeAllListeners('userTier/transactionFailed')
    },
    onDeviceUnbound: (callback: () => void) => {
      ipcRenderer.on('userTier/deviceUnbound', () => callback())
    },
    removeDeviceUnbound: () => {
      ipcRenderer.removeAllListeners('userTier/deviceUnbound')
    }
  },

  deviceBind: {
    getStatus: (): Promise<any> => ipcRenderer.invoke('deviceBind/getStatus'),
    createCode: (payload?: { forceRefresh?: boolean }): Promise<any> =>
      ipcRenderer.invoke('deviceBind/createCode', payload),
    pollResult: (payload: { code: string; pollSecret: string }): Promise<any> =>
      ipcRenderer.invoke('deviceBind/pollResult', payload),
    sendEmailOtp: (payload: { email: string }): Promise<any> =>
      ipcRenderer.invoke('deviceBind/sendEmailOtp', payload),
    completeEmailBinding: (payload: {
      email: string
      code: string
      invitationCode?: string
    }): Promise<any> => ipcRenderer.invoke('deviceBind/completeEmailBinding', payload),
    completeOaContactBinding: (payload?: { invitationCode?: string }): Promise<any> =>
      ipcRenderer.invoke('deviceBind/completeOaContactBinding', payload),
    hasActiveBindSession: (): Promise<boolean> =>
      ipcRenderer.invoke('deviceBind/hasActiveBindSession'),
    resetToQr: (): Promise<any> => ipcRenderer.invoke('deviceBind/resetToQr'),
    getUnseatedSession: (): Promise<any> => ipcRenderer.invoke('deviceBind/getUnseatedSession'),
    seatDevice: (payload: { sessionToken?: string; evictDeviceId?: string | null }): Promise<any> =>
      ipcRenderer.invoke('deviceBind/seatDevice', payload),
    listSeatedDevices: (payload?: { sessionToken?: string }): Promise<any> =>
      ipcRenderer.invoke('deviceBind/listSeatedDevices', payload),
    unbindDevice: (payload?: { deviceId?: string; machineId?: string }): Promise<any> =>
      ipcRenderer.invoke('deviceBind/unbindDevice', payload),
    logout: (): Promise<any> => ipcRenderer.invoke('deviceBind/logout')
  },

  // 工作目录管理
  addWorkspaceDirectory: (directory: WorkspaceDirectory): Promise<void> =>
    ipcRenderer.invoke('add-workspace-directory', directory),

  getAllWorkspaceDirectories: (): Promise<WorkspaceDirectory[]> =>
    ipcRenderer.invoke('get-all-workspace-directories'),

  getCurrentWorkspaceDirectory: (): Promise<WorkspaceDirectory | null> =>
    ipcRenderer.invoke('get-current-workspace-directory'),

  setCurrentWorkspaceDirectory: (path: string): Promise<void> =>
    ipcRenderer.invoke('set-current-workspace-directory', path),

  deleteWorkspaceDirectory: (
    path: string
  ): Promise<{ success: boolean; error?: string; warning?: string }> =>
    ipcRenderer.invoke('delete-workspace-directory', path),

  resetWorkspaceDirectory: (directoryPath: string): Promise<void> =>
    ipcRenderer.invoke('reset-workspace-directory', directoryPath),

  getWorkspaceConfig: (workspaceId: number) =>
    ipcRenderer.invoke('get-workspace-config', workspaceId),
  updateWorkspaceConfig: (workspaceId: number, config: any) =>
    ipcRenderer.invoke('update-workspace-config', workspaceId, config),
  commitWorkspacePolicy: (params: any) => ipcRenderer.invoke('commit-workspace-policy', params),
  updateWorkspaceWhitelist: (workspaceId: number, patterns: string[]) =>
    ipcRenderer.invoke('update-workspace-whitelist', workspaceId, patterns),
  previewWorkspaceWhitelistImpact: (workspaceId: number, patterns: string[]) =>
    ipcRenderer.invoke('preview-workspace-whitelist-impact', workspaceId, patterns),
  updateWorkspaceInclusion: (workspaceId: number, patterns: string[]) =>
    ipcRenderer.invoke('update-workspace-inclusion', workspaceId, patterns),
  previewWorkspaceInclusionImpact: (workspaceId: number, patterns: string[]) =>
    ipcRenderer.invoke('preview-workspace-inclusion-impact', workspaceId, patterns),
  updateWorkspaceBoundWorkflow: (workspaceId: number, workflowId: string | null) =>
    ipcRenderer.invoke('update-workspace-bound-workflow', workspaceId, workflowId),

  // 统一补丁化策略变更通道 [SLICE-07]：顶层平铺暴露（不存在 window.electronAPI.workspace 命名空间）
  applyWorkspacePolicyMutation: (workspaceId: number, mutation: unknown) =>
    ipcRenderer.invoke('apply-workspace-policy-mutation', workspaceId, mutation),

  // 只读运行时上下文桥接（通道注册由 WorkspaceRuntimeContextService 完成）
  getWorkspaceRuntimeContextSnapshot: (workspaceId?: number | null) =>
    ipcRenderer.invoke('workspace-runtime-context:get-snapshot', workspaceId),
  triggerWorkspaceIncrementalRecovery: (
    workspaceId: number
  ): Promise<{ success: boolean; queued?: number; error?: string }> =>
    ipcRenderer.invoke('trigger-workspace-incremental-recovery', workspaceId),

  // 待补全恢复：清单 / 清除 / 横幅关闭 / 入队补全（通道注册由 WorkspaceRuntimeContextService 完成）
  getWorkspaceRecoveryQueue: (workspaceId: number) =>
    ipcRenderer.invoke('get-workspace-recovery-queue', workspaceId),
  clearWorkspaceRecoveryItems: (workspaceId: number, workspaceFileIds: number[]) =>
    ipcRenderer.invoke('clear-workspace-recovery-items', workspaceId, workspaceFileIds),
  dismissWorkspaceRecoveryBanner: (workspaceId: number) =>
    ipcRenderer.invoke('dismiss-workspace-recovery-banner', workspaceId),
  enqueueWorkspaceRecoveryItems: (workspaceId: number, workspaceFileIds?: number[]) =>
    ipcRenderer.invoke('enqueue-workspace-recovery-items', workspaceId, workspaceFileIds),

  // 长视频空闲单切片补全控制通道（Spec §3.5）
  listWorkspacePendingBackfillVideos: (workspaceId: number) =>
    ipcRenderer.invoke('video-backfill:list-workspace', { workspaceId }),
  startVideoBackfill: (workspaceId?: number): Promise<{ started: boolean }> =>
    ipcRenderer.invoke('video-backfill:start', workspaceId != null ? { workspaceId } : undefined),
  pauseVideoBackfill: (): Promise<{ paused: boolean }> =>
    ipcRenderer.invoke('video-backfill:pause'),
  prioritizeVideoBackfill: (
    workspaceId: number,
    fileFingerprint: string
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('video-backfill:prioritize', { workspaceId, fileFingerprint }),
  retryFailedVideoBackfill: (workspaceId: number): Promise<{ resetCount: number }> =>
    ipcRenderer.invoke('video-backfill:retry-failed', { workspaceId }),
  onWorkspaceRuntimeContextUpdated: (callback: (data: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('workspace-runtime-context-updated', listener as any)
    // 返回精确卸载函数，避免 removeAllListeners 误杀同 channel 其他订阅者
    return () => {
      ipcRenderer.removeListener('workspace-runtime-context-updated', listener as any)
    }
  },
  getLocalWorkflows: (filter?: {
    source?: string
    category?: string
  }): Promise<{ success: boolean; data: any[]; error?: string }> =>
    ipcRenderer.invoke('get-local-workflows', filter),

  rescanWorkspaceDirectory: (workspaceId: number): Promise<any> =>
    ipcRenderer.invoke('rescanWorkspaceDirectory', workspaceId),

  database: {
    resetAnalysisDatabase: (): Promise<void> => ipcRenderer.invoke('resetAnalysisDatabase'),
    getAnalysisIgnoreRules: (): Promise<any[]> => ipcRenderer.invoke('getAnalysisIgnoreRules'),
    saveAnalysisIgnoreRules: (rules: any[]): Promise<void> =>
      ipcRenderer.invoke('saveAnalysisIgnoreRules', rules)
  },

  getDatabase: () => ({
    prepare: (sql: string) => ({
      get: (...params: any[]) => ipcRenderer.invoke('database/execute-get', sql, params),
      all: (...params: any[]) => ipcRenderer.invoke('database/execute-all', sql, params),
      run: (...params: any[]) => ipcRenderer.invoke('database/execute-run', sql, params)
    })
  }),

  triggerCloudSync: (): Promise<any> => ipcRenderer.invoke('cloud-sync/trigger-sync'),

  updateWorkspaceDirectoryAutoWatch: (workspaceId: number, autoWatch: boolean): Promise<void> =>
    ipcRenderer.invoke('update-workspace-directory-auto-watch', workspaceId, autoWatch),

  // 独立队列窗口控制 API
  openQueueWindow: (): Promise<void> => ipcRenderer.invoke('open-queue-window'),
  closeQueueWindow: (): Promise<void> => ipcRenderer.invoke('close-queue-window'),
  focusQueueWindow: (): Promise<void> => ipcRenderer.invoke('focus-queue-window'),
  toggleQueueWindow: (): Promise<void> => ipcRenderer.invoke('toggle-queue-window'),
  setQueueViewMode: (data: { mode: 'split' | 'window'; isSplitOpen: boolean }): Promise<void> =>
    ipcRenderer.invoke('set-queue-view-mode', data),
  onQueueViewModeChanged: (
    callback: (data: { mode: 'split' | 'window'; isSplitOpen: boolean }) => void
  ) => {
    ipcRenderer.on('queue-view-mode-changed', (_event, data) => callback(data))
  },
  removeQueueViewModeChanged: () => {
    ipcRenderer.removeAllListeners('queue-view-mode-changed')
  },
  queueWindowControl: (action: 'minimize' | 'maximize' | 'unmaximize' | 'close'): Promise<void> =>
    ipcRenderer.invoke('queue-window-control', action),

  // 全局公共资源目录（缩略图与语音合成音频共享目录）设置 API
  commonResourceDir: {
    getInfo: (): Promise<{
      success: boolean
      data?: {
        currentPath: string
        configuredPath: string
        defaultPath: string
        isCustom: boolean
        isFallback: boolean
        fallbackReason?: string
        thumbnailsDir: string
        audioSynthesisDir: string
      }
      error?: string
    }> => ipcRenderer.invoke('settings:get-common-resource-dir-info'),
    pick: (): Promise<{ canceled: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('settings:pick-common-resource-dir'),
    setPath: (
      targetDir: string
    ): Promise<{
      success: boolean
      path?: string
      previousPath?: string
      data?: any
      error?: string
    }> => ipcRenderer.invoke('settings:set-common-resource-dir', targetDir),
    reset: (): Promise<{
      success: boolean
      path?: string
      data?: any
      error?: string
    }> => ipcRenderer.invoke('settings:reset-common-resource-dir')
  }

  // 单元查询
}
