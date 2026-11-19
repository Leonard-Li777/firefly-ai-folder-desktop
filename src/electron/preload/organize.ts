// 由 preload.ts 按领域分片（工单 01 preload IPC 桥拆分）。正文为原 electronAPI 区间逐字节等价搬运、零行为改动、零顶层 key 增删。

import type { DirectoryItem, FileItem } from '@firefly/types'
import { ipcRenderer } from 'electron'
import { logger } from './shared-context'

export const organizeApi = {
  // 批量预处理工作台 (重命名、打标、查重、有效画像配置)
  organizeBatch: {
    previewRename: (template: string, files: any[]): Promise<any[]> =>
      ipcRenderer.invoke('batch-rename:preview', template, files),
    executeRename: (template: string, files: any[]): Promise<any> =>
      ipcRenderer.invoke('batch-rename:execute', template, files),
    getRandomTemplate: (): Promise<string> => ipcRenderer.invoke('batch-rename:random-template'),
    applyTags: (operation: any): Promise<any> => ipcRenderer.invoke('batch-tag:apply', operation),
    inspectControlledTags: (items: any[], language?: string): Promise<any> =>
      ipcRenderer.invoke('batch-tag:inspect-controlled-tags', items, language),
    deleteTagGlobally: (dimensionId: number, tagName: string): Promise<boolean> =>
      ipcRenderer.invoke('delete-tag-globally', dimensionId, tagName),
    scanDuplicates: (options: any): Promise<any[]> => ipcRenderer.invoke('duplicate:scan', options),
    onScanProgress: (callback: (data: any) => void): (() => void) => {
      const handler = (_: any, data: any) => callback(data)
      ipcRenderer.on('duplicate:scan-progress', handler)
      return () => ipcRenderer.removeListener('duplicate:scan-progress', handler)
    },
    trashDuplicates: (filePaths: string[]): Promise<any> =>
      ipcRenderer.invoke('duplicate:trash', filePaths),
    executeStrategyFix: (
      action: any,
      fileTargets: Array<string | { path: string; newName?: string }>,
      workspaceDirectoryPath?: string
    ): Promise<any> =>
      ipcRenderer.invoke('duplicate:execute-fix', action, fileTargets, workspaceDirectoryPath),
    applyKeepRule: (groups: any[], rule: string): Promise<any[]> =>
      ipcRenderer.invoke('duplicate:apply-keep-rule', groups, rule),
    getEffectiveDirectoryConfig: (dirPath: string): Promise<any> =>
      ipcRenderer.invoke('get-effective-directory-config', dirPath)
  },

  deleteTagGlobally: (dimensionId: number, tagName: string): Promise<boolean> =>
    ipcRenderer.invoke('delete-tag-globally', dimensionId, tagName),

  getEffectiveDirectoryConfig: (dirPath: string): Promise<any> =>
    ipcRenderer.invoke('get-effective-directory-config', dirPath),

  // 多虚拟目录相关
  virtualDirectory: {
    list: (workspaceIdOrPath: number | string, options?: { includeDrafts?: boolean }) =>
      ipcRenderer.invoke('virtual-directory/list', workspaceIdOrPath, options),

    get: (id: number) => ipcRenderer.invoke('virtual-directory/get', id),
    createFromStrategy: (
      workspaceId: number,
      name: string,
      strategy: string,
      source: string,
      icon?: string,
      perspective?: string,
      rationale?: string
    ) =>
      ipcRenderer.invoke(
        'virtual-directory/create-from-strategy',
        workspaceId,
        name,
        strategy,
        source,
        icon,
        perspective,
        rationale
      ),
    updateMeta: (id: number, meta: any) =>
      ipcRenderer.invoke('virtual-directory/update-meta', id, meta),
    delete: (id: number, options: any) =>
      ipcRenderer.invoke('virtual-directory/delete', id, options),
    rename: (id: number, newName: string) =>
      ipcRenderer.invoke('virtual-directory/rename', id, newName),
    replaceFiles: (virtualDirectoryId: number, files: any[]) =>
      ipcRenderer.invoke('virtual-directory/replace-files', virtualDirectoryId, files),
    listFiles: (virtualDirectoryId: number) =>
      ipcRenderer.invoke('virtual-directory/list-files', virtualDirectoryId),
    getTreeSnapshotAsTree: (virtualDirectoryId: number) =>
      ipcRenderer.invoke('virtual-directory/get-tree-snapshot-as-tree', virtualDirectoryId),
    exportToPhysical: (virtualDirectoryId: number) =>
      ipcRenderer.invoke('virtual-directory/export-to-physical', virtualDirectoryId),
    exportByPreviewTree: (params: {
      type: 'virtual' | 'real'
      tree: any[]
      options: {
        flattenToRoot: boolean
        flattenDirectories: boolean
        skipEmptyDirectories: boolean
        enableNestedClassification: boolean
        deduplicateFiles: boolean
      }
      virtualDirectoryId: number
      workspaceDirectoryPath?: string
      virtualDirectoryName?: string
    }) => ipcRenderer.invoke('virtual-directory/export-by-preview-tree', params),
    retryFailedExport: (params: { failedOperations: Array<{ source: string; target: string }> }) =>
      ipcRenderer.invoke('virtual-directory/retry-failed-export', params),
    generateNameAndStrategyCandidates: (
      workspaceId: number,
      count?: number,
      userHint?: string,
      organizeMode?: string,
      selectedFileIds?: number[]
    ) =>
      ipcRenderer.invoke(
        'virtual-directory/generate-name-and-strategy-candidates',
        workspaceId,
        count,
        userHint,
        organizeMode,
        selectedFileIds
      ),
    generateHACClusterScheme: (
      workspaceId: number,
      selectedFileIds?: number[],
      userPrompt?: string
    ) =>
      ipcRenderer.invoke(
        'virtual-directory/generate-hac-cluster-scheme',
        workspaceId,
        selectedFileIds,
        userPrompt
      ),
    saveFromPlan: (
      workspaceId: number,
      name: string,
      structure: { summary: string; directories: any[] }
    ) => ipcRenderer.invoke('virtual-directory/save-from-plan', workspaceId, name, structure),
    checkIsLimitPredict: () => ipcRenderer.invoke('virtual-directory/check-is-limit-predict'),
    generateExternalDirectoryPlanPrompt: (params: {
      fileCount: number | string
      totalDirCount?: number | string
      fileTypeDistribution: string
      tagsSection?: string
      fileStructurePreview: string
      organizeMode?: string
    }): Promise<string | null> =>
      ipcRenderer.invoke('virtual-directory/generate-external-directory-plan-prompt', params),
    estimateReorganizeBatches: (virtualDirectoryId: number, options: any) =>
      ipcRenderer.invoke(
        'virtual-directory/estimate-reorganize-batches',
        virtualDirectoryId,
        options
      ),
    reorganize: (virtualDirectoryId: number, options: any) =>
      ipcRenderer.invoke('virtual-directory/reorganize', virtualDirectoryId, options),
    pauseReorganize: (virtualDirectoryId: number) =>
      ipcRenderer.invoke('virtual-directory/pause-reorganize', virtualDirectoryId),
    resumeReorganize: (virtualDirectoryId: number) =>
      ipcRenderer.invoke('virtual-directory/resume-reorganize', virtualDirectoryId),
    endReorganize: (virtualDirectoryId: number) =>
      ipcRenderer.invoke('virtual-directory/end-reorganize', virtualDirectoryId),
    getIncrementalFilesToOrganize: (
      workspaceDirectoryPath: string,
      virtualDirectoryId: number,
      workspaceId?: number
    ) =>
      ipcRenderer.invoke(
        'virtual-directory/get-incremental-files-to-organize',
        workspaceDirectoryPath,
        virtualDirectoryId,
        workspaceId
      ),

    syncIncrementalDirectoryTree: (virtualDirectoryId: number, selectedTagsTree: any[]) =>
      ipcRenderer.invoke(
        'virtual-directory/sync-incremental-directory-tree',
        virtualDirectoryId,
        selectedTagsTree
      ),
    syncPhysicalHardlinks: (virtualDirectoryId: number, workspacePath: string) =>
      ipcRenderer.invoke(
        'virtual-directory/sync-physical-hardlinks',
        virtualDirectoryId,
        workspacePath
      ),
    onReorganizeProgress: (callback: (progress: any) => void) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('virtual-directory/reorganize-progress', handler)
      return () => ipcRenderer.removeListener('virtual-directory/remove-progress', handler)
    }
  },

  // AI分析结果查询
  getFileAnalysisResult: (filePath: string) =>
    ipcRenderer.invoke('get-file-analysis-result', filePath),
  resetFileAnalysis: (fileId: string) => ipcRenderer.invoke('reset-file-analysis', fileId),
  deleteFileTag: (filePath: string, tagId: number) =>
    ipcRenderer.invoke('delete-file-tag', filePath, tagId),
  getDirectoryAnalysisResult: (dirPath: string) =>
    ipcRenderer.invoke('get-directory-analysis-result', dirPath),

  // 目录上下文分析
  analyzeDirectoryContext: (dirPath: string, force?: boolean): Promise<any> =>
    ipcRenderer.invoke('analyze-directory-context', dirPath, force),
  clearDirectoryContext: (dirPath: string): Promise<any> =>
    ipcRenderer.invoke('clear-directory-context', dirPath),

  // 更新目录上下文分析字段（智能文件名格式 / AI分析策略 / 继承模式）
  updateDirectoryContextAnalysis: (
    dirPath: string,
    updates: {
      namingPattern?: string
      analysisStrategy?: string
      namingTemplate?: string
      analysisStrategy_suggestion?: string
      namingPattern_suggestion?: string
      inheritMode?: {
        analysisStrategy?: 'inherit' | 'current_only' | 'broadcast'
        namingPattern?: 'inherit' | 'current_only' | 'broadcast'
        namingTemplate?: 'inherit' | 'current_only' | 'broadcast'
      }
    }
  ): Promise<any> => ipcRenderer.invoke('update-directory-context-analysis', dirPath, updates),

  applyDirectoryNamingTemplateToFiles: (
    dirPath: string
  ): Promise<{ updatedCount: number; totalCount: number; success: boolean }> =>
    ipcRenderer.invoke('apply-directory-naming-template-to-files', dirPath),

  // 文件系统操作
  readDirectory: (path: string): Promise<{ files: FileItem[]; directories: DirectoryItem[] }> =>
    ipcRenderer.invoke('read-directory', path),

  // 已分析目录相关 (原虚拟目录)
  analyzedDirectory: {
    getDimensionGroups: (
      options?:
        | {
            workspaceDirectoryPath?: string
            workspaceId?: number
            language?: string
            excludeExtensionDimension?: boolean
            removeEmptyTags?: boolean
            virtualDirectoryId?: number
            selectedTags?: any[]
            unionMode?: 'union' | 'intersection'
            includeAllPresetTags?: boolean
          }
        | string,
      language?: string
    ) => {
      // 兼容旧的 string 参数
      const opts =
        typeof options === 'string' ? { workspaceDirectoryPath: options, language } : options || {}
      return ipcRenderer.invoke('analyzed-directory/get-dimension-groups', opts)
    },
    getFilteredFiles: (params: {
      selectedTags: any[]
      sortBy: string
      sortOrder: string
      workspaceDirectoryPath?: string
      searchKeyword?: string
      virtualDirectoryId?: number
      unionMode?: 'union' | 'intersection'
    }) => ipcRenderer.invoke('analyzed-directory/get-filtered-files', params),
    getFilteredFilesPaged: (params: {
      selectedTags: any[]
      sortBy: string
      sortOrder: string
      workspaceDirectoryPath?: string
      searchKeyword?: string
      virtualDirectoryId?: number
      limit: number
      offset: number
      unionMode?: 'union' | 'intersection'
    }) => ipcRenderer.invoke('analyzed-directory/get-filtered-files-paged', params),
    saveDirectory: (directory: any, workspaceDirectoryPath?: string): Promise<string | undefined> =>
      ipcRenderer.invoke('analyzed-directory/save-directory', directory, workspaceDirectoryPath),
    batchSaveDirectories: (
      directories: Array<{
        name: string
        filter: any
        path: string[]
      }>,
      workspaceDirectoryPath: string
    ): Promise<Array<{ name: string; path: string }>> =>
      ipcRenderer.invoke(
        'analyzed-directory/batch-save-directories',
        directories,
        workspaceDirectoryPath
      ),
    getSavedDirectories: (workspaceDirectoryPath?: string) =>
      ipcRenderer.invoke('analyzed-directory/get-saved-directories', workspaceDirectoryPath),
    deleteDirectory: (id: string, workspaceDirectoryPath?: string) =>
      ipcRenderer.invoke('analyzed-directory/delete-directory', id, workspaceDirectoryPath),
    renameDirectory: (id: string, newName: string) =>
      ipcRenderer.invoke('analyzed-directory/rename-directory', id, newName),
    isFirst: (workspaceDirectoryPath?: string): Promise<boolean> =>
      ipcRenderer.invoke('analyzed-directory/is-first', workspaceDirectoryPath),
    cleanup: (workspaceDirectoryPath: string) =>
      ipcRenderer.invoke('analyzed-directory/cleanup', workspaceDirectoryPath),
    getAnalyzedFilesCount: (workspaceDirectoryPath?: string) =>
      ipcRenderer.invoke('analyzed-directory/get-analyzed-files-count', workspaceDirectoryPath),
    getPrivateAnalyzedFilesCount: () =>
      ipcRenderer.invoke('analyzed-directory/get-private-analyzed-files-count'),
    findFirstHardlink: (filePath: string) =>
      ipcRenderer.invoke('analyzed-directory/find-first-hardlink', filePath)
  },

  // 整理真实目录
  organizeRealDirectory: {
    exportByVirtualDirectoryId: (params: {
      virtualDirectoryId: number
      workspaceDirectoryPath: string
      virtualDirectoryName: string
    }) => ipcRenderer.invoke('organize-real-directory/export-by-vd-id', params),
    byVirtualDirectory: (params: {
      workspaceDirectoryPath: string
      savedDirectories: Array<{ id: string; name: string; filter?: any }>
    }) => ipcRenderer.invoke('organize-real-directory/by-virtual-directory', params),
    getPreview: (params: { workspaceDirectoryPath: string; savedDirectories: any[] }) =>
      ipcRenderer.invoke('organize-real-directory/get-preview', params),
    openDirectory: (directoryPath: string) =>
      ipcRenderer.invoke('organize-real-directory/open-directory', directoryPath),
    deleteAllVirtualDirectories: (workspaceDirectoryPath: string) =>
      ipcRenderer.invoke(
        'organize-real-directory/delete-all-virtual-directories',
        workspaceDirectoryPath
      ),
    getSavedVirtualDirectories: (workspaceDirectoryPath: string) =>
      ipcRenderer.invoke(
        'organize-real-directory/get-saved-virtual-directories',
        workspaceDirectoryPath
      ),
    getAnalyzedFiles: (workspaceDirectoryPath: string, selectedFileIds?: number[]) =>
      ipcRenderer.invoke(
        'organize-real-directory/get-analyzed-files',
        workspaceDirectoryPath,
        selectedFileIds
      ),
    getLightweightFiles: (
      workspaceDirectoryPath: string,
      selectedFileIds?: number[],
      limit?: number
    ) =>
      ipcRenderer.invoke(
        'organize-real-directory/get-lightweight-files',
        workspaceDirectoryPath,
        selectedFileIds,
        limit
      ),
    getAnalyzedCount: (workspaceDirectoryPath: string) =>
      ipcRenderer.invoke('organize-real-directory/get-analyzed-count', workspaceDirectoryPath),
    matchPerspectivesAndStructures: (request: any) =>
      ipcRenderer.invoke('organize-real-directory/match-perspectives-and-structures', request),
    calculateFilePathsCosine: (request: any) =>
      ipcRenderer.invoke('organize-real-directory/calculate-file-paths-cosine', request),
    smartClusterHac: (params: {
      workspaceId?: number
      workspaceDirectoryPath?: string
      fileIds?: number[]
      prompt?: string
      distanceThreshold?: number
      maxLeafSize?: number
      maxDepth?: number
      maxRootDirectories?: number
      maxSubdirectories?: number
      similarityThreshold?: number
      clusteringMode?: 'precise' | 'balanced' | 'complete'
      force?: boolean
    }) => ipcRenderer.invoke('organize-real-directory/smart-cluster-hac', params),
    listSessions: (workspaceDirectoryPath: string) =>
      ipcRenderer.invoke('organize-real-directory/list-sessions', workspaceDirectoryPath),
    undoSession: (params: { workspaceDirectoryPath: string; sessionId: string }) =>
      ipcRenderer.invoke('organize-real-directory/undo-session', params),
    deleteSession: (params: { workspaceDirectoryPath: string; sessionId: string }) =>
      ipcRenderer.invoke('organize-real-directory/delete-session', params),
    onProgressUpdate: (callback: (progress: any) => void) => {
      const handler = (_event: any, progress: any) => callback(progress)
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
    delete: (folderPaths: string[]) => ipcRenderer.invoke('empty-folder/delete', folderPaths)
  },

  // AI分类通信
  onAIClassificationRequest: (callback: (event: any, request: any) => void) => {
    const handler = (_event: any, request: any) => callback(_event, request)
    ipcRenderer.on('ai-classification-request', handler)
    return () => ipcRenderer.removeListener('ai-classification-request', handler)
  },

  sendAIClassificationResult: (channel: string, result: any) => {
    ipcRenderer.send(channel, result)
  }
}
