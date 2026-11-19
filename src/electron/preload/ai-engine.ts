// 由 preload.ts 按领域分片（工单 01 preload IPC 桥拆分）。正文为原 electronAPI 区间逐字节等价搬运、零行为改动、零顶层 key 增删。

import type { AIClassificationResult } from '@firefly/types'
import type { EngineBridgeSnapshot } from '../runtime-services/engine-bridge'
import { ipcRenderer } from 'electron'
import { logger } from './shared-context'

export const aiEngineApi = {
  // AI服务管理
  aiService: {
    initialize: (options?: {
      onlyDeploy?: boolean
      forceDeploy?: boolean
    }): Promise<{ success: boolean; message: string; initInfo?: any }> =>
      ipcRenderer.invoke('ai-service/initialize', options),
    isInitialized: (): Promise<boolean> => ipcRenderer.invoke('ai-service/is-initialized'),
    getInitializationInfo: (): Promise<{
      isInitialized: boolean
      isInitializing: boolean
      attempts: number
      lastError?: string
      initTime?: number
    }> => ipcRenderer.invoke('ai-service/get-initialization-info'),
    getStatus: (): Promise<string> => ipcRenderer.invoke('ai-service/get-status'),
    getCapabilities: (): Promise<any> => ipcRenderer.invoke('ai-service/get-capabilities'),
    getCurrentPhase: (): Promise<string> => ipcRenderer.invoke('ai-service/get-current-phase'),
    onModelChanged: (modelId: string): Promise<{ success: boolean; message: string }> =>
      ipcRenderer.invoke('ai-service/on-model-changed', modelId),
    setConfigReloadSuspended: (suspended: boolean): Promise<void> =>
      ipcRenderer.invoke('ai-service/set-config-reload-suspended', suspended),
    checkPackageIntegrity: (): Promise<string[]> =>
      ipcRenderer.invoke('ai-service/check-package-integrity')
    // 驱动合规/高性能切换/加速后端 IPC 已随本地引擎部署链清退（主进程 handler 已删）：
    // checkDriverCompliance / getDriverUpdateUrl / switchToCompatibleMode /
    // switchToHighPerformanceMode / switchAccelerationBackend — 归 Tier 2 引擎端管理。
  },

  // 引擎桥接 (Tier 2 上层 AI 引擎监控与指令)
  engineBridge: {
    getStatus: (): Promise<EngineBridgeSnapshot> => ipcRenderer.invoke('engine-bridge/get-status'),
    getExeInfo: (): Promise<{ available: boolean; path: string | null; devMode: boolean }> =>
      ipcRenderer.invoke('engine-bridge/get-exe-info'),
    start: (): Promise<boolean> => ipcRenderer.invoke('engine-bridge/start'),
    openUI: (options?: {
      panel?: 'error' | 'logs' | 'models' | 'default'
      /** 目标模型关键词：引擎前端据此滚动聚焦并呼吸高亮（Issue 0046 §3） */
      focusModel?: string
      /** 推荐模型源（modelscope / huggingface）：引擎前端据此预选可顺畅下载的源 */
      source?: string
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('engine-bridge/open-ui', options),
    /** 探测引擎侧是否已安装指定模型（关键词宽松匹配，Issue 0046 §3） */
    checkModelsInstalled: (
      keywords: string[]
    ): Promise<{ reachable: boolean; installed: boolean; matched: string[] }> =>
      ipcRenderer.invoke('engine-bridge/check-models', keywords),
    shutdown: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('engine-bridge/shutdown'),
    startService: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('engine-bridge/start-service'),
    stopService: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('engine-bridge/stop-service'),
    /** 切换引擎计算后端（PRD-0049：引擎激活单一化） */
    switchBackend: (backend: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('engine-bridge/switch-backend', backend),
    onStatusChanged: (callback: (payload: EngineBridgeSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: EngineBridgeSnapshot) =>
        callback(payload)
      ipcRenderer.on('tier2:status-changed', handler)
      return () => ipcRenderer.removeListener('tier2:status-changed', handler)
    }
  },

  // 统一大模型网关服务 (TASK-03 / TASK-04)
  llmGateway: {
    getSnapshot: () => ipcRenderer.invoke('llm-gateway/get-snapshot'),
    setDesiredMode: (mode: string) => ipcRenderer.invoke('llm-gateway/set-desired-mode', mode),
    preheat: (options?: { wait?: boolean }) => ipcRenderer.invoke('llm-gateway/preheat', options),
    drain: (waitDrainMs?: number) => ipcRenderer.invoke('llm-gateway/drain', waitDrainMs)
  },

  // 邀请服务
  invitation: {
    match: (features: any) => ipcRenderer.invoke('invitation/match', features),
    getCount: () => ipcRenderer.invoke('invitation/get-count'),
    redeem: (inviterRef: string) => ipcRenderer.invoke('invitation/redeem', inviterRef),
    redeemInvitationCode: (inviterRef: string) =>
      ipcRenderer.invoke('invitation/redeem', inviterRef)
  },

  // 分析队列
  getAnalysisQueue: (workspaceId?: number) => ipcRenderer.invoke('analysis-queue/get', workspaceId),
  addToAnalysisQueue: (
    items: { path: string; name: string; size: number; type: string }[],
    forceReanalyze?: boolean
  ) => ipcRenderer.invoke('analysis-queue/add', items, forceReanalyze),
  addToAnalysisQueueResolved: (
    items: { path: string; name: string; size: number; type: string }[],
    forceReanalyze?: boolean
  ) => ipcRenderer.invoke('analysis-queue/add-resolve', items, forceReanalyze),
  retryFailedAnalysis: () => ipcRenderer.invoke('analysis-queue/retry-failed'),
  clearPendingAnalysis: () => ipcRenderer.invoke('analysis-queue/clear-pending'),
  clearAllAnalysis: () => ipcRenderer.invoke('analysis-queue/clear-all'),
  deleteAnalysisItem: (id: number | string) =>
    ipcRenderer.invoke(
      'analysis-queue/delete-item',
      typeof id === 'string' ? parseInt(id, 10) : id
    ),
  cancelAnalysisItem: (id: number | string) =>
    ipcRenderer.invoke(
      'analysis-queue/cancel-item',
      typeof id === 'string' ? parseInt(id, 10) : id
    ),
  startAnalysis: (workspaceId?: number) => ipcRenderer.invoke('analysis-queue/start', workspaceId),
  pauseAnalysis: (workspaceId?: number) => ipcRenderer.invoke('analysis-queue/pause', workspaceId),
  yieldAnalysisForUi: (timeoutMs = 2000) => ipcRenderer.send('analysis:yield-for-ui', timeoutMs),
  resumeAnalysisFromUi: () => ipcRenderer.send('analysis:resume-from-ui'),
  checkExtensionMismatch: (
    workspaceId: number
  ): Promise<
    Array<{
      fileFingerprint: string
      path: string
      name: string
      smartName: string
      extension: string
      extensions: string[]
      workspaceRootPath: string
    }>
  > => ipcRenderer.invoke('analysis-queue/check-extension-mismatch', workspaceId),
  batchFixExtensions: (
    fixes: Array<{ fileFingerprint: string; chosenExtension: string | null }>
  ): Promise<{ success: boolean; count: number }> =>
    ipcRenderer.invoke('analysis-queue/batch-fix-extensions', fixes),
  checkStage4Files: (filePaths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('analysis-queue/check-stage4-files', filePaths),
  checkAlreadyAnalyzedFiles: (filePaths: string[]): Promise<any[]> =>
    ipcRenderer.invoke('analysis-queue/check-already-analyzed-files', filePaths),
  /**
   * 工单 13：canonical 语义索引重建计数（工单 06 只暴露服务方法，设置页在此接入）。
   * 返回 pending/ready/visualOnly/skipped/failed/uncomputed 与最近一次维护摘要。
   */
  getCanonicalRebuildCounts: (): Promise<{
    pending: number
    ready: number
    visualOnly: number
    skipped: number
    failed: number
    uncomputed: number
    lastMaintenance: { reason: string; at: number; invalidated: number; requeued: number } | null
  }> => ipcRenderer.invoke('analysis-queue/canonical-rebuild-counts'),
  /** 工单 13：手动触发一次 canonical 语义索引重建 */
  runCanonicalMaintenance: (reason?: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('analysis-queue/run-canonical-maintenance', reason),
  onAnalysisQueueLatchBrake: (callback: (payload: { workspaceId: number }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('analysis-queue/latch-brake', handler)
    return () => ipcRenderer.removeListener('analysis-queue/latch-brake', handler)
  },
  onAnalysisQueueUpdated: (callback: (payload: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('analysis-queue-updated', handler)
    return () => ipcRenderer.removeListener('analysis-queue-updated', handler)
  },
  onFileAnalysisUpdated: (
    callback: (payload: {
      filePath?: string
      fileFingerprint?: string
      status?: string
      source?: string
    }) => void
  ) => {
    const handler = (_event: any, payload: any) => {
      try {
        window.dispatchEvent(new CustomEvent('smartname-updated', { detail: payload }))
        window.dispatchEvent(new CustomEvent('files-updated', { detail: payload }))
      } catch {}
      callback(payload)
    }
    ipcRenderer.on('file-analysis-updated', handler)
    return () => ipcRenderer.removeListener('file-analysis-updated', handler)
  },
  onDirectoryContextUpdated: (
    callback: (payload: { directoryPath: string; contextAnalysis: any }) => void
  ) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('directory-context-updated', handler)
    return () => ipcRenderer.removeListener('directory-context-updated', handler)
  },
  onModelStatusChanged: (
    callback: (payload: {
      modelName: string | null
      status: string
      loading: boolean
      modelMode?: 'local' | 'cloud' | 'cpu' | null
      provider?: string | null
      backend?: string
    }) => void
  ) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('ai-model-status-changed', handler)
    return () => ipcRenderer.removeListener('ai-model-status-changed', handler)
  },

  // AI服务错误监听
  onAIServiceError: (callback: (error: any) => void) => {
    const handler = (_event: any, error: any) => callback(error)
    ipcRenderer.on('ai-service:error', handler)
    return () => ipcRenderer.removeListener('ai-service:error', handler)
  },

  // PRD-0044（S5）：onModelNotDownloaded 随「内置模型下载链」清退删除
  // （主进程侧 model-not-downloaded 事件已无发送方，模型存在性归萤核AI引擎自管）

  on: (channel: string, callback: (...args: any[]) => void) => {
    const handler = (_event: any, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  // PRD-0044（S5）：模型管理 IPC（listModels / listModelsFast / getAllModels /
  // getBuiltinModelId / checkModelsStatus）随模型列表清退删除，模型身份归萤核AI引擎独占
  getHardwareInfo: (): Promise<any> => ipcRenderer.invoke('get-hardware-info'),
  detectSystemResources: (): Promise<any> => ipcRenderer.invoke('detect-system-resources'),
  getRecommendedEmbeddingSettings: (): Promise<any> =>
    ipcRenderer.invoke('get-recommended-embedding-settings'),
  getMachineId: (): Promise<string> => ipcRenderer.invoke('get-machine-id'),
  // PRD-0044（S5）：recommendModelsByHardware / getModelPath / deleteModel /
  // migrateBuiltinModels / migrateFromOldPath 随模型管理与本地下载链清退删除
  getLlamaServerPort: (): Promise<number | null> => ipcRenderer.invoke('llama-server-port')

  // PRD-0044（S5）：onModelMigrationProgress 随「内置模型迁移链」清退删除
  // （llama/model-migration-progress 已无发送方）

  // PRD-0044（S5）：模型下载事件（onModelDownloadProgress / Complete / Error）
  // 随桌面端下载链清退删除，下载进度由萤核AI引擎自管
}
