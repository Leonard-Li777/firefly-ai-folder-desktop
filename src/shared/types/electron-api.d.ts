/**
 * Electron API 类型定义
 * 这个文件定义了渲染进程中可用的 electronAPI 接口
 *
 * 注意：这是一个完整的类型定义，用于解决 TypeScript 编译错误
 * 与 preload.ts 中的实际实现保持同步
 */

import { AppConfig, WorkspaceDirectory } from '@yonuc/types'
import { IModelRecommendation, IModelSummary } from '@yonuc/types/model-manager'
import type { ConfigKey } from '@yonuc/types/config-types'
import { FileInfo } from '@yonuc/core-engine'
import {
  DimensionGroup,
  SelectedTag,
  VirtualDirectoryFilter,
  SavedVirtualDirectory
} from '@yonuc/types/virtual-directory'
import { FileAnalysisResult, AnalysisQueueStatus } from '@yonuc/types/file-analysis-types'

// 导入统一的类型定义
import type { AIClassificationResult } from '@yonuc/types'

// 导入统一的文件和目录类型
import type { FileItem, DirectoryItem } from '@yonuc/types'

// 导入统一的硬件信息类型
import type { HardwareInfo } from '@yonuc/types'

// 分析队列项接口
interface AnalysisQueueItem {
  id: string
  path: string
  name: string
  type: string
  status: 'pending' | 'analyzing' | 'completed' | 'failed'
  progress: number
  error?: string
  startTime?: string
  endTime?: string
  result?: string
  priority: number
  retryCount: number
  maxRetries: number
  createdAt: string
  updatedAt: string
}

// 分析队列状态接口
interface AnalysisQueue {
  items: AnalysisQueueItem[]
  status: AnalysisQueueStatus
  running: boolean
  currentItem?: AnalysisQueueItem
}

// 对话框选项接口
interface DialogOptions {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: Array<{
    name: string
    extensions: string[]
  }>
  properties?: string[]
}

// 消息框选项接口
interface MessageBoxOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  buttons?: string[]
  defaultId?: number
  title?: string
  message: string
  detail?: string
  checkboxLabel?: string
  checkboxChecked?: boolean
  icon?: string
  cancelId?: number
  noLink?: boolean
  normalizeAccessKeys?: boolean
}

// 消息框返回值接口
interface MessageBoxReturnValue {
  response: number
  checkboxChecked?: boolean
}

// LibreOffice 检测结果接口
interface LibreOfficeDetection {
  isInstalled: boolean
  version?: string
  path?: string
  executablePath?: string
}

// 文件单元接口
interface FileUnit {
  id: number
  name: string
  description?: string
  type: string
  path?: string
  groupingReason: string
  groupingConfidence: number
  author?: string
  title?: string
  tags?: string
  qualityScore?: number
  parentUnitId?: string
  isAnalyzed: boolean
  analyzedAt?: Date
  analysisError?: string
  workspaceId: number
  createdAt: Date
  updatedAt: Date
}

// 目录分析结果接口
interface DirectoryAnalysisResult {
  path: string
  fileCount: number
  totalSize: number
  analysisDate: Date
  summary?: string
  tags?: string[]
  quality?: number
}

// 虚拟目录生成参数接口
interface VirtualDirectoryGenerateParams {
  workspaceDirectoryPath: string
  directoryTree: DirectoryTreeNode[]
  tagFileMap: Record<string, FileReference[]>
  options: {
    flattenToRoot: boolean
    skipEmptyDirectories: boolean
    enableNestedClassification: boolean
  }
}

// 目录树节点接口
interface DirectoryTreeNode {
  name: string
  path: string[]
  parent?: string
  description?: string
  files: FileReference[]
  children: DirectoryTreeNode[]
  fileCount?: number
  dimensionId?: number
  dimensionName?: string
  tagValue?: string
}

// 文件引用接口
interface FileReference {
  name: string
  smartName?: string
  path?: string
}

