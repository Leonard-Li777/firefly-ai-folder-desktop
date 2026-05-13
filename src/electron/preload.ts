// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import type { AIClassificationResult, CloudModelConfig, ProviderModel } from '@yonuc/types'
import { AppConfig, DownloadProgressEvent, FileInfo, WorkspaceDirectory } from '@yonuc/types'
import type { DirectoryItem, FileItem } from '@yonuc/types'
import { LogCategory, logger } from '@yonuc/shared'
import { contextBridge, ipcRenderer } from 'electron'

import type { ConfigKey } from '@yonuc/types/config-types'
import { IModelRecommendation } from '@yonuc/types/model-manager'

// 导入统一的类型定义


// 导入统一的文件和目录类型


/**
 * 暴露给渲染进程的安全API
 */
const electronAPI = {
  // 系统日志
  onLogForwarded: (callback: (payload: { category: LogCategory, level: string, message: string, data?: any, origin: 'backend' | 'frontend' }) => void) => {
    const handler = (_: unknown, payload: any) => callback(payload)
    ipcRenderer.on('system:log-forward', handler)
    return () => ipcRenderer.removeListener('system:log-forward', handler)
  },

  // 文件操作
  getAllFiles: (): Promise<FileInfo[]> => ipcRenderer.invoke('get-all-files'),

  addFile: (file: FileInfo): Promise<void> => ipcRenderer.invoke('add-file', file),

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

  updateConfigValue: (key: ConfigKey, value: unknown, options?: { preventAutoReload?: boolean }): Promise<void> =>
    ipcRenderer.invoke('config/update-value', key, value, options),

  onConfigChange: (callback: (config: AppConfig) => void) => {
    const handler = (_: unknown, payload: AppConfig) => callback(payload)
    ipcRenderer.on('config:change', handler)
    return () => ipcRenderer.removeListener('config:change', handler)
  },

  onRemoteConfigUpdated: (callback: (categories: string[]) => void) => {
    const handler = (_: unknown, payload: string[]) => callback(payload)
    ipcRenderer.on('remote-config:updated', handler)
    return () => ipcRenderer.removeListener('remote-config:updated', handler)
  },

  getStartupFlags: (): Promise<{ forceConfigStage: boolean }> =>
    ipcRenderer.invoke('startup/get-flags'),

  initializeAppPhase: (): Promise<void> =>
    ipcRenderer.invoke('startup/initialize-phase'),

  // AI状态
  getAIStatus: (): Promise<string> => ipcRenderer.invoke('get-ai-status'),

  // AI服务管理（优化后的版本）
  aiService: {
    initialize: (options?: { onlyDeploy?: boolean }): Promise<{ success: boolean; message: string; initInfo?: any }> =>
      ipcRenderer.invoke('ai-service/initialize', options),
    isInitialized: (): Promise<boolean> =>
      ipcRenderer.invoke('ai-service/is-initialized'),
    getInitializationInfo: (): Promise<{
      isInitialized: boolean;
      isInitializing: boolean;
      attempts: number;
      lastError?: string;
      initTime?: number;
    }> =>
      ipcRenderer.invoke('ai-service/get-initialization-info'),
    getStatus: (): Promise<string> =>
      ipcRenderer.invoke('ai-service/get-status'),
    getCapabilities: (): Promise<any> =>
      ipcRenderer.invoke('ai-service/get-capabilities'),
    getCurrentPhase: (): Promise<string> =>
      ipcRenderer.invoke('ai-service/get-current-phase'),
    onModelChanged: (modelId: string): Promise<{ success: boolean; message: string }> =>
      ipcRenderer.invoke('ai-service/on-model-changed', modelId),
    setConfigReloadSuspended: (suspended: boolean): Promise<void> =>
      ipcRenderer.invoke('ai-service/set-config-reload-suspended', suspended),
  },

  // 邀请服务
  invitation: {
    match: (features: any) => ipcRenderer.invoke('invitation/match', features),
    getCount: () => ipcRenderer.invoke('invitation/get-count'),
    redeem: (inviterRef: string) => ipcRenderer.invoke('invitation/redeem', inviterRef),
  },

  // 分析队列
  getAnalysisQueue: () => ipcRenderer.invoke('analysis-queue/get'),
  addToAnalysisQueue: (items: { path: string; name: string; size: number; type: string }[], forceReanalyze?: boolean) => ipcRenderer.invoke('analysis-queue/add', items, forceReanalyze),
  addToAnalysisQueueResolved: (items: { path: string; name: string; size: number; type: string }[], forceReanalyze?: boolean) => ipcRenderer.invoke('analysis-queue/add-resolve', items, forceReanalyze),
  retryFailedAnalysis: () => ipcRenderer.invoke('analysis-queue/retry-failed'),
  clearPendingAnalysis: () => ipcRenderer.invoke('analysis-queue/clear-pending'),
  clearAllAnalysis: () => ipcRenderer.invoke('analysis-queue/clear-all'),
  deleteAnalysisItem: (id: number) => ipcRenderer.invoke('analysis-queue/delete-item', id),
  startAnalysis: () => ipcRenderer.invoke('analysis-queue/start'),
  pauseAnalysis: () => ipcRenderer.invoke('analysis-queue/pause'),
  onAnalysisQueueUpdated: (callback: (payload: any) => void) => {
    const handler = (_: any, payload: any) => callback(payload)
    ipcRenderer.on('analysis-queue-updated', handler)
    return () => ipcRenderer.removeListener('analysis-queue-updated', handler)
  },
  onModelStatusChanged: (callback: (payload: { modelName: string | null; status: string; loading: boolean; modelMode?: 'local' | 'cloud' | null; provider?: string | null }) => void) => {
    const handler = (_: any, payload: any) => callback(payload);
    ipcRenderer.on('ai-model-status-changed', handler);
    return () => ipcRenderer.removeListener('ai-model-status-changed', handler);
  },

  // AI服务错误监听
  onAIServiceError: (callback: (error: any) => void) => {
    const handler = (_: any, error: any) => callback(error);
    ipcRenderer.on('ai-service:error', handler);
    return () => ipcRenderer.removeListener('ai-service:error', handler);
  },

  onModelNotDownloaded: (callback: (payload: { modelId?: string }) => void) => {
    const handler = (_: any, payload: any) => {
      callback(payload);
    };
    ipcRenderer.on('model-not-downloaded', handler);
    return () => {
      ipcRenderer.removeListener('model-not-downloaded', handler);
    };
  },

  // 模型管理
  listModels: (): Promise<any[]> => ipcRenderer.invoke('list-models'),
  getBuiltinModelId: (): Promise<string> => ipcRenderer.invoke('get-builtin-model-id'),
  checkModelsStatus: (): Promise<Record<string, { isDownloaded: boolean, downloadProgress?: number }>> => 
    ipcRenderer.invoke('check-models-status'),
  getHardwareInfo: (): Promise<any> => ipcRenderer.invoke('get-hardware-info'),
  getMachineId: (): Promise<string> => ipcRenderer.invoke('get-machine-id'),
  recommendModelsByHardware: (memoryGB: number, hasGPU: boolean, vramGB?: number): Promise<IModelRecommendation> => ipcRenderer.invoke('recommend-models-by-hardware', memoryGB, hasGPU, vramGB),
  getModelPath: (modelId: string): Promise<string | null> => ipcRenderer.invoke('get-model-path', modelId),
  deleteModel: (modelId: string): Promise<void> => ipcRenderer.invoke('delete-model', modelId),

  migrateBuiltinModels: (targetDir: string): Promise<{ success: boolean, error?: string }> =>
    ipcRenderer.invoke('llama/migrate-builtin-models', targetDir),

  migrateFromOldPath: (oldPath: string, newPath: string): Promise<{ success: boolean, error?: string }> =>
    ipcRenderer.invoke('llama/migrate-from-old-path', oldPath, newPath),

  onModelMigrationProgress: (callback: (message: string) => void) => {
    const handler = (_: any, message: string) => callback(message)
    ipcRenderer.on('llama/model-migration-progress', handler)
    return () => ipcRenderer.removeListener('llama/model-migration-progress', handler)
  },

  // 模型下载事件
  onModelDownloadProgress: (callback: (payload: DownloadProgressEvent) => void) => {
    const handler = (_: any, payload: any) => callback(payload)
    ipcRenderer.on('model-download-progress', handler)
    return () => ipcRenderer.removeListener('model-download-progress', handler)
  },
  onModelDownloadComplete: (callback: (payload: DownloadProgressEvent) => void) => {
    const handler = (_: any, payload: any) => callback(payload)
    ipcRenderer.on('model-download-complete', handler)
    return () => ipcRenderer.removeListener('model-download-complete', handler)
  },
  onModelDownloadError: (callback: (payload: DownloadProgressEvent) => void) => {
    const handler = (_: any, payload: any) => callback(payload)
    ipcRenderer.on('model-download-error', handler)
    return () => ipcRenderer.removeListener('model-download-error', handler)
  },

  onSSLCertificateError: (callback: (event: any) => void) => {
    const handler = (_: any, payload: any) => callback(payload)
    ipcRenderer.on('ssl-certificate-error', handler)
    return () => ipcRenderer.removeListener('ssl-certificate-error', handler)
  },

  // 工作目录更新事件
  onWorkspaceDirectoriesUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('workspace-directories-updated', handler)
    return () => ipcRenderer.removeListener('workspace-directories-updated', handler)
  },

  // 忽略规则变更事件
  onIgnoreRulesChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('ignore-rules-changed', handler)
    return () => ipcRenderer.removeListener('ignore-rules-changed', handler)
  },

  // 目录文件更新事件（增量更新）
  onDirectoryFilesUpdated: (callback: (dirPath: string) => void) => {
    const handler = (_: any, dirPath: string) => callback(dirPath)
    ipcRenderer.on('directory-files-updated', handler)
    return () => ipcRenderer.removeListener('directory-files-updated', handler)
  },

  onSystemNotification: (callback: (data: any) => void) => {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('system:notification', handler)
    return () => ipcRenderer.removeListener('system:notification', handler)
  },

  // 授权相关
  license: {
    getStatus: (): Promise<{ status: string; expiry?: string; error?: string }> =>
      ipcRenderer.invoke('license/get-status'),
    checkOnline: (): Promise<{ status: string; expiry?: string; error?: string }> =>
      ipcRenderer.invoke('license/check-online'),
    getRequestCode: (): Promise<string> =>
      ipcRenderer.invoke('license/get-request-code'),
    activate: (licenseCode: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('license/activate', licenseCode),
    onUnauthorized: (callback: (result: any) => void) => {
      const subscription = (event, result) => callback(result);
      ipcRenderer.on('license:unauthorized', subscription);
      return () => ipcRenderer.removeListener('license:unauthorized', subscription);
    }
  },

  // 工具函数
  utils: {
    getPlatform: (): string => process.platform,

    normalizeForCache: (p: string) => process.platform === 'win32' ? (p ? p.toLowerCase() : '') : p,
    isPathEqual: (p1?: string | null, p2?: string | null) => {
      if (!p1 || !p2) return p1 === p2;
      return process.platform === 'win32' ? p1.toLowerCase() === p2.toLowerCase() : p1 === p2;
    },
    stripTrailingSlash: (p: string) => p ? p.replace(/[\/\\]$/, '') : '',
    pathSeparator: process.platform === 'win32' ? '\\' : '/',
    normalizePath: (p: string) => {
      if (!p) return '';
      const sep = process.platform === 'win32' ? '\\' : '/';
      return p.replace(/[\\\/]/g, sep);
    },
    isSubPath: (parent: string, child: string) => {
      const platform = process.platform;
      let p = parent ? parent.replace(/[\/\\]$/, '') : '';
      let c = child ? child.replace(/[\/\\]$/, '') : '';
      if (platform === 'win32') {
        p = p.toLowerCase();
        c = c.toLowerCase();
      }
      return c.startsWith(p + '/') || c.startsWith(p + '\\') || p === c;
    },

    showOpenDialog: (options: any) => ipcRenderer.invoke('show-open-dialog', options),

    showSaveDialog: (options: any) => ipcRenderer.invoke('show-save-dialog', options),

    showMessageBox: (options: any) => ipcRenderer.invoke('show-message-box', options),

    getUserHomePath: () => ipcRenderer.invoke('get-user-home-path'),

    // 添加路径连接函数
    joinPath: (basePath: string, relativePath: string) => ipcRenderer.invoke('join-path', basePath, relativePath),

    // 用系统默认程序打开文件
    openFileWithDefaultApp: (filePath: string) => ipcRenderer.invoke('open-file-with-default-app', filePath),

    // 用系统文件浏览器打开目录
    openPathInExplorer: (dirPath: string) => ipcRenderer.invoke('open-path-in-explorer', dirPath),

    // 写入文件
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('write-file', filePath, content),

    // LibreOffice检测
    detectLibreOffice: () => ipcRenderer.invoke('detect-libreoffice'),

    // FFmpeg检测
    detectFfmpeg: () => ipcRenderer.invoke('detect-ffmpeg'),

    // 打开外部链接
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

    // 读取文件并转换为 base64
    readFileBase64: (filePath: string): Promise<string> => ipcRenderer.invoke('read-file-base64', filePath),
  },

  // Window controls
  window: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    close: () => ipcRenderer.invoke('window-close'),
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

  deleteWorkspaceDirectory: (path: string): Promise<void> =>
    ipcRenderer.invoke('delete-workspace-directory', path),

  resetWorkspaceDirectory: (directoryPath: string): Promise<void> =>
    ipcRenderer.invoke('reset-workspace-directory', directoryPath),

  rescanWorkspaceDirectory: (workspaceId: number): Promise<any> =>
    ipcRenderer.invoke('rescanWorkspaceDirectory', workspaceId),

  database: {
    resetAnalysisDatabase: (): Promise<void> =>
      ipcRenderer.invoke('resetAnalysisDatabase'),
    getAnalysisIgnoreRules: (): Promise<any[]> =>
      ipcRenderer.invoke('getAnalysisIgnoreRules'),
    saveAnalysisIgnoreRules: (rules: any[]): Promise<void> =>
      ipcRenderer.invoke('saveAnalysisIgnoreRules', rules),
  },

  updateWorkspaceDirectoryAutoWatch: (workspaceId: number, autoWatch: boolean): Promise<void> =>
    ipcRenderer.invoke('update-workspace-directory-auto-watch', workspaceId, autoWatch),

  // 单元查询
  getUnitsForFile: (fileId: string) => ipcRenderer.invoke('units/get-by-file', fileId),
  getUnitsForPath: (filePath: string) => ipcRenderer.invoke('units/get-by-path', filePath),

  // AI分析结果查询
  getFileAnalysisResult: (filePath: string) => ipcRenderer.invoke('get-file-analysis-result', filePath),
  resetFileAnalysis: (fileId: string) => ipcRenderer.invoke('reset-file-analysis', fileId),
  getDirectoryAnalysisResult: (dirPath: string) => ipcRenderer.invoke('get-directory-analysis-result', dirPath),

  // 目录上下文分析
  analyzeDirectoryContext: (dirPath: string, force?: boolean): Promise<any> =>
    ipcRenderer.invoke('analyze-directory-context', dirPath, force),
  clearDirectoryContext: (dirPath: string): Promise<any> =>
    ipcRenderer.invoke('clear-directory-context', dirPath),

  // 文件系统操作
  readDirectory: (path: string): Promise<{ files: FileItem[]; directories: DirectoryItem[] }> =>
    ipcRenderer.invoke('read-directory', path),

  // 虚拟目录相关
  virtualDirectory: {
    getDimensionGroups: (workspaceDirectoryPath?: string, language?: string) => ipcRenderer.invoke('virtual-directory/get-dimension-groups', workspaceDirectoryPath, language),
    getFilteredFiles: (params: {
      selectedTags: any[]
      sortBy: string
      sortOrder: string
      workspaceDirectoryPath?: string
      searchKeyword?: string
    }) => ipcRenderer.invoke('virtual-directory/get-filtered-files', params),
    getFilteredFilesPaged: (params: {
      selectedTags: any[]
      sortBy: string
      sortOrder: string
      workspaceDirectoryPath?: string
      searchKeyword?: string
      limit: number
      offset: number
    }) => ipcRenderer.invoke('virtual-directory/get-filtered-files-paged', params),
    saveDirectory: (directory: any, workspaceDirectoryPath?: string): Promise<string | undefined> => ipcRenderer.invoke('virtual-directory/save-directory', directory, workspaceDirectoryPath),
    batchSaveDirectories: (directories: Array<{
      name: string
      filter: any
      path: string[]
    }>, workspaceDirectoryPath: string): Promise<Array<{ name: string, path: string }>> =>
      ipcRenderer.invoke('virtual-directory/batch-save-directories', directories, workspaceDirectoryPath),
    // 新增：直接根据预览树结构导出虚拟目录
    generateFromPreviewTree: (params: {
      workspaceDirectoryPath: string
      directoryTree: any[]
      tagFileMap: any
      options: {
        flattenToRoot: boolean
        skipEmptyDirectories: boolean
        enableNestedClassification: boolean
      }
    }) => ipcRenderer.invoke('virtual-directory/generate-from-preview-tree', params),
    getSavedDirectories: (workspaceDirectoryPath?: string) => ipcRenderer.invoke('virtual-directory/get-saved-directories', workspaceDirectoryPath),
    deleteDirectory: (id: string, workspaceDirectoryPath?: string) => ipcRenderer.invoke('virtual-directory/delete-directory', id, workspaceDirectoryPath),
    renameDirectory: (id: string, newName: string) => ipcRenderer.invoke('virtual-directory/rename-directory', id, newName),
    isFirst: (workspaceDirectoryPath?: string): Promise<boolean> => ipcRenderer.invoke('virtual-directory/is-first', workspaceDirectoryPath),
    cleanup: (workspaceDirectoryPath: string) => ipcRenderer.invoke('virtual-directory/cleanup', workspaceDirectoryPath),
    getAnalyzedFilesCount: (workspaceDirectoryPath?: string) =>
      ipcRenderer.invoke('virtual-directory/get-analyzed-files-count', workspaceDirectoryPath),
    getPrivateAnalyzedFilesCount: () => ipcRenderer.invoke('virtual-directory/get-private-analyzed-files-count'),
  },

  // 文件清理相关
  fileCleanup: {
    deleteFile: (fileId: number) => ipcRenderer.invoke('file-cleanup/delete-file', fileId),
    batchDeleteFiles: (fileIds: number[]) => ipcRenderer.invoke('file-cleanup/batch-delete-files', fileIds),
  },

  // 整理真实目录相关
  organizeRealDirectory: {
    byVirtualDirectory: (params: {
      workspaceDirectoryPath: string
      savedDirectories: any[]
    }) => ipcRenderer.invoke('organize-real-directory/by-virtual-directory', params),
    getPreview: (params: {
      workspaceDirectoryPath: string
      savedDirectories: any[]
    }) => ipcRenderer.invoke('organize-real-directory/get-preview', params),
    openDirectory: (directoryPath: string) => ipcRenderer.invoke('organize-real-directory/open-directory', directoryPath),
    deleteAllVirtualDirectories: (workspaceDirectoryPath: string) => ipcRenderer.invoke('organize-real-directory/delete-all-virtual-directories', workspaceDirectoryPath),
    getSavedVirtualDirectories: (workspaceDirectoryPath: string) => ipcRenderer.invoke('organize-real-directory/get-saved-virtual-directories', workspaceDirectoryPath),
    getAnalyzedFiles: (workspaceDirectoryPath: string) => ipcRenderer.invoke('organize-real-directory/get-analyzed-files', workspaceDirectoryPath),
    quickOrganize: (params: {
      workspaceDirectoryPath: string
      aiGeneratedStructure: any
    }) => ipcRenderer.invoke('organize-real-directory/quick-organize', params),
    // 一键整理 - 生成整理方案
    generatePlan: (params: {
      workspaceDirectoryPath: string
      options?: {
        batchSize?: number
        temperature?: number
        filePaths?: string[]
        userInstruction?: string
      }
      onProgress?: (progress: any) => void
    }) => ipcRenderer.invoke('organize-real-directory/generate-plan', params),
    cancelPlan: (workspaceDirectoryPath: string) => ipcRenderer.invoke('organize-real-directory/cancel-plan', workspaceDirectoryPath),
    listSessions: (workspaceDirectoryPath: string) => ipcRenderer.invoke('organize-real-directory/list-sessions', workspaceDirectoryPath),
    undoSession: (params: {
      workspaceDirectoryPath: string
      sessionId: string
    }) => ipcRenderer.invoke('organize-real-directory/undo-session', params),
    deleteSession: (params: {
      workspaceDirectoryPath: string
      sessionId: string
    }) => ipcRenderer.invoke('organize-real-directory/delete-session', params),
    onProgressUpdate: (callback: (progress: any) => void) => {
      const handler = (_: any, progress: any) => callback(progress)
      ipcRenderer.on('organize-progress-update', handler)
      return () => ipcRenderer.removeListener('organize-progress-update', handler)
    },

    // 添加进度监听
    onPlanProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on('organize-plan-progress', (_event, progress) => {
        callback(progress)
      })
    },

    // 添加移除监听器的方法
    removePlanProgressListener: () => {
      ipcRenderer.removeAllListeners('organize-plan-progress')
    }
  },

  // 空文件夹清理
  emptyFolder: {
    scan: (workspaceDirectoryPath: string) =>
      ipcRenderer.invoke('empty-folder/scan', workspaceDirectoryPath),
    delete: (folderPaths: string[]) =>
      ipcRenderer.invoke('empty-folder/delete', folderPaths)
  },

  // AI分类通信
  onAIClassificationRequest: (callback: (event: any, request: any) => void) => {
    const handler = (_: any, request: any) => callback(_, request)
    ipcRenderer.on('ai-classification-request', handler)
    return () => ipcRenderer.removeListener('ai-classification-request', handler)
  },

  sendAIClassificationResult: (channel: string, result: any) => {
    ipcRenderer.send(channel, result)
  },

  // 云端模型配置相关
  cloudModelConfig: {
    // 获取所有云端配置
    getConfigs: async (): Promise<CloudModelConfig[]> => {
      const result = await ipcRenderer.invoke('cloud-model-config:get-configs')
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 获取指定索引的配置
    getConfig: async (index: number): Promise<CloudModelConfig | null> => {
      const result = await ipcRenderer.invoke('cloud-model-config:get-config', index)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 添加新配置
    addConfig: async (config: CloudModelConfig): Promise<void> => {
      const result = await ipcRenderer.invoke('cloud-model-config:add-config', config)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 更新配置
    updateConfig: async (index: number, config: CloudModelConfig): Promise<void> => {
      const result = await ipcRenderer.invoke('cloud-model-config:update-config', index, config)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 删除配置
    deleteConfig: async (index: number): Promise<void> => {
      const result = await ipcRenderer.invoke('cloud-model-config:delete-config', index)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 获取当前选中的配置索引
    getSelectedIndex: async (): Promise<number> => {
      const result = await ipcRenderer.invoke('cloud-model-config:get-selected-index')
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 设置当前选中的配置索引
    setSelectedIndex: async (index: number): Promise<void> => {
      const result = await ipcRenderer.invoke('cloud-model-config:set-selected-index', index)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 测试配置有效性
    testConfig: async (config: CloudModelConfig): Promise<boolean> => {
      const result = await ipcRenderer.invoke('cloud-model-config:test-config', config)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 获取指定服务商的模型列表
    getProviderModels: async (
      provider: string,
      apiKey: string,
      baseUrl?: string,
      throwOnError = false
    ): Promise<ProviderModel[]> => {
      const result = await ipcRenderer.invoke(
        'cloud-model-config:get-provider-models',
        provider,
        apiKey,
        baseUrl,
        throwOnError
      )
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 获取云端提供商配置
    getCloudProvidersConfig: async (language: string): Promise<any[]> => {
      const result = await ipcRenderer.invoke('cloud-model-config:get-cloud-providers-config', language)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },
  },

  // 本地模型下载管理相关
  modelDownload: {
    // 检查模型下载状态
    checkDownloadStatus: async (modelId: string): Promise<{
      isDownloaded: boolean
      hasPartialFiles: boolean
      downloadProgress: number
      missingFiles: string[]
      existingFiles: Array<{ name: string; size: number; expectedSize: number }>
    }> => {
      const result = await ipcRenderer.invoke('model-download-manager:check-status', modelId)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 开始下载模型
    startDownload: async (modelId: string, options?: {
      autoRetry?: boolean
      retryAttempts?: number
    }) => {
      const result = await ipcRenderer.invoke('model-download-manager:start-download', modelId, options)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 取消下载
    cancelDownload: async (taskId: string): Promise<void> => {
      const result = await ipcRenderer.invoke('model-download-manager:cancel-download', taskId)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 暂停下载
    pauseDownload: async (taskId: string): Promise<void> => {
      const result = await ipcRenderer.invoke('model-download-manager:pause-download', taskId)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 恢复下载
    resumeDownload: async (taskId: string): Promise<void> => {
      const result = await ipcRenderer.invoke('model-download-manager:resume-download', taskId)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 获取任务状态
    getTaskStatus: async (taskId: string) => {
      const result = await ipcRenderer.invoke('model-download-manager:get-task-status', taskId)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 获取模型的任务状态
    getModelTask: async (modelId: string) => {
      const result = await ipcRenderer.invoke('model-download-manager:get-model-task', modelId)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 检查模型是否正在下载
    isDownloading: async (modelId: string): Promise<boolean> => {
      const result = await ipcRenderer.invoke('model-download-manager:is-downloading', modelId)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 获取所有活跃任务
    getAllTasks: async () => {
      const result = await ipcRenderer.invoke('model-download-manager:get-all-tasks')
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    }
  },

  // Ollama 相关 API
  ollama: {
    // 检查 Ollama 安装状态
    checkInstallation: async (): Promise<{ installed: boolean; version?: string; error?: string }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:check-installation')
        return result
      } catch (error) {
        return { 
          installed: false, 
          error: error instanceof Error ? error.message : String(error) 
        }
      }
    },

    // 安装 Ollama
    install: async (): Promise<{ success: boolean; error?: string }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:install')
        return result
      } catch (error) {
        return { 
          success: false, 
          error: error instanceof Error ? error.message : String(error) 
        }
      }
    },

    // 取消安装 Ollama
    cancelInstall: async (): Promise<{ success: boolean; error?: string }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:cancel-install')
        return result
      } catch (error) {
        return { 
          success: false, 
          error: error instanceof Error ? error.message : String(error) 
        }
      }
    },

    // 获取 Ollama 状态
    getStatus: async (): Promise<{ status: string; version?: string }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:get-status')
        return result
      } catch (error) {
        return { status: 'error' }
      }
    },

    // 检查是否需要 Ollama 设置
    needsSetup: async (): Promise<{ needsSetup: boolean; error?: string }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:needs-setup')
        return result
      } catch (error) {
        return { 
          needsSetup: false, 
          error: error instanceof Error ? error.message : String(error) 
        }
      }
    },

    // 拉取模型
    pullModel: async (modelId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:pull-model', modelId)
        return result
      } catch (error) {
        return { 
          success: false, 
          error: error instanceof Error ? error.message : String(error) 
        }
      }
    },

    // 检查模型是否已安装
    checkModel: async (modelId: string): Promise<{ installed: boolean; error?: string }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:check-model', modelId)
        return result
      } catch (error) {
        return { 
          installed: false, 
          error: error instanceof Error ? error.message : String(error) 
        }
      }
    },

    // 获取已安装的模型列表
    listModels: async (): Promise<{ models: string[]; error?: string }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:list-models')
        return result
      } catch (error) {
        return { 
          models: [], 
          error: error instanceof Error ? error.message : String(error) 
        }
      }
    },

    // 获取推荐的模型列表
    getRecommendedModels: async (): Promise<{ models: any[] }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:get-recommended-models')
        return result
      } catch (error) {
        return { models: [] }
      }
    },

    // 打开 Ollama 官网
    openWebsite: async (): Promise<{ success: boolean }> => {
      try {
        const result = await ipcRenderer.invoke('ollama:open-website')
        return result
      } catch (error) {
        return { success: false }
      }
    },

    // 重启应用以使安装生效
    relaunch: async (): Promise<void> => {
      await ipcRenderer.invoke('ollama:relaunch')
    },

    // 退出应用
    exit: async (): Promise<void> => {
      await ipcRenderer.invoke('ollama:exit')
    },

    // 获取当前下载镜像
    getDownloadMirror: async (): Promise<'cn' | 'global'> => {
      return await ipcRenderer.invoke('ollama:get-download-mirror')
    },

    // 监听镜像同步事件
    onMirrorSync: (callback: (mirror: 'cn' | 'global') => void) => {
      const handler = (_: unknown, mirror: 'cn' | 'global') => callback(mirror)
      ipcRenderer.on('ollama:mirror-sync', handler)
      return () => ipcRenderer.removeListener('ollama:mirror-sync', handler)
    }
  },

  // FFmpeg 相关 API
  ffmpeg: {
    // 检查 FFmpeg 安装状态
    checkInstallation: async (): Promise<{ installed: boolean; path?: string; downloading: boolean }> => {
      return await ipcRenderer.invoke('ffmpeg:check-installation')
    },

    // 安装 FFmpeg
    install: async (): Promise<{ success: boolean; error?: string }> => {
      try {
        return await ipcRenderer.invoke('ffmpeg:install')
      } catch (error) {
        return { 
          success: false, 
          error: error instanceof Error ? error.message : String(error) 
        }
      }
    }
  },

  // Ollama 事件监听器
  onOllamaInstallProgress: (callback: (data: { message: string }) => void) => {
    const handler = (_: unknown, payload: { message: string }) => callback(payload)
    ipcRenderer.on('ollama:install-progress', handler)
    return () => ipcRenderer.removeListener('ollama:install-progress', handler)
  },

  onOllamaInstallComplete: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('ollama:install-complete', handler)
    return () => ipcRenderer.removeListener('ollama:install-complete', handler)
  },

  onOllamaInstallError: (callback: (data: { error: string }) => void) => {
    const handler = (_: unknown, payload: { error: string }) => callback(payload)
    ipcRenderer.on('ollama:install-error', handler)
    return () => ipcRenderer.removeListener('ollama:install-error', handler)
  },

  onOllamaStatusChanged: (callback: (data: { status: string }) => void) => {
    const handler = (_: unknown, payload: { status: string }) => callback(payload)
    ipcRenderer.on('ollama:status-changed', handler)
    return () => ipcRenderer.removeListener('ollama:status-changed', handler)
  },

  onOllamaModelStatusChanged: (callback: (data: { modelId: string; status: string }) => void) => {
    const handler = (_: unknown, payload: { modelId: string; status: string }) => callback(payload)
    ipcRenderer.on('ollama:model-status-changed', handler)
    return () => ipcRenderer.removeListener('ollama:model-status-changed', handler)
  },

  onOllamaModelProgress: (callback: (data: { modelId: string; message: string }) => void) => {
    const handler = (_: unknown, payload: { modelId: string; message: string }) => callback(payload)
    ipcRenderer.on('ollama:model-progress', handler)
    return () => ipcRenderer.removeListener('ollama:model-progress', handler)
  },

  // FFmpeg 事件监听器
  onFfmpegInstallProgress: (callback: (data: { message: string; percent?: number }) => void) => {
    const handler = (_: unknown, payload: { message: string; percent?: number }) => callback(payload)
    ipcRenderer.on('ffmpeg:install-progress', handler)
    return () => ipcRenderer.removeListener('ffmpeg:install-progress', handler)
  },

  onFfmpegInstallComplete: (callback: (data: { path: string }) => void) => {
    const handler = (_: unknown, payload: { path: string }) => callback(payload)
    ipcRenderer.on('ffmpeg:install-complete', handler)
    return () => ipcRenderer.removeListener('ffmpeg:install-complete', handler)
  },

  onFfmpegInstallError: (callback: (data: { error: string }) => void) => {
    const handler = (_: unknown, payload: { error: string }) => callback(payload)
    ipcRenderer.on('ffmpeg:install-error', handler)
    return () => ipcRenderer.removeListener('ffmpeg:install-error', handler)
  },
}

