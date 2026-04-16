import {
  AICapabilities,
  ExtendedAIServiceConfig,
  ILlamaModelConfig,
  IModelCapability,
  IModelCapabilityInfo,
  TModelCapabilityType,
  TModelQuality,
  TModelPerformance
} from '@yonuc/types';
import { LogCategory, logger } from '@yonuc/shared';
import { getAllLlamaModelConfigs, getLlamaModelConfig } from '../../model';

import { configService } from '../config/config-service';
import { LocalModelConfigFile } from '@yonuc/types/config-types';
import { EventEmitter } from 'events';
import { FileAnalysisRouter } from '../analysis/file-analysis-router';
import { t } from '@app/languages';

/**
 * Model Capability Detector - 检测和管理模型能力信息
 */








/**
 * 文件类型映射接口
 */
export interface IFileTypeMapping {
  /** 文件扩展名 */
  extension: string;
  /** 对应的能力类型 */
  capabilityType: TModelCapabilityType;
  /** MIME类型 */
  mimeType: string;
  /** 是否为主要支持类型 */
  isPrimary: boolean;
  /** 处理复杂度（1-5） */
  complexity: number;
}

/**
 * 能力匹配结果
 */
export interface ICapabilityMatchResult {
  /** 是否支持 */
  supported: boolean;
  /** 匹配的能力 */
  capability?: IModelCapability;
  /** 匹配度评分（0-100） */
  matchScore: number;
  /** 推荐的处理质量 */
  recommendedQuality: TModelQuality;
  /** 限制和建议 */
  limitations: string[];
  /** 性能预估 */
  performanceEstimate: {
    /** 预估处理时间（秒） */
    estimatedTime: number;
    /** 内存使用（MB） */
    memoryUsage: number;
    /** 成功率 */
    successRate: number;
  };
}

/**
 * 模型能力状态
 */
export interface IModelCapabilityStatus {
  /** 模型ID */
  modelId: string;
  /** 是否已加载 */
  isLoaded: boolean;
  /** 当前状态 */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** 支持的能力列表 */
  availableCapabilities: TModelCapabilityType[];
  /** 当前限制 */
  currentLimitations: {
    /** 最大文件大小（MB） */
    maxFileSize: number;
    /** 最大上下文长度 */
    maxContextLength: number;
    /** 并发处理数 */
    maxConcurrency: number;
  };
  /** 性能指标 */
  performanceMetrics: {
    /** 平均处理时间 */
    avgProcessingTime: number;
    /** 内存使用率 */
    memoryUsage: number;
    /** 错误率 */
    errorRate: number;
  };
  /** 最后更新时间 */
  lastUpdated: Date;
}

/**
 * 运行时模态能力
 */
export interface IRuntimeModalityCapabilities {
  /** 是否支持视觉（图像）分析 */
  vision: boolean;
  /** 是否支持音频分析 */
  audio: boolean;
  /** 检测时间 */
  detectedAt: Date;
}

/**
 * 模型能力检测器接口 - 符合设计文档规范
 */
export interface IModelCapabilityDetector {
  // 检测能力（移除缓存时间限制，跟随模型切换刷新）
  detectCapabilities(serviceConfig: ExtendedAIServiceConfig): Promise<AICapabilities>;

  // 获取缓存的能力
  getCachedCapabilities(): AICapabilities | null;

  // 清除缓存（在模型切换时调用）
  clearCache(): void;

  // 测试多模态能力
  testMultiModalCapabilities(serviceConfig: ExtendedAIServiceConfig): Promise<{
    supportsText: boolean;
    supportsImage: boolean;
    supportsAudio: boolean;
    supportsVideo: boolean;
  }>;
}

/**
 * 模型能力检测器
 */
export class ModelCapabilityDetector extends EventEmitter implements IModelCapabilityDetector {
  private static instance: ModelCapabilityDetector;
  private capabilityCache = new Map<string, IModelCapabilityInfo>();
  private statusCache = new Map<string, IModelCapabilityStatus>();
  private fileTypeMappings: IFileTypeMapping[] = [];
  private runtimeCapabilitiesCache: IRuntimeModalityCapabilities | null = null;
  private runtimeCapabilitiesTimestamp: number = 0;
  private _fileAnalysisRouter: FileAnalysisRouter | null = null;
  private cachedCapabilities: AICapabilities | null = null;
  private currentModelId: string | null = null;
  private currentServiceConfig: ExtendedAIServiceConfig | null = null;
  private statusCacheTimeout = 300000; // 5分钟 (原30秒)

  public static getInstance(): ModelCapabilityDetector {
    if (!ModelCapabilityDetector.instance) {
      ModelCapabilityDetector.instance = new ModelCapabilityDetector();
    }
    return ModelCapabilityDetector.instance;
  }

  private constructor() {
    super();
    this.initializeFileTypeMappings();
  }

  /**
   * 获取指定模型的详细能力信息
   * 
   * @param modelId 模型 ID
   * @returns 模型能力信息或 null
   */
  public getModelCapabilityInfo(modelId: string): IModelCapabilityInfo | null {
    // 1. 尝试从缓存中获取
    if (this.capabilityCache.has(modelId)) {
      return this.capabilityCache.get(modelId)!;
    }

    // 2. 尝试从配置服务中获取静态配置
    const modelConfig = configService.getModelConfig(modelId);
    if (modelConfig) {
      const capability: IModelCapabilityInfo = {
        modelId: modelConfig.id,
        supportedFileTypes: {}, // 这里简化处理，动态检测时会填充
        limitations: {
          maxContextLength: modelConfig.contextLength || 4096,
          maxFileSize: 100 // 默认值
        },
        performance: {
          avgProcessingTime: 0,
          memoryUsage: modelConfig.vramRequiredGB * 1024
        }
      };
      
      // 填充支持的文件类型
      modelConfig.capabilities.forEach((cap: IModelCapability) => {
        capability.supportedFileTypes[cap.type] = cap.supportedFormats;
      });
      
      // 存入缓存供下次使用
      this.capabilityCache.set(modelId, capability);
      return capability;
    }

    return null;
  }

