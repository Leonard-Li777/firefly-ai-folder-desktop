/**
 * 分析队列服务类型定义
 */

/**
 * 错误类型枚举
 */
export enum AnalysisErrorType {
  FILE_ACCESS_ERROR = 'FILE_ACCESS_ERROR',           // 文件访问错误
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',                 // 文件未找到
  PERMISSION_DENIED = 'PERMISSION_DENIED',           // 权限被拒绝
  FILE_LOCKED = 'FILE_LOCKED',                       // 文件被锁定
  PROCESSING_ERROR = 'PROCESSING_ERROR',             // 处理错误
  UNSUPPORTED_FORMAT = 'UNSUPPORTED_FORMAT',         // 不支持的格式
  FILE_CORRUPTED = 'FILE_CORRUPTED',                 // 文件损坏
  PROCESSING_TIMEOUT = 'PROCESSING_TIMEOUT',         // 处理超时
  AI_SERVICE_ERROR = 'AI_SERVICE_ERROR',             // AI服务错误
  MODEL_NOT_LOADED = 'MODEL_NOT_LOADED',             // 模型未加载
  AI_REQUEST_TIMEOUT = 'AI_REQUEST_TIMEOUT',         // AI请求超时
  AI_CLASSIFICATION_FAILED = 'AI_CLASSIFICATION_FAILED', // 分类失败
  DATABASE_ERROR = 'DATABASE_ERROR',                 // 数据库错误
  UNIT_RECOGNITION_ERROR = 'UNIT_RECOGNITION_ERROR', // 单元识别错误
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'                    // 未知错误
}

/**
 * 分析错误接口
 */
export interface IAnalysisError {
  id: string
  timestamp: string
  errorType: AnalysisErrorType
  errorMessage: string
  filePath: string
  stackTrace?: string
  recoveryAction?: string
  retryCount: number
  maxRetries: number
}

/**
 * 错误恢复策略配置
 */
export interface IErrorRecoveryConfig {
  maxRetries: number              // 最大重试次数
  retryDelay: number              // 重试延迟（毫秒）
  backoffMultiplier?: number      // 退避倍数(可选)
  fileProcessingTimeout: number   // 文件处理超时（毫秒）
  aiRequestTimeout: number        // AI请求超时（毫秒）
  unitRecognitionTimeout: number  // 单元识别超时（毫秒）
  enableFallbackProcessing?: boolean  // 启用降级处理(可选)
  skipOnCriticalError?: boolean      // 关键错误时跳过(可选)
  fallbackToBasicAnalysis?: boolean  // 降级到基础分析(可选)
}

/**
 * 入队输入接口
 */
export interface EnqueueInput {
  path: string
  name: string
  size: number
  type: string
  forceReanalyze?: boolean
}

/**
 * 文件处理结果接口
 */
export interface FileProcessingResult {
  content: string
  tags: string[]
  qualityScore?: number
  qualityConfidence?: number
  qualityReasoning?: string
  qualityCriteria?: {
    technical: number
    aesthetic: number
    content: number
    completeness: number
    timeliness: number
  }
  multimodalContent?: string // AI生成的多模态内容描述
  lrc?: string // 语音、字幕、歌词文案
  metadata?: Record<string, any>
}

/**
 * 多模态内容分析结果接口
 */
export interface MultimodalContentAnalysisResult {
  multimodalContent: string // AI生成的多模态内容描述
  lrc?: string // 语音、字幕、歌词文案
  qualityScore: number
  confidence: number
  reasoning: string
  criteria: {
    technical: number
    aesthetic: number
    content: number
    completeness: number
    timeliness: number
  }
}
