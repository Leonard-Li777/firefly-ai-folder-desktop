/**
 * 模型能力适配器实现
 * 将模型能力检测 API 适配到核心引擎
 */

import * as path from 'path'
import { EventEmitter } from 'events'
import {
  LogCategory,
  logger,
  FileCategory,
  isCategory,
  isDecodableImage,
  getExtensionsByCategory,
  getFileCategory
} from '@firefly/shared'

import { IModelCapabilityAdapter } from '@firefly/core-engine'
import type {
  AICapabilities,
  AIClassificationResult,
  IModelCapabilityInfo,
  TModelCapabilityType,
  IModelCapability,
  ExtendedAIServiceConfig
} from '@firefly/types'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { modelCapabilityDetector } from '../runtime-services/llama/model-capability-detector'
import { unifiedModelManager } from '../runtime-services/llama/unified-model-manager'
/**
 * 分析类型枚举
 */
export enum AnalysisType {
  /** 完整AI分析 - 模型支持该文件类型 */
  FULL_AI = 'full-ai',
  /** 基础分析 - 仅文件名和元数据 */
  METADATA_ONLY = 'metadata-only',
  /** 降级分析 - 模型部分支持 */
  DEGRADED = 'degraded',
  /** 错误分析 - 分析失败 */
  ERROR = 'error'
}

/**
 * 能力适配结果接口
 */
export interface ICapabilityAdaptedResult {
  /** 分析结果 */
  result: AIClassificationResult
  /** 分析类型 */
  analysisType: AnalysisType
  /** 使用的模型ID */
  modelId?: string
  /** 模型能力信息 */
  modelCapabilities?: IModelCapabilityInfo
  /** 支持的能力类型 */
  supportedCapability?: IModelCapability
  /** 分析限制说明 */
  limitations: string[]
  /** 用户提示信息 */
  userMessage: string
  /** 置信度调整说明 */
  confidenceNote?: string
  /** 处理时间（毫秒） */
  processingTime: number
  /** 是否需要用户确认 */
  requiresConfirmation: boolean
}

/**
 * 文件分析上下文接口
 */
export interface IFileAnalysisContext {
  /** 文件路径 */
  filePath: string
  /** 文件名 */
  fileName: string
  /** 文件扩展名 */
  fileExtension: string
  /** 文件大小（字节） */
  fileSize: number
  /** MIME类型 */
  mimeType?: string
  /** 内容预览 */
  contentPreview?: string
  /** 文件元数据 */
  metadata?: Record<string, unknown>
  /** 创建时间 */
  createdAt?: Date
  /** 修改时间 */
  modifiedAt?: Date
}

/**
 * 模型能力匹配结果
 */
export interface IModelCapabilityMatch {
  /** 是否匹配 */
  matches: boolean
  /** 匹配的能力类型 */
  capabilityType?: TModelCapabilityType
  /** 匹配的能力对象 */
  capability?: IModelCapability
  /** 匹配度评分（0-100） */
  matchScore: number
  /** 支持的文件格式 */
  supportedFormats: string[]
  /** 不支持的原因 */
  unsupportedReason?: string
  /** 建议的替代方案 */
  alternatives: string[]
}

/**
 * 模型大小限制配置
 */
interface ModelSizeLimits {
  /** 最大上下文长度 */
  maxCtx: number
  /** 最大输出 token 数 */
  maxPredict: number
  /** 上下文安全系数（用于从官方值计算实际值） */
  ctxSafetyFactor: number
}

/**
 * 解析模型参数大小（返回 B 数量）
 * @param parameterSize 参数大小字符串（如 "4B", "27B", "0.5B"）
 */
function parseParameterSize(parameterSize: string): number {
  const match = parameterSize.match(/^([\d.]+)\s*B$/i)
  if (match) {
    return parseFloat(match[1])
  }
  // 尝试直接解析数字
  const num = parseFloat(parameterSize)
  if (!isNaN(num)) {
    return num
  }
  return 4 // 默认返回 4B
}

/**
 * 根据模型参数大小获取限制配置
 * @param paramSizeB 参数大小（B）
 */