  /**
   * 延迟获取 FileAnalysisRouter 实例，避免循环依赖
   */
  private get fileAnalysisRouter(): FileAnalysisRouter {
    if (!this._fileAnalysisRouter) {
      this._fileAnalysisRouter = FileAnalysisRouter.getInstance();
    }
    return this._fileAnalysisRouter;
  }

  /**
   * 初始化文件类型映射
   */
  private initializeFileTypeMappings(): void {
    this.fileTypeMappings = [
      // 文本文件
      { extension: 'txt', capabilityType: 'TEXT', mimeType: 'text/plain', isPrimary: true, complexity: 1 },
      { extension: 'md', capabilityType: 'TEXT', mimeType: 'text/markdown', isPrimary: true, complexity: 2 },
      { extension: 'pdf', capabilityType: 'TEXT', mimeType: 'application/pdf', isPrimary: true, complexity: 3 },
      { extension: 'doc', capabilityType: 'TEXT', mimeType: 'application/msword', isPrimary: true, complexity: 3 },
      { extension: 'docx', capabilityType: 'TEXT', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', isPrimary: true, complexity: 3 },
      { extension: 'rtf', capabilityType: 'TEXT', mimeType: 'application/rtf', isPrimary: false, complexity: 2 },
      { extension: 'html', capabilityType: 'TEXT', mimeType: 'text/html', isPrimary: false, complexity: 2 },
      { extension: 'xml', capabilityType: 'TEXT', mimeType: 'text/xml', isPrimary: false, complexity: 2 },
      { extension: 'json', capabilityType: 'TEXT', mimeType: 'application/json', isPrimary: false, complexity: 2 },

      // 图像文件
      { extension: 'jpg', capabilityType: 'IMAGE', mimeType: 'image/jpeg', isPrimary: true, complexity: 2 },
      { extension: 'jpeg', capabilityType: 'IMAGE', mimeType: 'image/jpeg', isPrimary: true, complexity: 2 },
      { extension: 'jpe', capabilityType: 'IMAGE', mimeType: 'image/jpeg', isPrimary: true, complexity: 2 },
      { extension: 'png', capabilityType: 'IMAGE', mimeType: 'image/png', isPrimary: true, complexity: 2 },
      { extension: 'bmp', capabilityType: 'IMAGE', mimeType: 'image/bmp', isPrimary: true, complexity: 1 },
      { extension: 'webp', capabilityType: 'IMAGE', mimeType: 'image/webp', isPrimary: true, complexity: 2 },
      { extension: 'gif', capabilityType: 'IMAGE', mimeType: 'image/gif', isPrimary: true, complexity: 2 },
      { extension: 'svg', capabilityType: 'IMAGE', mimeType: 'image/svg+xml', isPrimary: false, complexity: 3 },
      { extension: 'tiff', capabilityType: 'IMAGE', mimeType: 'image/tiff', isPrimary: true, complexity: 2 },
      { extension: 'tif', capabilityType: 'IMAGE', mimeType: 'image/tiff', isPrimary: true, complexity: 2 },
      { extension: 'heic', capabilityType: 'IMAGE', mimeType: 'image/heic', isPrimary: true, complexity: 2 },

      // 音频文件
      { extension: 'mp3', capabilityType: 'AUDIO', mimeType: 'audio/mpeg', isPrimary: true, complexity: 3 },
      { extension: 'wav', capabilityType: 'AUDIO', mimeType: 'audio/wav', isPrimary: true, complexity: 2 },
      { extension: 'flac', capabilityType: 'AUDIO', mimeType: 'audio/flac', isPrimary: true, complexity: 3 },
      { extension: 'aac', capabilityType: 'AUDIO', mimeType: 'audio/aac', isPrimary: true, complexity: 3 },
      { extension: 'ogg', capabilityType: 'AUDIO', mimeType: 'audio/ogg', isPrimary: false, complexity: 3 },
      { extension: 'm4a', capabilityType: 'AUDIO', mimeType: 'audio/mp4', isPrimary: false, complexity: 3 },

      // 视频文件
      { extension: 'mp4', capabilityType: 'VIDEO', mimeType: 'video/mp4', isPrimary: true, complexity: 4 },
      { extension: 'avi', capabilityType: 'VIDEO', mimeType: 'video/x-msvideo', isPrimary: true, complexity: 4 },
      { extension: 'mov', capabilityType: 'VIDEO', mimeType: 'video/quicktime', isPrimary: true, complexity: 4 },
      { extension: 'mkv', capabilityType: 'VIDEO', mimeType: 'video/x-matroska', isPrimary: true, complexity: 4 },
      { extension: 'flv', capabilityType: 'VIDEO', mimeType: 'video/x-flv', isPrimary: true, complexity: 4 },
      { extension: 'webm', capabilityType: 'VIDEO', mimeType: 'video/webm', isPrimary: false, complexity: 4 },
      { extension: 'wmv', capabilityType: 'VIDEO', mimeType: 'video/x-ms-wmv', isPrimary: true, complexity: 4 }
    ];
  }

  /**
   * 检测能力（符合新接口规范）
   * 移除时间限制，跟随模型切换刷新缓存
   */
  async detectCapabilities(serviceConfig: ExtendedAIServiceConfig): Promise<AICapabilities> {
    const configKey = this.getConfigKey(serviceConfig);

    // 检查是否为相同配置，如果是则返回缓存
    if (this.cachedCapabilities && this.isSameConfig(serviceConfig)) {
      logger.debug(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 使用缓存的能力信息: ${configKey}`);
      return this.cachedCapabilities;
    }

    logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 开始检测服务能力: ${configKey}`);

    this.clearCache();
    this.currentServiceConfig = serviceConfig;
    this.currentModelId = (serviceConfig.mode === 'local' ? serviceConfig.local.modelId : serviceConfig.cloud.model) ?? null;

    let capabilities: AICapabilities;

    if (serviceConfig.mode === 'local') {
      capabilities = await this.detectLocalCapabilities(serviceConfig);
    } else {
      capabilities = await this.detectCloudCapabilities(serviceConfig);
    }

    // 缓存结果
    this.cachedCapabilities = capabilities;
    logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 能力检测完成并缓存: ${configKey}`, capabilities);

    return capabilities;
  }

  /**
   * 获取缓存的能力
   */
  getCachedCapabilities(): AICapabilities | null {
    return this.cachedCapabilities;
  }

  /**
   * 清除缓存（在模型切换时调用）
   */
  clearCache(): void {
    logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 清理能力缓存');
    this.cachedCapabilities = null;
    this.currentModelId = null;
    this.currentServiceConfig = null;
    this.runtimeCapabilitiesCache = null;
  }

  /**
   * 测试多模态能力
   */
  async testMultiModalCapabilities(serviceConfig: ExtendedAIServiceConfig): Promise<{
    supportsText: boolean;
    supportsImage: boolean;
    supportsAudio: boolean;
    supportsVideo: boolean;
  }> {
    logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 开始测试多模态能力');

    if (serviceConfig.mode === 'local') {
      return await this.testLocalMultiModalCapabilities(serviceConfig);
    } else {
      return await this.testCloudMultiModalCapabilities(serviceConfig);
    }
  }

  /**
   * 获取模型配置（从配置中心获取，不支持生成的虚拟配置）
   */
  private async getModelConfig(modelId: string): Promise<ILlamaModelConfig | null> {
    return configService.getModelConfig(modelId);
  }

  /**
   * 检测模型能力（保持向后兼容）
   */
  async detectModelCapabilities(modelId: string): Promise<IModelCapabilityInfo> {
    // 检查缓存（移除时间验证，只检查模型ID）
    const cached = this.capabilityCache.get(modelId);
    if (cached && this.currentModelId === modelId) {
      logger.debug(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 使用缓存的模型能力: ${modelId}`);
      return cached;
    }

    logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 开始检测模型能力: ${modelId}`);

    const modelConfig = await this.getModelConfig(modelId);
    if (!modelConfig) {
      // 再次尝试通过常规 getLlamaModelConfig 获取（兼容旧逻辑，但对于 Ollama 可能无效）
      const fallbackConfig = getLlamaModelConfig(modelId);
      if (fallbackConfig) {
         return await this.analyzeModelCapabilities(fallbackConfig);
      }
      throw new Error(`模型配置不存在: ${modelId} (Platform: ${this.currentServiceConfig?.platform})`);
    }

    const capabilityInfo = await this.analyzeModelCapabilities(modelConfig);

    // 缓存结果（移除时间戳）
    this.capabilityCache.set(modelId, capabilityInfo);
    logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 模型能力检测完成并缓存: ${modelId}`);