// 类型定义
export type ElectronAPI = typeof electronAPI

// 暴露API到渲染进程
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// 暴露 AI 功能到渲染进程
// 注意：通过 IPC 调用主进程的 llama-server 服务
logger.log(LogCategory.PRELOAD, '设置 AI 功能接口')

contextBridge.exposeInMainWorld('electronLLM', {
  initialized: false, // 初始状态为未初始化

  // 初始化方法，由渲染进程调用
  initialize: async () => {
    try {
      const result = await ipcRenderer.invoke('initialize-ai-service')
      return result
    } catch (error) {
      throw error
    }
  },

  // AI 聊天接口，通过 IPC 调用主进程
  chat: async (options: {
    model: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
    max_tokens?: number
    images?: string[]
    audio?: string[]
  }) => {
    try {
      const result = await ipcRenderer.invoke('ai-chat', options)
      return result
    } catch (error) {
      throw error
    }
  },

  // 获取模型路径
  getModelPath: async (modelAlias: string) => {
    try {
      const modelPath = await ipcRenderer.invoke('get-model-path', modelAlias)
      return modelPath
    } catch (error) {
      throw error
    }
  },

  // 检查 AI 服务状态
  checkStatus: async () => {
    try {
      const status = await ipcRenderer.invoke('get-ai-status')
      return status
    } catch (error) {
      throw error
    }
  }
})