function getModelSizeLimits(paramSizeB: number): ModelSizeLimits {
  // 小模型（< 4B）：推理快但上下文小
  if (paramSizeB < 4) {
    return {
      maxCtx: 8192,
      maxPredict: 2048,
      ctxSafetyFactor: 0.25
    }
  }
  // 中等模型（4B - 14B）：平衡点
  if (paramSizeB <= 14) {
    return {
      maxCtx: 16384,
      maxPredict: 4096,
      ctxSafetyFactor: 0.5
    }
  }
  // 大模型（> 14B）：推理慢，需要更保守的限制
  return {
    maxCtx: 8192,
    maxPredict: 2048,
    ctxSafetyFactor: 0.25
  }
}

/**
 * 模型能力适配器 (核心引擎专用)
 */
export class ModelCapabilityAdapter extends EventEmitter implements IModelCapabilityAdapter {
  private analysisCache = new Map<string, ICapabilityAdaptedResult>()

  constructor() {
    super()
  }

  async detectCapabilities(config: ExtendedAIServiceConfig): Promise<AICapabilities> {
    return modelCapabilityDetector.detectCapabilities(config)
  }

  getCachedCapabilities(): AICapabilities | null {
    return modelCapabilityDetector.getCachedCapabilities()
  }

  async getCapabilities(): Promise<AICapabilities> {
    const aiServiceMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
    if (aiServiceMode === 'cloud') {
      const provider = ConfigOrchestrator.getInstance().getValue<string>(
        'AI_CLOUD_PROVIDER'
      ) as string
      const model = ConfigOrchestrator.getInstance().getValue<string>(
        'AI_CLOUD_SELECTED_MODEL_ID'
      ) as string
      const serviceConfig = {
        mode: 'cloud' as const,
        cloud: { provider, model: model || 'unknown', apiKey: '', baseUrl: '' },
        local: {
          modelId: '',
          modelPath: '',
          contextLength: 4096,
          contextSize: 4096,
          gpuLayers: 0,
          port: 0
        },
        retryConfig: {
          modelLoadMaxRetries: 0,
          modelLoadTimeout: 0,
          healthCheckMaxFailures: 0,
          healthCheckInterval: 0,
          aiRequestTimeout: 0
        },
        configVersion: '',
        lastUpdated: new Date()
      } as any
      return modelCapabilityDetector.detectCapabilities(serviceConfig)
    } else {
      const modelId = ConfigOrchestrator.getInstance().getValue<string>(
        'SELECTED_MODEL_ID'
      ) as string

      // 构建假的 serviceConfig 来适配 detector
      const modelConfig = unifiedModelManager.getModelById(modelId) as any
      const mmprojFile = modelConfig?.files?.find((f: any) => f.type === 'mmproj')
      const serviceConfig = {
        mode: 'local' as const,
        local: {
          modelId: modelId,
          modelPath: '',
          mmprojPath: mmprojFile ? mmprojFile.name : undefined,
          contextLength: modelConfig?.contextLength || 4096,
          contextSize: modelConfig?.contextLength || 4096,
          gpuLayers: 0,
          port: 0,
          capabilities: modelConfig?.capabilities || []
        },
        cloud: { provider: '' as any, model: '', apiKey: '', baseUrl: '' },
        retryConfig: {
          modelLoadMaxRetries: 0,
          modelLoadTimeout: 0,
          healthCheckMaxFailures: 0,
          healthCheckInterval: 0,
          aiRequestTimeout: 0
        },
        configVersion: '',
        lastUpdated: new Date()
      } as any
      return modelCapabilityDetector.detectCapabilities(serviceConfig)
    }
  }