// 虚拟目录批量保存参数接口
interface VirtualDirectoryBatchSaveParams {
  name: string
  filter: VirtualDirectoryFilter
  path: string[]
}

// 虚拟目录批量保存结果接口
interface VirtualDirectoryBatchSaveResult {
  name: string
  path: string
}

// 整理预览结果接口
interface OrganizePreviewResult {
  operations: OrganizeOperation[]
  summary: {
    totalFiles: number
    totalDirectories: number
    estimatedTime: number
  }
}

// 整理操作接口
interface OrganizeOperation {
  type: 'move' | 'copy' | 'create_directory'
  source?: string
  destination: string
  fileCount?: number
}

// 整理参数接口
interface OrganizeParams {
  workspaceDirectoryPath: string
  savedDirectories: SavedVirtualDirectory[]
}

// AI 生成结构接口
interface AIGeneratedStructure {
  directories: Array<{
    name: string
    path: string
    files: string[]
  }>
  reasoning?: string
}

// 快速整理参数接口
interface QuickOrganizeParams {
  workspaceDirectoryPath: string
  aiGeneratedStructure: AIGeneratedStructure
}

// 整理计划生成参数接口
interface OrganizePlanParams {
  workspaceDirectoryPath: string
  options?: {
    batchSize?: number
    temperature?: number
    maxTokens?: number
  }
  onProgress?: (progress: OrganizeProgress) => void
}

// 整理进度接口
interface OrganizeProgress {
  stage: string
  progress: number
  message: string
  currentFile?: string
  totalFiles?: number
  processedFiles?: number
}

// 整理会话接口
interface OrganizeSession {
  id: string
  workspaceDirectoryPath: string
  createdAt: Date
  operations: OrganizeOperation[]
  status: 'completed' | 'failed' | 'partial'
}

// 撤销会话参数接口
interface UndoSessionParams {
  workspaceDirectoryPath: string
  sessionId: string
}

// 删除会话参数接口
interface DeleteSessionParams {
  workspaceDirectoryPath: string
  sessionId: string
}

// 空文件夹扫描结果接口
interface EmptyFolderScanResult {
  emptyFolders: string[]
  totalCount: number
  totalSize: number
}

// 空文件夹删除结果接口
interface EmptyFolderDeleteResult {
  deletedFolders: string[]
  failedFolders: Array<{
    path: string
    error: string
  }>
  totalDeleted: number
}

// AI 分类请求接口
interface AIClassificationRequest {
  fileId: string
  filePath: string
  fileName: string
  fileType: string
  content?: string
  metadata?: Record<string, unknown>
}

// 模型下载进度接口
interface ModelDownloadProgress {
  modelId: string
  progress: number
  speed: string
}

// 模型下载完成接口
interface ModelDownloadComplete {
  modelId: string
}

// 模型下载错误接口
interface ModelDownloadError {
  modelId: string
  error: string
}

// 模型状态变化接口
interface ModelStatusChange {
  modelName: string | null
  status: string
}

// AI 服务初始化结果接口
interface AIServiceInitResult {
  success: boolean
  message: string
  initInfo?: {
    modelId?: string
    modelPath?: string
    initTime?: number
  }
}

// AI 服务初始化信息接口
interface AIServiceInitInfo {
  isInitialized: boolean
  isInitializing: boolean
  attempts: number
  lastError?: string
  initTime?: number
}

// AI 服务模型变更结果接口
interface AIServiceModelChangeResult {
  success: boolean
  message: string
}

// 启动标志接口
interface StartupFlags {
  forceConfigStage: boolean
}

// 文件系统读取结果接口
interface ReadDirectoryResult {
  files: FileItem[]
  directories: DirectoryItem[]
}

// 虚拟目录过滤参数接口
interface VirtualDirectoryFilterParams {
  selectedTags: SelectedTag[]
  sortBy: string
  sortOrder: string
  workspaceDirectoryPath?: string
  searchKeyword?: string
}