    return capabilityInfo;
  }

  /**
   * 检测本地服务能力
   */
  private async detectLocalCapabilities(serviceConfig: ExtendedAIServiceConfig): Promise<AICapabilities> {
    const modelId = serviceConfig.local.modelId || '';
    const modelConfig = await this.getModelConfig(modelId);

    if (!modelConfig) {
      throw new Error(`本地模型配置不存在: ${modelId}`);
    }

    // 检测多模态能力
    const multiModalCapabilities = await this.testLocalMultiModalCapabilities(serviceConfig);

    return {
      supportsText: multiModalCapabilities.supportsText,
      supportsImage: multiModalCapabilities.supportsImage,
      supportsAudio: multiModalCapabilities.supportsAudio,
      supportsVideo: multiModalCapabilities.supportsVideo,
      maxContextSize: serviceConfig.local.contextSize || modelConfig.contextLength || 32768,
      modelName: modelConfig.name || modelId,
      provider: 'local'
    };
  }

  /**
   * 检测云端服务能力
   */
  private async detectCloudCapabilities(serviceConfig: ExtendedAIServiceConfig): Promise<AICapabilities> {
    const provider = serviceConfig.cloud.provider;
    const model = serviceConfig.cloud.model || '';

    // 检测多模态能力
    const multiModalCapabilities = await this.testCloudMultiModalCapabilities(serviceConfig);

    // 根据提供商和模型确定上下文大小
    const maxContextSize = this.getCloudModelContextSize(provider, model);

    return {
      supportsText: multiModalCapabilities.supportsText,
      supportsImage: multiModalCapabilities.supportsImage,
      supportsAudio: multiModalCapabilities.supportsAudio,
      supportsVideo: multiModalCapabilities.supportsVideo,
      maxContextSize,
      modelName: model,
      provider
    };
  }

  /**
   * 测试本地多模态能力
   */
  private async testLocalMultiModalCapabilities(serviceConfig: ExtendedAIServiceConfig): Promise<{
    supportsText: boolean;
    supportsImage: boolean;
    supportsAudio: boolean;
    supportsVideo: boolean;
  }> {
    const modelId = serviceConfig.local.modelId || '';
    const modelConfig = await this.getModelConfig(modelId);

    if (!modelConfig) {
      return {
        supportsText: false,
        supportsImage: false,
        supportsAudio: false,
        supportsVideo: false
      };
    }

    // 文本能力：所有模型都支持
    const supportsText = true;
    let supportsImage = false;
    let supportsAudio = false;

    // 检查是否为 Ollama 平台
    if (serviceConfig.platform === 'ollama') {
      // Ollama 平台下，直接根据模型配置的 capabilities 数组判断
      // 只要配置中包含对应能力，Ollama 就会自动处理（无需检查运行时 mmproj）
      supportsImage = modelConfig.capabilities.some(c => c.type === 'IMAGE') || modelConfig.isMultiModal;
      supportsAudio = modelConfig.capabilities.some(c => c.type === 'AUDIO');
      
      logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] Ollama模型能力检测: ${modelId}`, {
        supportsImage,
        supportsAudio,
        capabilities: modelConfig.capabilities.map(c => c.type)
      });
    } else {
      // llama.cpp 平台：检查运行时多模态能力 (mmproj 是否加载)
      const runtimeCapabilities = await this.checkRuntimeCapabilities();

      // 图像能力：需要多模态模型且运行时支持
      supportsImage = modelConfig.isMultiModal && runtimeCapabilities.vision;

      // 音频能力：需要多模态模型且运行时支持
      supportsAudio = modelConfig.isMultiModal && runtimeCapabilities.audio;
    }

    // 视频能力：目前通过图像能力推断（视频帧提取）
    const supportsVideo = supportsImage;

    logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 本地模型多模态能力检测完成: ${modelId}`, {
      supportsText,
      supportsImage,
      supportsAudio,
      supportsVideo,
      isMultiModal: modelConfig.isMultiModal,
      platform: serviceConfig.platform
    });

    return {
      supportsText,
      supportsImage,
      supportsAudio,
      supportsVideo
    };
  }

  /**
   * 测试云端多模态能力
   */
  private async testCloudMultiModalCapabilities(serviceConfig: ExtendedAIServiceConfig): Promise<{
    supportsText: boolean;
    supportsImage: boolean;
    supportsAudio: boolean;
    supportsVideo: boolean;
  }> {
    const provider = serviceConfig.cloud.provider;
    const model = serviceConfig.cloud.model;

    // 根据提供商和模型确定能力
    const capabilities = this.getCloudProviderCapabilities(provider, model);

    logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 云端服务多模态能力检测完成: ${provider}/${model}`, capabilities);

    return capabilities;
  }


  /**
   * 获取云端提供商能力
   */
  private getCloudProviderCapabilities(provider: string, model: string): {
    supportsText: boolean;
    supportsImage: boolean;
    supportsAudio: boolean;
    supportsVideo: boolean;
  } {
    // 所有云端服务都支持文本
    const supportsText = true;

    // Vision models regex list
    const visionAllowedModelsRegex = [
      /llava/i,
      /moondream/i,
      /minicpm/i,
      /gemini-1\.5/i,
      /gemini-2\.0/i,
      /gemini-2\.5/i,
      /gemini-3-(?:flash|pro)(?:-preview)?/i,
      /gemini-(?:flash|pro|flash-lite)-latest/i,
      /gemini-exp/i,
      /claude-3/i,
      /claude-haiku-4/i,
      /claude-sonnet-4/i,
      /claude-opus-4/i,
      /vision/i,
      /glm-4(?:\.\d+)?v(?:-[\w-]+)?/i,
      /qwen-vl/i,
      /qwen2-vl/i,
      /qwen2\.5-vl/i,
      /qwen3-vl/i,
      /qwen2\.5-omni/i,
      /qwen3-omni(?:-[\w-]+)?/i,
      /qvq/i,
      /internvl2/i,
      /grok-vision-beta/i,
      /grok-4(?:-[\w-]+)?/i,
      /pixtral/i,
      /gpt-4(?:-[\w-]+)/i,
      /gpt-4\.1(?:-[\w-]+)?/i,
      /gpt-4o(?:-[\w-]+)?/i,
      /gpt-4\.5(?:-[\w-]+)/i,
      /gpt-5(?:-[\w-]+)?/i,
      /chatgpt-4o(?:-[\w-]+)?/i,
      /o1(?:-[\w-]+)?/i,
      /o3(?:-[\w-]+)?/i,
      /o4(?:-[\w-]+)?/i,
      /deepseek-vl(?:[\w-]+)?/i,
      /kimi-latest/i,
      /gemma-3(?:-[\w-]+)/i,
      /doubao-seed-1[.-]6(?:-[\w-]+)?/i,
      /kimi-thinking-preview/i,
      /gemma3(?:[-:\w]+)?/i,
      /kimi-vl-a3b-thinking(?:-[\w-]+)?/i,
      /llama-guard-4(?:-[\w-]+)?/i,
      /llama-4(?:-[\w-]+)?/i,
      /step-1o(?:.*vision)?/i,
      /step-1v(?:-[\w-]+)?/i,
      /qwen-omni(?:-[\w-]+)?/i,
      /mistral-large-(?:2512|latest)/i,
      /mistral-medium-(?:2508|latest)/i,
      /mistral-small-(?:2506|latest)/i
    ];

    const visionExcludedModelsRegex = [
      /gpt-4-\d+-preview/i,
      /gpt-4-turbo-preview/i,
      /gpt-4-32k/i,
      /gpt-4-\d+/i,
      /o1-mini/i,
      /o3-mini/i,
      /o1-preview/i,
      /idp-ai\/marco-o1/i
    ];

    let supportsImage = false;

    // Check against allowed list
    const isExplicitlyAllowed = visionAllowedModelsRegex.some(regex => regex.test(model));

    // Check against excluded list
    const isExplicitlyExcluded = visionExcludedModelsRegex.some(regex => regex.test(model));

    if (isExplicitlyAllowed && !isExplicitlyExcluded) {
      supportsImage = true;
    }

    // Provider specific overrides/checks can go here if needed, 
    // but the regex list is quite comprehensive.
    // For now, we trust the regex list primarily.

    return {
      supportsText,
      supportsImage,
      supportsAudio: false, // Default to false for now unless verified
      supportsVideo: supportsImage // Usually implies video frame support
    };
  }

  /**
   * 获取云端模型上下文大小
   */
  private getCloudModelContextSize(provider: string, model: string): number {
    switch (provider) {
      case 'openai':
        if (model.includes('gpt-4')) return 128000;
        if (model.includes('gpt-3.5')) return 16385;
        return 8192;

      case 'anthropic':
        if (model.includes('claude-3')) return 200000;
        return 100000;

      case 'gemini':
        if (model.includes('pro')) return 1000000;
        return 32768;

      case 'deepseek':
        return 32768;

      case 'alibaba':
        if (model.includes('qwen')) return 32768;
        return 8192;

      default:
        return 8192;
    }
  }

  /**
   * 获取配置键
   */
  private getConfigKey(serviceConfig: ExtendedAIServiceConfig): string {
    if (serviceConfig.mode === 'local') {
      return `local:${serviceConfig.local.modelId}`;
    } else {
      return `cloud:${serviceConfig.cloud.provider}:${serviceConfig.cloud.model}`;
    }
  }

  /**
   * 检查是否为相同配置
   */
  private isSameConfig(serviceConfig: ExtendedAIServiceConfig): boolean {
    if (!this.currentServiceConfig) return false;

    if (serviceConfig.mode !== this.currentServiceConfig.mode) return false;

    if (serviceConfig.mode === 'local') {
      return serviceConfig.local.modelId === this.currentServiceConfig.local.modelId &&
        serviceConfig.local.mmprojPath === this.currentServiceConfig.local.mmprojPath;
    } else {
      return serviceConfig.cloud.provider === this.currentServiceConfig.cloud.provider &&
        serviceConfig.cloud.model === this.currentServiceConfig.cloud.model;
    }
  }

  /**
   * 检查运行时模态能力
   */
  async checkRuntimeCapabilities(): Promise<IRuntimeModalityCapabilities> {
    const now = Date.now();
    const cacheAge = now - this.runtimeCapabilitiesTimestamp;

    // 检查缓存且未过期 (5分钟)
    if (this.runtimeCapabilitiesCache && cacheAge < 300000) {
      logger.debug(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 使用缓存的运行时能力 (缓存年龄: ${Math.round(cacheAge / 1000)}秒)`);
      return this.runtimeCapabilitiesCache;
    }

    try {
      // 动态导入 llama-server-service 以避免循环依赖
      const { llamaServerService } = await import('@yonuc/electron-llamaIndex-service');
      // 检查服务是否运行
      const status = llamaServerService.getStatus();

      if (status !== 'running') {
        logger.warn(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] llama-server 未运行，无法检测运行时能力');
        return {
          vision: false,
          audio: false,
          detectedAt: new Date()
        };
      }

      // 首先检查服务器配置中是否有 mmproj 文件
      // 这是最可靠的方法来判断是否支持多模态
      const serverConfig = llamaServerService.getCurrentConfig();
      let visionSupported = false;

      if (serverConfig?.mmprojPath) {
        logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 检测到多模态投影文件:', serverConfig.mmprojPath);
        visionSupported = true;
      }

      // 尝试从模型信息 API 获取能力信息（作为后备或补充）
      try {
        const models = await llamaServerService.getModels();

        if (models.length > 0) {
          const model = models[0];

          // 如果 API 返回了 modalities 信息，使用它
          if (model.modalities) {
            if (model.modalities.vision !== undefined) {
              visionSupported = model.modalities.vision;
              logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 从模型信息 API 获取视觉能力:', model.modalities.vision);
            }
            if (model.modalities.audio !== undefined) {
              logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 从模型信息 API 获取音频能力:', model.modalities.audio);
            }
          } else {
            logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 模型信息 API 未返回 modalities 字段，使用配置检测结果 (vision:', visionSupported, ')');
          }
        } else {
          logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 模型信息 API 返回空列表，使用配置检测结果 (vision:', visionSupported, ')');
        }
      } catch (apiError) {
        logger.warn(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 获取模型信息失败，使用配置检测结果:', apiError);
      }

      // TODO 提取配置，开启音频和视频
      const capabilities: IRuntimeModalityCapabilities = {
        vision: visionSupported,
        audio: true, // 目前音频支持较少，保持默认为 false
        detectedAt: new Date()
      };

      // 缓存结果
      this.runtimeCapabilitiesCache = capabilities;
      this.runtimeCapabilitiesTimestamp = Date.now();

      logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 运行时能力检测完成:', capabilities);
      return capabilities;
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 检测运行时能力失败:', error);
      return {
        vision: false,
        audio: false,
        detectedAt: new Date()
      };
    }
  }


  /**
   * 检查文件类型支持
   */
  async checkFileTypeSupport(modelId: string, fileExtension: string): Promise<ICapabilityMatchResult> {
    const fileMapping = this.getFileTypeMapping(fileExtension);
    if (!fileMapping) {
      return {
        supported: false,
        matchScore: 0,
        recommendedQuality: 'low',
        limitations: [t('不支持的文件类型')],
        performanceEstimate: { estimatedTime: 0, memoryUsage: 0, successRate: 0 }
      };
    }

    let capabilityInfo: IModelCapabilityInfo | null = null;
    let isCloudModel = false;
    let cloudCapabilities: AICapabilities | null = null;

    // 1.5 检查配置是否过时（模型ID不匹配）或为空
    // 如果请求的模型ID与当前缓存配置的模型ID不一致，可能是发生了模型切换，需要尝试刷新配置
    const cachedModelId = this.currentServiceConfig 
      ? (this.currentServiceConfig.mode === 'local' ? this.currentServiceConfig.local.modelId : this.currentServiceConfig.cloud.model)
      : null;

    if (!this.currentServiceConfig || cachedModelId !== modelId) {
      try {
        const freshConfig = await configService.getAIConfig() as ExtendedAIServiceConfig;
        const freshModelId = freshConfig.mode === 'local' ? freshConfig.local.modelId : freshConfig.cloud.model;
        
        // 如果从 ConfigService 获取的最新配置与请求的模型ID一致，说明是当前活动模型，更新缓存
        if (freshModelId === modelId) {
          logger.debug(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 更新过时的服务配置缓存: ${modelId}`);
          // 更新配置前先清理旧缓存，防止后续 detectCapabilities 错误地返回旧的 cachedCapabilities
          this.clearCache();
          this.currentServiceConfig = freshConfig;
          this.currentModelId = modelId;
        } else if (!this.currentServiceConfig) {
          // 如果当前没有缓存，直接使用获取到的配置
          this.currentServiceConfig = freshConfig;
          this.currentModelId = freshModelId || null;
        }
      } catch (e) {
        logger.warn(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] Failed to restore config from orchestrator:`, e);
      }
    }

    if (this.currentServiceConfig?.mode === 'cloud') {
      isCloudModel = true;

      // Use the generic cloud capability detector with the REQUESTED modelId
      // Assuming the provider is the same as the current active one (safe assumption in most flows)
      const provider = this.currentServiceConfig.cloud?.provider || 'openai';

      // Directly resolve capabilities for the requested model ID
      const rawCapabilities = this.getCloudProviderCapabilities(provider, modelId);

      cloudCapabilities = {
        ...rawCapabilities,
        maxContextSize: this.getCloudModelContextSize(provider, modelId),
        modelName: modelId,
        provider: provider
      };

    } else {
      capabilityInfo = await this.detectModelCapabilities(modelId);
    }

    // --- 云端模型处理逻辑 ---
    if (isCloudModel && cloudCapabilities) {
      let isSupported = false;

      if (fileMapping.capabilityType === 'TEXT') {
        isSupported = cloudCapabilities.supportsText;
      } else if (fileMapping.capabilityType === 'IMAGE') {
        isSupported = cloudCapabilities.supportsImage;
      } else if (fileMapping.capabilityType === 'AUDIO') {
        isSupported = cloudCapabilities.supportsAudio;
      } else if (fileMapping.capabilityType === 'VIDEO') {
        isSupported = cloudCapabilities.supportsVideo;
      }

      if (!isSupported) {
        return {
          supported: false,
          matchScore: 0,
          recommendedQuality: 'low',
          limitations: [t('当前云端模型{modelId}不支持', { modelId })],
          performanceEstimate: { estimatedTime: 0, memoryUsage: 0, successRate: 0 }
        };
      }

      // 云端模型通常性能较好，给一个默认的高评分
      return {
        supported: true,
        matchScore: 90,
        recommendedQuality: 'high',
        limitations: [],
        performanceEstimate: {
          estimatedTime: 2, // 假设2秒
          memoryUsage: 0,   // 云端不消耗本地显存
          successRate: 0.95
        }
      };
    }

    // --- 本地模型处理逻辑 (capabilityInfo 必定存在) ---
    if (!capabilityInfo) {
      // Should not happen given logic above
      throw new Error(`无法获取模型能力信息: ${modelId}`);
    }

    const supportedFormats = capabilityInfo.supportedFileTypes[fileMapping.capabilityType];
    const cleanExt = fileExtension.toLowerCase().replace(/^\./, '')
    const isSupported = supportedFormats?.includes(cleanExt) || false;

    if (!isSupported) {
      return {
        supported: false,
        matchScore: 0,
        recommendedQuality: 'low',
        limitations: [t('模型不支持 {type} 类型文件', { type: fileMapping.capabilityType })],
        performanceEstimate: {
          estimatedTime: 0,
          memoryUsage: 0,
          successRate: 0
        }
      };
    }

    // 对于本地多模态文件（图片、音频），检查运行时能力
    if (fileMapping.capabilityType === 'IMAGE' || fileMapping.capabilityType === 'AUDIO') {
      // 如果是 Ollama 平台，跳过运行时能力检查（因为 Ollama 自动处理）
      const isOllama = this.currentServiceConfig?.platform === 'ollama';

      if (!isOllama) {
        const runtimeCapabilities = await this.checkRuntimeCapabilities();

        // 检查是否真的支持该模态
        if (fileMapping.capabilityType === 'IMAGE' && !runtimeCapabilities.vision) {
          return {
            supported: false,
            matchScore: 0,
            recommendedQuality: 'low',
            limitations: [t('当前模型运行时不支持图像分析'), t('需要加载带有多模态投影器的模型')],
            performanceEstimate: {
              estimatedTime: 0,
              memoryUsage: 0,
              successRate: 0
            }
          };
        }

        if (fileMapping.capabilityType === 'AUDIO' && !runtimeCapabilities.audio) {
          return {
            supported: false,
            matchScore: 0,
            recommendedQuality: 'low',
            limitations: [t('当前模型运行时不支持音频分析'), t('需要加载支持音频的多模态模型')],
            performanceEstimate: {
              estimatedTime: 0,
              memoryUsage: 0,
              successRate: 0
            }
          };
        }
      }
    }

    // 计算匹配度和性能预估 (仅针对本地模型)
    const modelConfig = await this.getModelConfig(modelId);
    if (!modelConfig) {
      return {
        supported: false,
        matchScore: 0,
        recommendedQuality: 'low',
        limitations: [t('模型配置不存在')],
        performanceEstimate: {
          estimatedTime: 0,
          memoryUsage: 0,
          successRate: 0
        }
      };
    }

    const capability = modelConfig.capabilities.find((cap: IModelCapability) => cap.type === fileMapping.capabilityType);

    if (!capability) {
      return {
        supported: false,
        matchScore: 0,
        recommendedQuality: 'low',
        limitations: [t('模型配置中未找到对应能力')],
        performanceEstimate: {
          estimatedTime: 0,
          memoryUsage: 0,
          successRate: 0
        }
      };
    }

    const matchScore = this.calculateMatchScore(capability, fileMapping);
    const performanceEstimate = this.estimatePerformance(modelConfig, capability, fileMapping);
    const limitations = this.identifyLimitations(modelConfig, capability, fileMapping);

    return {
      supported: true,
      capability,
      matchScore,
      recommendedQuality: capability.quality,
      limitations,
      performanceEstimate
    };
  }

  /**
   * 获取模型状态
   */
  async getModelStatus(modelId: string): Promise<IModelCapabilityStatus> {
    // 检查缓存
    const cached = this.statusCache.get(modelId);
    if (cached) {
      const cacheAge = Date.now() - cached.lastUpdated.getTime();
      // 使用 5 分钟 (300000ms) 的超时
      if (cacheAge < this.statusCacheTimeout) {
        logger.debug(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 使用缓存的模型状态: ${modelId} (缓存年龄: ${Math.round(cacheAge / 1000)}秒)`);
        return cached;
      } else {
        logger.debug(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 模型状态缓存已过期: ${modelId}`);
        this.statusCache.delete(modelId);
      }
    }

    let modelConfig = getLlamaModelConfig(modelId);
    
    // 如果不是 GGUF 模型，检查是否为 Ollama 模型或云端模型
    if (!modelConfig) {
      // 检查当前服务模式
      if (this.currentServiceConfig?.platform === 'ollama' || modelId === 'llama2-uncensored' || modelId.includes(':')) {
        logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 检测到 Ollama 模型: ${modelId}，生成虚拟配置`);
        
        // 生成 Ollama 模型的虚构配置以通过后续流程
        modelConfig = {
          id: modelId,
          name: modelId,
          company: 'Ollama',
          parameterSize: 'Unknown',
          totalSize: 'Memory Managed',
          totalSizeBytes: 0,
          description: 'Ollama Platform Model',
          format: 'gguf', // Use gguf to satisfy type
          isMultiModal: modelId.toLowerCase().includes('vl') || modelId.toLowerCase().includes('omni'),
          contextLength: 32768,
          capabilities: [
            { type: 'TEXT' as TModelCapabilityType, supportedFormats: ['txt', 'md', 'pdf', 'doc', 'docx'], quality: 'high' as TModelQuality, isPrimary: true }
          ],
          files: [],
          downloadSources: [],
          performance: { speed: 'fast' as TModelPerformance, quality: 'high' as TModelQuality, score: 85 },
          hardwareRequirements: { minMemoryGB: 4, recommendedMemoryGB: 8, gpuAccelerated: true, cpuInstructions: [] },
          vramRequiredGB: 4,
          tags: ['Ollama']
        } as ILlamaModelConfig;

        if (modelConfig.isMultiModal) {
          modelConfig.capabilities.push({
            type: 'IMAGE' as TModelCapabilityType,
            supportedFormats: ['jpg', 'png', 'webp', 'jpeg'],
            quality: 'high' as TModelQuality,
            isPrimary: false
          });
        }
      } else {
        throw new Error(`模型配置不存在: ${modelId}`);
      }
    }

    const status = await this.buildModelStatus(modelConfig!);

    // 缓存结果
    this.statusCache.set(modelId, status);

    return status;
  }

  /**
   * 获取所有支持特定文件类型的模型
   */
  async getModelsByFileType(fileExtension: string): Promise<string[]> {
    const fileMapping = this.getFileTypeMapping(fileExtension);
    if (!fileMapping) return [];

    const allModels = getAllLlamaModelConfigs();
    const supportedModels: string[] = [];

    for (const model of allModels) {
      const hasCapability = model.capabilities.some(cap =>
        cap.type === fileMapping.capabilityType &&
        cap.supportedFormats.includes(fileExtension.toLowerCase())
      );

      if (hasCapability) {
        supportedModels.push(model.id);
      }
    }

    // 按性能评分排序
    return supportedModels.sort((a, b) => {
      const modelA = getLlamaModelConfig(a);
      const modelB = getLlamaModelConfig(b);

      if (!modelA || !modelB) return 0;

      return modelB.performance.score - modelA.performance.score;
    });
  }

  /**
   * 获取模型能力限制
   */
  async getCapabilityLimitations(modelId: string, capabilityType: TModelCapabilityType): Promise<string[]> {
    const modelConfig = getLlamaModelConfig(modelId);
    if (!modelConfig) return [t('模型不存在')];

    const capability = modelConfig.capabilities.find((cap: IModelCapability) => cap.type === capabilityType);
    if (!capability) return [t('模型不支持{}类型', [capabilityType])];

    const limitations: string[] = [];

    // 基于模型大小的限制
    const modelSizeGB = modelConfig.totalSizeBytes / (1024 ** 3);
    if (modelSizeGB < 2) {
      limitations.push(t('小型模型，处理复杂内容可能效果有限'));
    }

    // 基于量化的限制
    if (modelConfig.quantization?.includes('Q2')) {
      limitations.push(t('低精度量化，可能影响输出质量'));
    }

    // 基于能力质量的限制
    if (capability.quality === 'low') {
      limitations.push(t('基础质量处理，适合简单任务'));
    } else if (capability.quality === 'medium') {
      limitations.push(t('中等质量处理，适合一般任务'));
    }

    // 基于硬件要求的限制
    if (modelConfig.hardwareRequirements?.gpuAccelerated && modelConfig.vramRequiredGB > 8) {
      limitations.push(t('需要大显存GPU支持以获得最佳性能'));
    }

    // 多模态特定限制
    if (capabilityType !== 'TEXT' && !modelConfig.isMultiModal) {
      limitations.push(t('非多模态模型，可能不支持此类型文件'));
    }

    return limitations;
  }

  /**
   * 更新模型状态
   */
  async updateModelStatus(modelId: string, status: Partial<IModelCapabilityStatus>): Promise<void> {
    const currentStatus = await this.getModelStatus(modelId);
    const updatedStatus = {
      ...currentStatus,
      ...status,
      lastUpdated: new Date()
    };

    this.statusCache.set(modelId, updatedStatus);

    // 发出状态更新事件
    this.emit('status-updated', { modelId, status: updatedStatus });
  }

  /**
   * 清理所有缓存（保持向后兼容）
   */
  clearAllCache(): void {
    logger.info(LogCategory.MODEL_CAPABILITY_DETECTOR, '[模型能力检测器] 清理所有缓存');
    this.capabilityCache.clear();
    this.statusCache.clear();
    this.runtimeCapabilitiesCache = null;
    this.cachedCapabilities = null;
    this.currentModelId = null;
    this.currentServiceConfig = null;
  }

  /**
   * 清理过期缓存（仅清理状态缓存，能力缓存跟随模型切换）
   */
  clearExpiredCache(): void {
    const now = Date.now();
    let clearedCount = 0;

    // 只清理过期的状态缓存（保留30秒时间限制）
    for (const [modelId, status] of this.statusCache.entries()) {
      if (now - status.lastUpdated.getTime() > this.statusCacheTimeout) {
        this.statusCache.delete(modelId);
        clearedCount++;
      }
    }

    if (clearedCount > 0) {
      logger.debug(LogCategory.MODEL_CAPABILITY_DETECTOR, `[模型能力检测器] 清理了 ${clearedCount} 个过期状态缓存项`);
    }
  }

  /**
   * 获取文件类型映射
   */
  private getFileTypeMapping(fileExtension: string): IFileTypeMapping | undefined {
    return this.fileTypeMappings.find(mapping =>
      mapping.extension === fileExtension.toLowerCase().replace('.', '')
    );
  }

  /**
   * 分析模型能力
   */
  private async analyzeModelCapabilities(modelConfig: ILlamaModelConfig): Promise<IModelCapabilityInfo> {
    const supportedFileTypes: { [key in TModelCapabilityType]?: string[] } = {};

    // 构建支持的文件类型映射
    modelConfig.capabilities.forEach(capability => {
      const normalizedType = capability.type.toUpperCase() as TModelCapabilityType;
      supportedFileTypes[normalizedType] = capability.supportedFormats;
    });

    // 计算性能指标
    const performance = {
      avgProcessingTime: this.estimateAvgProcessingTime(modelConfig),
      memoryUsage: modelConfig.vramRequiredGB * 1024, // 转换为MB
      gpuUtilization: modelConfig.hardwareRequirements?.gpuAccelerated ?
        this.estimateGpuUtilization(modelConfig) : 0
    };

    // 确定限制
    const limitations = {
      maxFileSize: this.calculateMaxFileSize(modelConfig),
      maxContextLength: modelConfig.contextLength || 32768,
      supportedLanguages: ['zh-CN', 'en-US'] // 默认支持中英文
    };

    return {
      modelId: modelConfig.id,
      supportedFileTypes,
      limitations,
      performance
    };
  }

  /**
   * 构建模型状态
   */
  private async buildModelStatus(modelConfig: ILlamaModelConfig): Promise<IModelCapabilityStatus> {
    return {
      modelId: modelConfig.id,
      isLoaded: false, // 需要从实际运行状态获取
      status: 'idle',
      availableCapabilities: modelConfig.capabilities.map((cap: IModelCapability) => cap.type),
      currentLimitations: {
        maxFileSize: this.calculateMaxFileSize(modelConfig),
        maxContextLength: modelConfig.contextLength || 32768,
        maxConcurrency: this.calculateMaxConcurrency(modelConfig)
      },
      performanceMetrics: {
        avgProcessingTime: this.estimateAvgProcessingTime(modelConfig),
        memoryUsage: modelConfig.vramRequiredGB * 1024,
        errorRate: 0.05 // 默认5%错误率
      },
      lastUpdated: new Date()
    };
  }

  /**
   * 计算匹配度评分
   */
  private calculateMatchScore(capability: IModelCapability, fileMapping: IFileTypeMapping): number {
    let score = 0;

    // 基础支持得分
    if (capability.supportedFormats.includes(fileMapping.extension)) {
      score += 40;
    }

    // 质量匹配得分
    const qualityScore = {
      'low': 10,
      'medium': 20,
      'high': 30,
      'ultra': 40
    }[capability.quality] || 0;
    score += qualityScore;

    // 主要能力得分
    if (capability.isPrimary) {
      score += 10;
    }

    // 复杂度适配得分
    if (fileMapping.complexity <= 2) {
      score += 10; // 简单文件类型
    } else if (fileMapping.complexity <= 3) {
      score += 5; // 中等复杂度
    }

    return Math.min(100, score);
  }

  /**
   * 估算性能
   */
  private estimatePerformance(
    modelConfig: ILlamaModelConfig,
    capability: IModelCapability,
    fileMapping: IFileTypeMapping
  ): ICapabilityMatchResult['performanceEstimate'] {
    // 基础处理时间（秒）
    const baseTime = fileMapping.complexity * 2;

    // 根据模型性能调整
    const speedMultiplier = {
      'very_fast': 0.5,
      'fast': 0.7,
      'medium': 1.0,
      'slow': 1.5
    }[modelConfig.performance.speed] || 1.0;

    const estimatedTime = baseTime * speedMultiplier;

    // 内存使用估算
    const baseMemory = modelConfig.vramRequiredGB * 1024; // MB
    const memoryUsage = baseMemory * (1 + fileMapping.complexity * 0.1);

    // 成功率估算
    const qualitySuccessRate = {
      'low': 0.7,
      'medium': 0.8,
      'high': 0.9,
      'ultra': 0.95
    }[capability.quality] || 0.7;

    return {
      estimatedTime,
      memoryUsage,
      successRate: qualitySuccessRate
    };
  }

  /**
   * 识别限制
   */
  private identifyLimitations(
    modelConfig: ILlamaModelConfig,
    capability: IModelCapability,
    fileMapping: IFileTypeMapping
  ): string[] {
    const limitations: string[] = [];

    // 文件大小限制
    const maxFileSize = this.calculateMaxFileSize(modelConfig);
    if (maxFileSize < 100) {
      limitations.push(t('文件大小限制: {maxFileSize}MB', { maxFileSize: maxFileSize }));
    }

    // 质量限制
    if (capability.quality === 'low') {
      limitations.push(t('处理质量较低，适合简单任务'));
    }

    // 复杂度限制
    if (fileMapping.complexity > 3 && modelConfig.performance.speed === 'slow') {
      limitations.push(t('复杂文件处理速度较慢'));
    }

    // 硬件限制
    if (modelConfig.hardwareRequirements?.gpuAccelerated && modelConfig.vramRequiredGB > 8) {
      limitations.push(t('需要高性能GPU支持'));
    }

    return limitations;
  }

  /**
   * 估算平均处理时间
   */
  private estimateAvgProcessingTime(modelConfig: ILlamaModelConfig): number {
    const baseTime = modelConfig.totalSizeBytes / (1024 ** 3) * 1000; // 每GB约1秒

    const speedMultiplier = {
      'very_fast': 0.5,
      'fast': 0.7,
      'medium': 1.0,
      'slow': 1.5
    }[modelConfig.performance.speed] || 1.0;

    return baseTime * speedMultiplier;
  }

  /**
   * 估算GPU利用率
   */
  private estimateGpuUtilization(modelConfig: ILlamaModelConfig): number {
    if (!modelConfig.hardwareRequirements?.gpuAccelerated) return 0;

    // 基于模型大小和量化程度估算
    const baseUtilization = Math.min(90, modelConfig.vramRequiredGB * 10);

    // 量化会降低GPU利用率
    if (modelConfig.quantization?.includes('Q2')) {
      return baseUtilization * 0.6;
    } else if (modelConfig.quantization?.includes('Q4')) {
      return baseUtilization * 0.8;
    }

    return baseUtilization;
  }

  /**
   * 计算最大文件大小
   */
  private calculateMaxFileSize(modelConfig: ILlamaModelConfig): number {
    // 基于上下文长度和模型大小计算
    const contextLength = modelConfig.contextLength || 32768;
    const baseSize = Math.min(200, contextLength / 1000); // 基础大小MB

    // 大模型可以处理更大的文件
    const modelSizeMultiplier = Math.min(2, modelConfig.vramRequiredGB / 4);

    return Math.round(baseSize * modelSizeMultiplier);
  }

  /**
   * 计算最大并发数
   */
  private calculateMaxConcurrency(modelConfig: ILlamaModelConfig): number {
    // 基于模型大小和硬件要求计算
    const baseMemory = modelConfig.vramRequiredGB;

    if (baseMemory <= 2) return 4;
    if (baseMemory <= 4) return 3;
    if (baseMemory <= 8) return 2;
    return 1;
  }

  isMultiModalModel(model: ILlamaModelConfig): boolean {
    return this.fileAnalysisRouter.isMultiModalModel(model)
  }
}

/**
 * 单例实例
 * 注意：由于可能的循环依赖，建议在方法内部使用 ModelCapabilityDetector.getInstance()
 */
export const modelCapabilityDetector = ModelCapabilityDetector.getInstance();