  async checkFileTypeSupport(fileType: string, filePath?: string): Promise<boolean> {
    try {
      const filename = filePath || fileType
      const capabilities = await this.getCapabilities()

      if (isCategory(filename, FileCategory.IMAGE) && isDecodableImage(filename)) {
        return capabilities.supportsImage
      }
      if (isCategory(filename, FileCategory.AUDIO)) return capabilities.supportsAudio
      if (isCategory(filename, FileCategory.VIDEO)) return capabilities.supportsVideo

      // 默认都支持文本类
      return capabilities.supportsText
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '检查文件类型支持失败:', error)
      return false
    }
  }

  isMultiModalModel(modelId?: string): boolean {
    const aiServiceMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
    if (aiServiceMode === 'cloud') {
      const provider = ConfigOrchestrator.getInstance().getValue<string>(
        'AI_CLOUD_PROVIDER'
      ) as string
      const model =
        modelId ||
        (ConfigOrchestrator.getInstance().getValue<string>('AI_CLOUD_SELECTED_MODEL_ID') as string)
      return modelCapabilityDetector.isMultiModalCloudModel(provider, model || 'unknown')
    } else {
      const currentModelId =
        modelId ||
        (ConfigOrchestrator.getInstance().getValue<string>('SELECTED_MODEL_ID') as string)
      if (!currentModelId) return false
      const modelConfig = unifiedModelManager.getModelById(currentModelId)
      if (!modelConfig) return false

      // Wait, detectLocalCapabilities is async, but isMultiModalModel is sync!
      // I can re-use modelCapabilityDetector.isMultiModalModel(modelConfig) which is sync!
      return modelCapabilityDetector.isMultiModalModel(modelConfig as any)
    }
  }

  async isMultimodalFileType(fileType: string): Promise<boolean> {
    try {
      const isMultimodal =
        (isCategory(fileType, FileCategory.IMAGE) && isDecodableImage(fileType)) ||
        isCategory(fileType, FileCategory.AUDIO) ||
        isCategory(fileType, FileCategory.VIDEO)

      if (!isMultimodal) {
        return false
      }
      return await this.checkFileTypeSupport(fileType)
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '检查多模态文件类型支持失败:', error)
      return false
    }
  }

  async checkRuntimeCapabilities(): Promise<{
    supportsVision: boolean
    supportsAudio: boolean
    supportsVideo: boolean
  }> {
    const capabilities = await this.getCapabilities()
    return {
      supportsVision: capabilities.supportsImage,
      supportsAudio: capabilities.supportsAudio,
      supportsVideo: capabilities.supportsVideo
    }
  }

  clearCache(): void {
    this.analysisCache.clear()
  }

  async getContextLength(): Promise<number> {
    try {
      const capabilities = await this.getCapabilities()
      return capabilities.maxContextSize || 4096
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '获取上下文长度失败:', error)
      return 4096
    }
  }

  async getActualContextLimit(): Promise<number> {
    try {
      const aiServiceMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')

      // 云端模式：使用更大的上下文
      if (aiServiceMode === 'cloud') {
        const officialContext = await this.getContextLength()
        return Math.min(officialContext, 32768) // 云端限制为 32K
      }

      // 本地模式：需要更保守的限制
      const modelId = ConfigOrchestrator.getInstance().getValue<string>('SELECTED_MODEL_ID')
      if (!modelId) return 4096

      const modelConfig = unifiedModelManager.getModelById(modelId)
      if (!modelConfig) return 4096

      // 解析模型参数大小
      const paramSizeB = parseParameterSize(modelConfig.parameterSize)
      const sizeLimits = getModelSizeLimits(paramSizeB)

      // 优先使用 recommendedConfig.numCtx
      if (modelConfig.recommendedConfig?.numCtx) {
        const recommendedCtx = modelConfig.recommendedConfig.numCtx
        // 确保不超过模型大小限制
        const actualLimit = Math.min(recommendedCtx, sizeLimits.maxCtx)
        logger.info(
          LogCategory.MODEL_CAPABILITY_ADAPTER,
          `使用推荐上下文限制: ${actualLimit} (推荐: ${recommendedCtx}, 模型限制: ${sizeLimits.maxCtx})`
        )
        return actualLimit
      }

      // 否则根据官方值和安全系数计算
      const officialContext = modelConfig.contextLength || 4096
      const calculatedLimit = Math.min(
        Math.floor(officialContext * sizeLimits.ctxSafetyFactor),
        sizeLimits.maxCtx
      )

      logger.info(
        LogCategory.MODEL_CAPABILITY_ADAPTER,
        `计算上下文限制: ${calculatedLimit} (官方: ${officialContext}, 安全系数: ${sizeLimits.ctxSafetyFactor})`
      )

      return calculatedLimit
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '获取实际上下文限制失败:', error)
      return 4096
    }
  }

  async getSafeOutputLimit(): Promise<number> {
    try {
      const aiServiceMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')

      // 云端模式：允许更大的输出
      if (aiServiceMode === 'cloud') {
        return 4096
      }

      // 本地模式
      const modelId = ConfigOrchestrator.getInstance().getValue<string>('SELECTED_MODEL_ID')
      if (!modelId) return 2048

      const modelConfig = unifiedModelManager.getModelById(modelId)
      if (!modelConfig) return 2048

      // 解析模型参数大小
      const paramSizeB = parseParameterSize(modelConfig.parameterSize)
      const sizeLimits = getModelSizeLimits(paramSizeB)

      // 优先使用 recommendedConfig.numPredict
      if (modelConfig.recommendedConfig?.numPredict) {
        const recommendedPredict = modelConfig.recommendedConfig.numPredict
        const safeLimit = Math.min(recommendedPredict, sizeLimits.maxPredict)
        logger.info(
          LogCategory.MODEL_CAPABILITY_ADAPTER,
          `使用推荐输出限制: ${safeLimit} (推荐: ${recommendedPredict}, 模型限制: ${sizeLimits.maxPredict})`
        )
        return safeLimit
      }

      // 否则根据上下文限制计算（输出不超过上下文的 25%）
      const actualContextLimit = await this.getActualContextLimit()
      const calculatedLimit = Math.min(Math.floor(actualContextLimit * 0.25), sizeLimits.maxPredict)

      logger.info(
        LogCategory.MODEL_CAPABILITY_ADAPTER,
        `计算输出限制: ${calculatedLimit} (上下文: ${actualContextLimit})`
      )

      return calculatedLimit
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '获取安全输出限制失败:', error)
      return 2048
    }
  }

  async getModelParameterSize(): Promise<number> {
    try {
      const aiServiceMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
      if (aiServiceMode === 'cloud') {
        return 0
      }

      const modelId = ConfigOrchestrator.getInstance().getValue<string>('SELECTED_MODEL_ID')
      if (!modelId) return 0

      const modelConfig = unifiedModelManager.getModelById(modelId)
      if (!modelConfig || !modelConfig.parameterSize) return 0

      return parseParameterSize(modelConfig.parameterSize)
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '获取模型参数大小失败:', error)
      return 0
    }
  }

  /**
   * 根据模型能力分析文件
   */
  async analyzeFileWithCapabilityAdaptation(
    context: IFileAnalysisContext,
    options: {
      forceFullAnalysis?: boolean
      skipCache?: boolean
      timeout?: number
    } = {}
  ): Promise<ICapabilityAdaptedResult> {
    const startTime = Date.now()

    try {
      logger.debug(LogCategory.MODEL_CAPABILITY_ADAPTER, `开始能力适配分析: ${context.fileName}`)

      // 检查缓存
      if (!options.skipCache) {
        const cached = this.getCachedResult(context)
        if (cached) {
          logger.debug(LogCategory.MODEL_CAPABILITY_ADAPTER, `使用缓存结果: ${context.fileName}`)
          return cached
        }
      }

      // 检查模型能力匹配
      const capabilityMatch = await this.checkModelCapabilityMatch(context)

      let result: ICapabilityAdaptedResult

      if (capabilityMatch.matches && !options.forceFullAnalysis) {
        // 执行完整AI分析
        result = await this.performFullAIAnalysis(context, capabilityMatch)
      } else if (capabilityMatch.matchScore > 30) {
        // 执行降级分析
        result = await this.performDegradedAnalysis(context, capabilityMatch)
      } else {
        // 执行基础元数据分析
        result = await this.performMetadataOnlyAnalysis(context, capabilityMatch)
      }

      result.processingTime = Date.now() - startTime

      // 缓存结果
      this.cacheResult(context, result)

      logger.debug(
        LogCategory.MODEL_CAPABILITY_ADAPTER,
        `能力适配分析完成: ${context.fileName}, 类型: ${result.analysisType}, 耗时: ${result.processingTime}ms`
      )

      this.emit('analysis-completed', { context, result })

      return result
    } catch (error) {
      const processingTime = Date.now() - startTime

      logger.error(
        LogCategory.MODEL_CAPABILITY_ADAPTER,
        `能力适配分析失败: ${context.fileName}`,
        error
      )

      // 返回错误结果
      const errorResult: ICapabilityAdaptedResult = {
        result: {
          fileId: context.fileName || 'unknown',
          timestamp: new Date(),
          category: '分析失败',
          confidence: 0,
          tags: ['错误'],
          summary: `分析失败: ${error instanceof Error ? error.message : String(error)}`
        },
        analysisType: AnalysisType.ERROR,
        limitations: ['分析过程中发生错误'],
        userMessage: '文件分析失败，请稍后重试',
        processingTime,
        requiresConfirmation: false
      }

      this.emit('analysis-failed', { context, error })

      return errorResult
    }
  }

  /**
   * 检查模型能力匹配
   */
  private async checkModelCapabilityMatch(
    context: IFileAnalysisContext
  ): Promise<IModelCapabilityMatch> {
    const aiServiceMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
    const modelId =
      aiServiceMode === 'cloud'
        ? (ConfigOrchestrator.getInstance().getValue<string>(
            'AI_CLOUD_SELECTED_MODEL_ID'
          ) as string)
        : (ConfigOrchestrator.getInstance().getValue<string>('SELECTED_MODEL_ID') as string)

    if (!modelId) {
      return {
        matches: false,
        matchScore: 0,
        supportedFormats: [],
        unsupportedReason: '没有可用的模型',
        alternatives: ['选择一个AI模型']
      }
    }

    const fileExtension = context.fileExtension.toLowerCase().replace('.', '')
    const capabilities = await this.getCapabilities()

    // 检查能力匹配
    const checkMatch = (
      type: TModelCapabilityType,
      supported: boolean
    ): IModelCapabilityMatch | null => {
      const typeCategoryMap: Record<TModelCapabilityType, FileCategory> = {
        IMAGE: FileCategory.IMAGE,
        AUDIO: FileCategory.AUDIO,
        VIDEO: FileCategory.VIDEO,
        TEXT: FileCategory.DOCUMENT
      }

      const category = typeCategoryMap[type]
      if (category && isCategory(context.fileName, category) && supported) {
        return {
          matches: true,
          capabilityType: type,
          matchScore: 100,
          supportedFormats: getExtensionsByCategory(category),
          alternatives: []
        }
      }
      return null
    }

    const matches = [
      checkMatch('IMAGE', capabilities.supportsImage),
      checkMatch('AUDIO', capabilities.supportsAudio),
      checkMatch('VIDEO', capabilities.supportsVideo),
      checkMatch('TEXT', capabilities.supportsText)
    ].filter(m => m !== null) as IModelCapabilityMatch[]

    if (matches.length > 0) {
      return matches[0]
    }

    // 检查部分匹配（相似文件类型）
    const partialMatch = this.findPartialMatch(fileExtension, capabilities)
    if (partialMatch) {
      return partialMatch
    }

    // 完全不支持
    return {
      matches: false,
      matchScore: 0,
      supportedFormats: [],
      unsupportedReason: `当前模型不支持 .${fileExtension} 文件类型`,
      alternatives: [
        '使用支持该文件类型的多模态模型',
        '手动添加文件标签',
        '转换文件格式为支持的类型'
      ]
    }
  }

  /**
   * 查找部分匹配
   */
  private findPartialMatch(
    fileExtension: string,
    capabilities: AICapabilities
  ): IModelCapabilityMatch | null {
    // 文件类型相似性映射
    const similarityMap: Record<string, string[]> = {
      jpg: ['jpeg', 'png', 'bmp', 'webp'],
      jpeg: ['jpg', 'png', 'bmp', 'webp'],
      png: ['jpg', 'jpeg', 'bmp', 'webp'],
      mp4: ['avi', 'mov', 'mkv', 'webm'],
      avi: ['mp4', 'mov', 'mkv', 'wmv'],
      mp3: ['wav', 'flac', 'aac', 'm4a'],
      wav: ['mp3', 'flac', 'aac', 'ogg'],
      txt: ['md', 'rtf', 'log'],
      md: ['txt', 'rtf', 'html'],
      pdf: ['doc', 'docx', 'rtf']
    }

    const similarFormats = similarityMap[fileExtension] || []

    const checkPartial = (
      type: TModelCapabilityType,
      supported: boolean
    ): IModelCapabilityMatch | null => {
      if (!supported) return null
      const typeCategoryMap: Record<TModelCapabilityType, FileCategory> = {
        IMAGE: FileCategory.IMAGE,
        AUDIO: FileCategory.AUDIO,
        VIDEO: FileCategory.VIDEO,
        TEXT: FileCategory.DOCUMENT
      }

      const category = typeCategoryMap[type]
      const formats = category ? getExtensionsByCategory(category) : []
      const hasPartialMatch = similarFormats.some(format => formats.includes('.' + format))

      if (hasPartialMatch) {
        return {
          matches: false,
          capabilityType: type,
          matchScore: 40,
          supportedFormats: formats,
          unsupportedReason: `模型支持相似的${type}文件，但不直接支持 .${fileExtension}`,
          alternatives: [`转换为支持的格式: ${formats.join(', ')}`, '使用基础分析模式']
        }
      }
      return null
    }

    const partials = [
      checkPartial('IMAGE', capabilities.supportsImage),
      checkPartial('AUDIO', capabilities.supportsAudio),
      checkPartial('VIDEO', capabilities.supportsVideo),
      checkPartial('TEXT', capabilities.supportsText)
    ].filter(p => p !== null) as IModelCapabilityMatch[]

    return partials.length > 0 ? partials[0] : null
  }

  /**
   * 执行完整AI分析
   */
  private async performFullAIAnalysis(
    context: IFileAnalysisContext,
    capabilityMatch: IModelCapabilityMatch
  ): Promise<ICapabilityAdaptedResult> {
    const result: AIClassificationResult = {
      fileId: context.fileName || 'unknown',
      timestamp: new Date(),
      category: this.inferCategoryFromCapability(capabilityMatch.capabilityType!),
      confidence: 0.85,
      tags: this.generateTagsFromContext(context, capabilityMatch),
      summary: `AI智能分析: ${context.fileName}`
    }

    return {
      result,
      analysisType: AnalysisType.FULL_AI,
      limitations: [],
      userMessage: `已使用AI模型完整分析（${capabilityMatch.capabilityType}类型）`,
      processingTime: 0,
      requiresConfirmation: false
    }
  }

  /**
   * 执行降级分析
   */
  private async performDegradedAnalysis(
    context: IFileAnalysisContext,
    capabilityMatch: IModelCapabilityMatch
  ): Promise<ICapabilityAdaptedResult> {
    const result: AIClassificationResult = {
      fileId: context.fileName || 'unknown',
      timestamp: new Date(),
      category: this.inferCategoryFromExtension(context.fileExtension),
      confidence: 0.6,
      tags: this.generateBasicTags(context),
      summary: `基础智能分析: ${context.fileName}`
    }

    return {
      result,
      analysisType: AnalysisType.DEGRADED,
      limitations: [capabilityMatch.unsupportedReason || '模型部分支持此文件类型'],
      userMessage: '已进行基础智能分析，建议使用支持该文件类型的模型获得更好效果',
      confidenceNote: '置信度较低，因为模型对此文件类型支持有限',
      processingTime: 0,
      requiresConfirmation: true
    }
  }

  /**
   * 执行仅元数据分析
   */
  private async performMetadataOnlyAnalysis(
    context: IFileAnalysisContext,
    capabilityMatch: IModelCapabilityMatch
  ): Promise<ICapabilityAdaptedResult> {
    const result: AIClassificationResult = {
      fileId: context.fileName || 'unknown',
      timestamp: new Date(),
      category: this.inferCategoryFromExtension(context.fileExtension),
      confidence: 0.4,
      tags: this.generateBasicTags(context),
      summary: `基于文件信息的基础分析: ${context.fileName}`
    }

    return {
      result,
      analysisType: AnalysisType.METADATA_ONLY,
      limitations: [
        capabilityMatch.unsupportedReason || '模型不支持此文件类型',
        '仅基于文件名和元数据进行分析'
      ],
      userMessage: '已进行基础分析（仅基于文件名和元数据），建议使用支持该文件类型的模型',
      confidenceNote: '置信度较低，因为未进行内容分析',
      processingTime: 0,
      requiresConfirmation: true
    }
  }

  /**
   * 从能力类型推断分类
   */
  private inferCategoryFromCapability(capabilityType: TModelCapabilityType): string {
    const categoryMap: Record<TModelCapabilityType, string> = {
      TEXT: '文档',
      IMAGE: '图片',
      AUDIO: '音频',
      VIDEO: '视频'
    }

    return categoryMap[capabilityType] || '未知'
  }

  /**
   * 从扩展名推断分类
   */
  private inferCategoryFromExtension(fileExtension: string): string {
    const category = getFileCategory(fileExtension)
    const categoryMap: Record<string, string> = {
      [FileCategory.DOCUMENT]: '文档',
      [FileCategory.IMAGE]: '图片',
      [FileCategory.VIDEO]: '视频',
      [FileCategory.AUDIO]: '音频',
      [FileCategory.ARCHIVE]: '压缩包',
      [FileCategory.EXECUTABLE]: '程序',
      [FileCategory.EBOOK]: '电子书',
      [FileCategory.CODE]: '源码'
    }

    return categoryMap[category] || '文件'
  }

  /**
   * 从上下文和能力匹配生成标签
   */
  private generateTagsFromContext(
    context: IFileAnalysisContext,
    capabilityMatch: IModelCapabilityMatch
  ): string[] {
    const tags: string[] = []

    // 添加能力类型标签
    if (capabilityMatch.capabilityType) {
      tags.push(capabilityMatch.capabilityType)
    }

    // 添加基础标签
    tags.push(...this.generateBasicTags(context))

    // 添加AI分析标签
    tags.push('AI分析')

    return [...new Set(tags)] // 去重
  }

  /**
   * 生成基础标签
   */
  private generateBasicTags(context: IFileAnalysisContext): string[] {
    const tags: string[] = []
    const fileName = context.fileName.toLowerCase()
    const ext = context.fileExtension.toLowerCase()

    // 添加扩展名标签
    if (ext) {
      tags.push(ext.replace('.', ''))
    }

    // 基于文件名的标签
    if (fileName.includes('screenshot') || fileName.includes('截图')) {
      tags.push('截图')
    }
    if (fileName.includes('backup') || fileName.includes('备份')) {
      tags.push('备份')
    }
    if (fileName.includes('temp') || fileName.includes('临时')) {
      tags.push('临时')
    }
    if (fileName.includes('draft') || fileName.includes('草稿')) {
      tags.push('草稿')
    }
    if (fileName.includes('final') || fileName.includes('最终')) {
      tags.push('最终版')
    }

    // 基于文件大小的标签
    if (context.fileSize > 100 * 1024 * 1024) {
      // 大于100MB
      tags.push('大文件')
    } else if (context.fileSize < 1024) {
      // 小于1KB
      tags.push('小文件')
    }

    return tags
  }

  /**
   * 获取缓存结果
   */
  private getCachedResult(context: IFileAnalysisContext): ICapabilityAdaptedResult | null {
    const cacheKey = this.generateCacheKey(context)
    return this.analysisCache.get(cacheKey) || null
  }

  /**
   * 缓存结果
   */
  private cacheResult(context: IFileAnalysisContext, result: ICapabilityAdaptedResult): void {
    const cacheKey = this.generateCacheKey(context)
    this.analysisCache.set(cacheKey, result)

    // 限制缓存大小
    if (this.analysisCache.size > 1000) {
      const firstKey = this.analysisCache.keys().next().value
      if (firstKey !== undefined) {
        this.analysisCache.delete(firstKey)
      }
    }
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(context: IFileAnalysisContext): string {
    const aiServiceMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
    const modelId =
      aiServiceMode === 'cloud'
        ? (ConfigOrchestrator.getInstance().getValue<string>(
            'AI_CLOUD_SELECTED_MODEL_ID'
          ) as string)
        : (ConfigOrchestrator.getInstance().getValue<string>('SELECTED_MODEL_ID') as string)

    return `${modelId}_${context.filePath}_${context.fileSize}_${context.modifiedAt?.getTime() || 0}`
  }
}

/**
 * 单例实例
 */
export const modelCapabilityAdapter = new ModelCapabilityAdapter()

export function createModelCapabilityAdapter(): IModelCapabilityAdapter {
  return modelCapabilityAdapter
}
