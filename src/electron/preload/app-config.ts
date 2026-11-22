// 由 preload.ts 按领域分片（工单 01 preload IPC 桥拆分）。正文为原 electronAPI 区间逐字节等价搬运、零行为改动、零顶层 key 增删。

import type { AppConfig, FileInfo, FileItem, AIClassificationResult } from '@firefly/types'
import type { ConfigKey } from '@firefly/types/config-types'
import type { LogCategory } from '../../../pro/packages/shared/src/logger/log-category'
import { ipcRenderer } from 'electron'
import { logger, isPackaged, appRegion, hasPeerData, peerRegion } from './shared-context'

export const appConfigApi = {
  // 应用是否已打包
  isPackaged,

  // 获取当前区域 ('cn' | 'intl')
  getAppRegion: (): 'cn' | 'intl' => appRegion, // 跨区域历史数据检测状态 (P1 / ISS-04)
  getCrossRegionStatus: (): {
    hasPeerData: boolean
    peerRegion: 'cn' | 'intl'
    currentRegion: 'cn' | 'intl'
  } => ({
    hasPeerData,
    peerRegion,
    currentRegion: appRegion
  }),

  // 系统日志
  onLogForwarded: (
    callback: (payload: {
      category: LogCategory
      level: string
      message: string
      data?: any
      origin: 'backend' | 'frontend'
      origin_ts?: number
      trace_id?: string
    }) => void
  ) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('system:log-forward', handler)
    return () => ipcRenderer.removeListener('system:log-forward', handler)
  },

  onLogBatchForwarded: (
    callback: (
      payloads: Array<{
        category: LogCategory
        level: string
        message: string
        data?: any
        origin: 'backend' | 'frontend'
        origin_ts?: number
        trace_id?: string
      }>
    ) => void
  ) => {
    const handler = (_event: any, payloads: any[]) => callback(payloads)
    ipcRenderer.on('system:log-forward-batch', handler)
    return () => ipcRenderer.removeListener('system:log-forward-batch', handler)
  },

  // PostHog 诊断与会话绑定
  getRunId: (): Promise<string> => ipcRenderer.invoke('system:get-run-id'),
  bindPostHogSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('system:bind-posthog-session', sessionId),

  // 系统诊断日志
  writeDiagnosticLog: (
    filename: string,
    content: string
  ): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('system:write-diagnostic-log', filename, content),

  // 文件操作
  getAllFiles: (): Promise<FileInfo[]> => ipcRenderer.invoke('get-all-files'),

  addFile: (file: FileInfo): Promise<void> => ipcRenderer.invoke('add-file', file),

  // 获取系统/文件关联图标（返回 DataURL，无缩略图时用于展示文件图标）
  getFileIcon: (filePath: string, size?: 'small' | 'normal' | 'large'): Promise<string | null> =>
    ipcRenderer.invoke('get-file-icon', filePath, size),

  searchWorkspaceFiles: (
    keyword: string,
    workspacePath: string,
    options?: {
      stream?: boolean
      seq?: number
      channel?: string
      epoch?: number
      similarityThreshold?: number
    }
  ): Promise<FileItem[]> =>
    ipcRenderer.invoke('search-workspace-files', keyword, workspacePath, options),

  onSearchProgress: (
    callback: (payload: {
      phase: 'phase1' | 'phase2' | 'phase3' | 'failed'
      channel?: string
      seq: number
      items: FileItem[]
      total: number
      tokens?: string[]
      /** 工单 13：冷态视觉模型首次加载中（仅 phase2 携带），phase3 到达或超时后应隐藏提示 */
      clipPending?: boolean
      requestEpoch?: number
      errorCode?: string
      errorMessage?: string
    }) => void
  ) => {
    const handler = (
      _event: any,
      payload: {
        phase: 'phase1' | 'phase2' | 'phase3' | 'failed'
        channel?: string
        seq: number
        items: FileItem[]
        total: number
        tokens?: string[]
        clipPending?: boolean
        requestEpoch?: number
        errorCode?: string
        errorMessage?: string
      }
    ) => callback(payload)
    ipcRenderer.on('search-workspace-files-progress', handler)
    return () => ipcRenderer.removeListener('search-workspace-files-progress', handler)
  },

  tokenizeText: (text: string): Promise<string[]> => ipcRenderer.invoke('tokenize-text', text),

  // AI分类
  classifyFile: (
    filename: string,
    contentPreview?: string,
    metadata?: any
  ): Promise<AIClassificationResult> =>
    ipcRenderer.invoke('classify-file', filename, contentPreview, metadata),

  // AI分类（通过LLM）
  classifyFileWithLLM: (
    modelId: string,
    prompt: string,
    filename: string
  ): Promise<AIClassificationResult> =>
    ipcRenderer.invoke('classify-file-with-llm', modelId, prompt, filename),

  // 配置管理
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('get-config'),

  updateConfig: (updates: Partial<AppConfig>): Promise<void> =>
    ipcRenderer.invoke('update-config', updates),

  updateConfigValue: (
    key: ConfigKey,
    value: unknown,
    options?: { preventAutoReload?: boolean }
  ): Promise<void> => ipcRenderer.invoke('config/update-value', key, value, options),

  getConfigValue: <T = unknown>(key: ConfigKey): Promise<T> =>
    ipcRenderer.invoke('config/get-value', key),

  onConfigChange: (callback: (config: AppConfig) => void) => {
    const handler = (_event: any, payload: AppConfig) => callback(payload)
    ipcRenderer.on('config:change', handler)
    return () => ipcRenderer.removeListener('config:change', handler)
  },

  onConfigDbChange: (callback: (config: Record<string, any>) => void) => {
    const handler = (_event: any, payload: Record<string, any>) => callback(payload)
    ipcRenderer.on('configDb:change', handler)
    return () => ipcRenderer.removeListener('configDb:change', handler)
  },

  onPreviewForceClose: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('preview:force-close', handler)
    return () => ipcRenderer.removeListener('preview:force-close', handler)
  },

  onOpenSettings: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('app:open-settings', handler)
    return () => ipcRenderer.removeListener('app:open-settings', handler)
  },

  onNavigateRoute: (callback: (route: string) => void) => {
    const handler = (_event: any, route: string) => callback(route)
    ipcRenderer.on('app:navigate-route', handler)
    return () => ipcRenderer.removeListener('app:navigate-route', handler)
  },

  // 深度链接（URL Schemes，如 firefly://rules?tab=consumption）
  onDeepLink: (
    callback: (payload: {
      url: string
      action: string
      tab?: string
      params?: Record<string, string>
    }) => void
  ) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('app:deep-link', handler)
    return () => ipcRenderer.removeListener('app:deep-link', handler)
  },

  getPendingDeepLink: (): Promise<{
    url: string
    action: string
    tab?: string
    params?: Record<string, string>
  } | null> => ipcRenderer.invoke('app:get-pending-deep-link'),

  getStartupFlags: (): Promise<{ forceConfigStage: boolean }> =>
    ipcRenderer.invoke('startup/get-flags'),

  initializeAppPhase: (): Promise<void> => ipcRenderer.invoke('startup/initialize-phase'),

  // AI状态
  getAIStatus: (): Promise<string> => ipcRenderer.invoke('get-ai-status'),
  relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch')
}