logger.log(LogCategory.PRELOAD, 'AI 功能接口设置完成')

// 手动暴露 electronAi API（通过 llama-server 实现）
contextBridge.exposeInMainWorld('electronAi', {
  // 创建模型实例
  create: async (options: {
    modelAlias: string
    systemPrompt?: string
    initialPrompts?: Array<{ role: string; content: string }>
    topK?: number
    temperature?: number
    requestUUID?: string
  }) => {
    try {
      logger.log(LogCategory.PRELOAD, '创建模型实例', { modelAlias: options.modelAlias })

      // 通过 IPC 调用主进程来创建模型实例
      const result = await ipcRenderer.invoke('electronai-create', options)
      logger.log(LogCategory.PRELOAD, '模型实例创建成功')
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '创建模型实例失败', error)
      throw error
    }
  },

  // 销毁模型实例
  destroy: async () => {
    try {
      logger.log(LogCategory.PRELOAD, '销毁模型实例')
      const result = await ipcRenderer.invoke('electronai-destroy')
      logger.log(LogCategory.PRELOAD, '模型实例销毁成功')
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '销毁模型实例失败', error)
      throw error
    }
  },

  // 发送提示
  prompt: async (input: string, options?: {
    responseJSONSchema?: any
    signal?: AbortSignal
    timeout?: number
    requestUUID?: string
  }) => {
    try {
      logger.log(LogCategory.PRELOAD, '发送提示', { inputLength: input.length })

      // 通过 IPC 调用主进程
      const result = await ipcRenderer.invoke('electronai-prompt', input, options)
      logger.log(LogCategory.PRELOAD, '提示响应成功', { resultLength: result.length })
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '提示请求失败', error)
      throw error
    }
  },

  // 流式提示
  promptStreaming: async (input: string, options?: {
    responseJSONSchema?: unknown
    signal?: AbortSignal
    timeout?: number
    requestUUID?: string
  }) => {
    try {
      logger.log(LogCategory.PRELOAD, '发送流式提示', { inputLength: input.length })

      // 通过 IPC 调用主进程
      const result = await ipcRenderer.invoke('electronai-prompt-streaming', input, options)
      logger.log(LogCategory.PRELOAD, '流式提示响应成功')
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '流式提示请求失败', error)
      throw error
    }
  },

  // 中止请求
  abortRequest: async (requestUUID: string) => {
    try {
      logger.log(LogCategory.PRELOAD, '中止请求', { requestUUID })
      const result = await ipcRenderer.invoke('electronai-abort-request', requestUUID)
      logger.log(LogCategory.PRELOAD, '请求中止成功')
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '中止请求失败', error)
      throw error
    }
  }
})

logger.log(LogCategory.PRELOAD, 'electronAi API 设置完成')

// 暴露一个安全的ipcRenderer版本
contextBridge.exposeInMainWorld('ipcRenderer', {
  send: (channel: string, data: any) => {
    // 将可信通道列入白名单
    const validChannels = ['renderer-error'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    } else {
      logger.warn(LogCategory.PRELOAD, `ipcRenderer.send called with untrusted channel: ${channel}`);
    }
  },
  on: (channel: string, func: (...args: any[]) => void) => {
    const validChannels: string[] = ['system:log-forward']; // 根据需要添加从主进程到渲染进程的通道
    if (validChannels.includes(channel)) {
      // 刻意剥离 event，因为它包含 'sender'
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    } else {
      logger.warn(LogCategory.PRELOAD, `ipcRenderer.on called with untrusted channel: ${channel}`);
    }
  },
});

// 类型声明已在 apps/desktop/src/shared/types/electron-api.d.ts 中统一定义