interface VirtualDirectoryFilterPagedParams extends VirtualDirectoryFilterParams {
  limit: number
  offset: number
}

interface VirtualDirectoryPagedResult {
  items: FileInfo[]
  total: number
}

// 忽略规则接口
interface AnalysisIgnoreRule {
  id: string
  pattern: string
  type: 'glob' | 'regex' | 'extension'
  description?: string
  enabled: boolean
}

// ElectronAI 创建选项接口
interface ElectronAICreateOptions {
  modelAlias: string
  systemPrompt?: string
  initialPrompts?: Array<{ role: string; content: string }>
  topK?: number
  temperature?: number
  requestUUID?: string
}

// ElectronAI 提示选项接口
interface ElectronAIPromptOptions {
  responseJSONSchema?: Record<string, unknown>
  signal?: AbortSignal
  timeout?: number
  requestUUID?: string
}

// ElectronLLM 聊天选项接口
interface ElectronLLMChatOptions {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  max_tokens?: number
}

// ElectronLLM 聊天结果接口
interface ElectronLLMChatResult {
  response: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

// ElectronLLM 状态接口
interface ElectronLLMStatus {
  initialized: boolean
  modelLoaded?: boolean
  modelId?: string
  error?: string
}

declare global {
  interface Window {
    electronAPI: {
      [x: string]: any

      // 应用是否已打包（用于 PostHog 等服务的放行判断）
      isPackaged: boolean

      // 系统日志
      onLogForwarded: (callback: (payload: { category: LogCategory, level: string, message: string, data?: any, origin: 'backend' | 'frontend' }) => void) => () => void

      // 文件操作
      getAllFiles: () => Promise<FileInfo[]>
      addFile: (file: FileInfo) => Promise<void>

      // AI分类
      classifyFile: (
        filename: string,
        contentPreview?: string,
        metadata?: Record<string, unknown>
      ) => Promise<AIClassificationResult>
      classifyFileWithLLM: (
        modelId: string,
        prompt: string,
        filename: string
      ) => Promise<AIClassificationResult>

      // 配置管理
      getConfig: () => Promise<AppConfig>
      updateConfig: (updates: Partial<AppConfig>) => Promise<void>
      updateConfigValue: (key: ConfigKey, value: unknown, options?: { preventAutoReload?: boolean }) => Promise<void>
      onConfigChange: (callback: (config: AppConfig) => void) => () => void
      getStartupFlags: () => Promise<StartupFlags>
      initializeAppPhase: () => Promise<void>

      // AI状态
      getAIStatus: () => Promise<string>

      // AI服务管理
      aiService: {
        initialize: (options?: { onlyDeploy?: boolean }) => Promise<AIServiceInitResult>
        isInitialized: () => Promise<boolean>
        getInitializationInfo: () => Promise<AIServiceInitInfo>
        onModelChanged: (modelId: string) => Promise<AIServiceModelChangeResult>
        getServerLogs: (limit?: number) => Promise<any[]>
        clearServerLogs: () => Promise<any>
        setConfigReloadSuspended: (suspended: boolean) => Promise<void>
      }

      // 分析队列
      getAnalysisQueue: () => Promise<AnalysisQueue>
      addToAnalysisQueue: (
        items: { path: string; name: string; size: number; type: string }[],
        forceReanalyze?: boolean
      ) => Promise<void>
      addToAnalysisQueueResolved: (
        items: { path: string; name: string; size: number; type: string }[],
        forceReanalyze?: boolean
      ) => Promise<void>
      retryFailedAnalysis: () => Promise<void>
      clearPendingAnalysis: () => Promise<void>
      deleteAnalysisItem: (id: string) => Promise<void>
      startAnalysis: () => Promise<void>
      pauseAnalysis: () => Promise<void>
      checkExtensionMismatch: (workspaceId: number) => Promise<
        Array<{
          fileFingerprint: string
          path: string
          name: string
          type: string
          extensions: string[]
        }>
      >
      batchFixExtensions: (fixes: Array<{ fileFingerprint: string; chosenExtension: string | null }>) => Promise<{ success: boolean; count: number }>
      onAnalysisQueueUpdated: (callback: (payload: AnalysisQueue) => void) => () => void
      onModelStatusChanged: (callback: (payload: ModelStatusChange) => void) => () => void
      onModelNotDownloaded: (callback: (payload: { modelId?: string }) => void) => () => void

      // 模型管理
      listModels: () => Promise<IModelSummary[]>
      listModelsFast: () => Promise<IModelSummary[]>
      getHardwareInfo: () => Promise<HardwareInfo>
      recommendModelsByHardware: (
        memoryGB: number,
        hasGPU: boolean,
        vramGB?: number
      ) => Promise<IModelRecommendation>
      isModelDownloaded: (modelId: string) => Promise<boolean>
      getModelPath: (modelId: string) => Promise<string | null>
      startModelDownload: (modelId: string) => Promise<void>
      cancelModelDownload: (taskId: string) => Promise<void>
      deleteModel: (modelId: string) => Promise<void>

      migrateBuiltinModels: (targetDir: string) => Promise<{ success: boolean; error?: string }>
      migrateFromOldPath: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>
      onModelMigrationProgress: (callback: (message: string) => void) => () => void

      // 模型下载事件
      onModelDownloadProgress: (callback: (payload: ModelDownloadProgress) => void) => () => void
      onModelDownloadComplete: (callback: (payload: ModelDownloadComplete) => void) => () => void
      onModelDownloadError: (callback: (payload: ModelDownloadError) => void) => () => void
      onSSLCertificateError: (callback: (event: Event) => void) => () => void

      // 工作目录更新事件
      onWorkspaceDirectoriesUpdated: (callback: () => void) => () => void

      utils: {
        getPlatform: () => string
        normalizeForCache: (p: string) => string
        isPathEqual: (p1?: string | null, p2?: string | null) => boolean
        stripTrailingSlash: (p: string) => string
        pathSeparator: string
        normalizePath: (p: string) => string
        isSubPath: (parent: string, child: string) => boolean
        showOpenDialog: (
          options: DialogOptions
        ) => Promise<{ canceled: boolean; filePaths: string[] }>
        showSaveDialog: (
          options: DialogOptions
        ) => Promise<{ canceled: boolean; filePath?: string }>
        showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
        getUserHomePath: () => Promise<string>
        joinPath: (basePath: string, relativePath: string) => Promise<string>
        openFileWithDefaultApp: (filePath: string) => Promise<void>
        openPathInExplorer: (dirPath: string) => Promise<void>
        writeFile: (filePath: string, content: string) => Promise<void>
        detectLibreOffice: () => Promise<LibreOfficeDetection>
        detectFfmpeg: () => Promise<any>
        openExternal: (url: string) => Promise<void>
        readFileBase64: (filePath: string) => Promise<string>
        readFileBuffer: (filePath: string) => Promise<Uint8Array>
      }

      // Window controls
      window: {
        minimize: () => Promise<void>
        maximize: () => Promise<void>
        isMaximized: () => Promise<boolean>
        close: () => Promise<void>
      }

      // 工作目录管理
      addWorkspaceDirectory: (directory: WorkspaceDirectory) => Promise<void>
      getAllWorkspaceDirectories: () => Promise<WorkspaceDirectory[]>
      getCurrentWorkspaceDirectory: () => Promise<WorkspaceDirectory | null>
      setCurrentWorkspaceDirectory: (path: string | null) => Promise<void>
      deleteWorkspaceDirectory: (path: string) => Promise<{ success: boolean; error?: string }>
      resetWorkspaceDirectory: (directoryPath: string) => Promise<void>
      rescanWorkspaceDirectory: (
        workspaceId: number
      ) => Promise<{ success: boolean; message: string }>
      resetAnalysisDatabase: () => Promise<void>
      getAnalysisIgnoreRules: () => Promise<AnalysisIgnoreRule[]>
      saveAnalysisIgnoreRules: (rules: AnalysisIgnoreRule[]) => Promise<void>

      // 集成测试专用：直接执行数据库查询
      getDatabase: () => {
        prepare: (sql: string) => {
          get: (...params: any[]) => Promise<any>
          all: (...params: any[]) => Promise<any[]>
          run: (...params: any[]) => Promise<{ changes: number; lastInsertRowid: number | bigint }>
        }
      }

      updateWorkspaceDirectoryAutoWatch: (workspaceId: number, autoWatch: boolean) => Promise<void>

      // 单元查询
      getUnitsForFile: (fileId: string) => Promise<FileUnit[]>
      getUnitsForPath: (filePath: string) => Promise<FileUnit[]>

      // AI分析结果查询
      getFileAnalysisResult: (filePath: string) => Promise<FileAnalysisResult | null>
      getDirectoryAnalysisResult: (dirPath: string) => Promise<DirectoryAnalysisResult | null>

      // 目录上下文分析
      analyzeDirectoryContext: (dirPath: string) => Promise<DirectoryAnalysisResult>
      clearDirectoryContext: (dirPath: string) => Promise<{ success: boolean }>
      updateDirectoryContextAnalysis: (
        dirPath: string,
        updates: {
          namingPattern?: string
          analysisStrategy?: string
          namingTemplate?: string
          inheritMode?: {
            analysisStrategy?: 'inherit' | 'current_only' | 'broadcast'
            namingPattern?: 'inherit' | 'current_only' | 'broadcast'
            namingTemplate?: 'inherit' | 'current_only' | 'broadcast'
          }
        }
      ) => Promise<any>
      applyDirectoryNamingTemplateToFiles: (
        dirPath: string
      ) => Promise<{ updatedCount: number; totalCount: number; success: boolean }>

      // 文件系统操作
      readDirectory: (path: string) => Promise<ReadDirectoryResult>

      // 虚拟目录相关
      virtualDirectory: {
        getDimensionGroups: (workspaceDirectoryPath?: string) => Promise<DimensionGroup[]>
        getFilteredFiles: (params: VirtualDirectoryFilterParams) => Promise<FileInfo[]>
        getFilteredFilesPaged: (params: VirtualDirectoryFilterPagedParams) => Promise<VirtualDirectoryPagedResult>
        saveDirectory: (
          directory: SavedVirtualDirectory,
          workspaceDirectoryPath?: string
        ) => Promise<string | undefined>
        batchSaveDirectories: (
          directories: VirtualDirectoryBatchSaveParams[],
          workspaceDirectoryPath: string
        ) => Promise<VirtualDirectoryBatchSaveResult[]>
        generateFromPreviewTree: (
          params: VirtualDirectoryGenerateParams
        ) => Promise<SavedVirtualDirectory[]>
        getSavedDirectories: (workspaceDirectoryPath?: string) => Promise<SavedVirtualDirectory[]>
        deleteDirectory: (id: string, workspaceDirectoryPath?: string) => Promise<void>
        renameDirectory: (id: string, newName: string) => Promise<void>
        isFirst: (workspaceDirectoryPath?: string) => Promise<boolean>
        cleanup: (workspaceDirectoryPath: string) => Promise<void>
        getAnalyzedFilesCount: (workspaceDirectoryPath?: string) => Promise<number>
      }

      // 文件清理相关
      fileCleanup: {
        deleteFile: (fileId: number) => Promise<void>
        batchDeleteFiles: (fileIds: number[]) => Promise<void>
      }

      // 批量预处理工作台 (重命名、打标、查重、有效画像配置)
      organizeBatch: {
        previewRename: (template: string, files: any[]) => Promise<any[]>
        executeRename: (template: string, files: any[]) => Promise<any>
        getRandomTemplate: () => Promise<string>
        applyTags: (operation: any) => Promise<any>
        deleteTagGlobally: (dimensionId: number, tagName: string) => Promise<boolean>
        scanDuplicates: (options: any) => Promise<any[]>
        trashDuplicates: (filePaths: string[]) => Promise<any>
        applyKeepRule: (groups: any[], rule: string) => Promise<any[]>
        getEffectiveDirectoryConfig: (dirPath: string) => Promise<any>
      }

      deleteTagGlobally: (dimensionId: number, tagName: string) => Promise<boolean>
      getEffectiveDirectoryConfig: (dirPath: string) => Promise<any>

      // 整理真实目录相关
      organizeRealDirectory: {
        exportByVirtualDirectoryId: (params: { virtualDirectoryId: number; workspaceDirectoryPath: string }) => Promise<OrganizePreviewResult>
        byVirtualDirectory: (params: OrganizeParams) => Promise<OrganizePreviewResult>
        getPreview: (params: OrganizeParams) => Promise<OrganizePreviewResult>
        openDirectory: (directoryPath: string) => Promise<void>
        deleteAllVirtualDirectories: (workspaceDirectoryPath: string) => Promise<void>
        getSavedVirtualDirectories: (
          workspaceDirectoryPath: string
        ) => Promise<SavedVirtualDirectory[]>
        getSavedVirtualDirectoriesByPath: (workspaceDirectoryPath: string) => Promise<SavedVirtualDirectory[]>
        getAnalyzedFiles: (workspaceDirectoryPath: string) => Promise<FileInfo[]>
        quickOrganize: (params: QuickOrganizeParams) => Promise<OrganizePreviewResult>
        generatePlan: (params: OrganizePlanParams) => Promise<AIGeneratedStructure>
        listSessions: (workspaceDirectoryPath: string) => Promise<OrganizeSession[]>
        undoSession: (params: UndoSessionParams) => Promise<{ success: boolean; message: string }>
        deleteSession: (
          params: DeleteSessionParams
        ) => Promise<{ success: boolean; message: string }>
        onProgressUpdate: (callback: (progress: OrganizeProgress) => void) => () => void
        onPlanProgress: (callback: (progress: OrganizeProgress) => void) => void
        removePlanProgressListener: () => void
      }

      // 空文件夹清理
      emptyFolder: {
        scan: (workspaceDirectoryPath: string) => Promise<EmptyFolderScanResult>
        delete: (folderPaths: string[]) => Promise<EmptyFolderDeleteResult>
      }

      // AI分类通信
      onAIClassificationRequest: (
        callback: (event: Event, request: AIClassificationRequest) => void
      ) => () => void
      sendAIClassificationResult: (channel: string, result: AIClassificationResult) => void

      // AI Skill API — 整理方案应用
      onApplyOrganizePlan: (callback: (payload: { name: string; strategy: string; perspective?: string }) => void) => () => void
    }

    // 其他全局对象
    electronLLM?: {
      initialized: boolean
      initialize: () => Promise<AIServiceInitResult>
      chat: (options: ElectronLLMChatOptions) => Promise<ElectronLLMChatResult>
      getModelPath: (modelAlias: string) => Promise<string>
      checkStatus: () => Promise<ElectronLLMStatus>
    }

    electronAi?: {
      create: (
        options: ElectronAICreateOptions
      ) => Promise<{ success: boolean; sessionId?: string }>
      destroy: () => Promise<{ success: boolean }>
      prompt: (input: string, options?: ElectronAIPromptOptions) => Promise<string>
      promptStreaming: (
        input: string,
        options?: ElectronAIPromptOptions
      ) => Promise<ReadableStream<string>>
      abortRequest: (requestUUID: string) => Promise<{ success: boolean }>
    }
  }
}

export {}
