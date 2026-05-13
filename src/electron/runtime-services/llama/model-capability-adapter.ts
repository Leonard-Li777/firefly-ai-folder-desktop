/**
 * Model Capability Adapter - 模型能力适配分析服务
 * 
 * 根据当前模型能力进行文件分析，对不支持的文件类型进行基础分析（文件名+元数据），
 * 在界面明确显示分析类型和限制。
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  AIClassificationResult,
  FileInfo
} from '@yonuc/types/types';
import {
  IModelCapabilityInfo,
  TModelCapabilityType,
  IModelCapability
} from '@yonuc/types';
import { modelCapabilityDetector } from './model-capability-detector';
import { llamaModelManager } from './llama-model-manager';
import { configService } from '../config/config-service';
import { loggingService } from '../system/logging-service';
import { logger, LogCategory } from '@yonuc/shared';

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
  result: AIClassificationResult;
  /** 分析类型 */
  analysisType: AnalysisType;
  /** 使用的模型ID */
  modelId?: string;
  /** 模型能力信息 */
  modelCapabilities?: IModelCapabilityInfo;
  /** 支持的能力类型 */
  supportedCapability?: IModelCapability;
  /** 分析限制说明 */
  limitations: string[];
  /** 用户提示信息 */
  userMessage: string;
  /** 置信度调整说明 */
  confidenceNote?: string;
  /** 处理时间（毫秒） */
  processingTime: number;
  /** 是否需要用户确认 */
  requiresConfirmation: boolean;
}

/**
 * 文件分析上下文接口
 */
export interface IFileAnalysisContext {
  /** 文件路径 */
  filePath: string;
  /** 文件名 */
  fileName: string;
  /** 文件扩展名 */
  fileExtension: string;
  /** 文件大小（字节） */
  fileSize: number;
  /** MIME类型 */
  mimeType?: string;
  /** 内容预览 */
  contentPreview?: string;
  /** 文件元数据 */
  metadata?: Record<string, unknown>;
  /** 创建时间 */
  createdAt?: Date;
  /** 修改时间 */
  modifiedAt?: Date;
}

/**
 * 模型能力匹配结果
 */
export interface IModelCapabilityMatch {
  /** 是否匹配 */
  matches: boolean;
  /** 匹配的能力类型 */
  capabilityType?: TModelCapabilityType;
  /** 匹配的能力对象 */
  capability?: IModelCapability;
  /** 匹配度评分（0-100） */
  matchScore: number;
  /** 支持的文件格式 */
  supportedFormats: string[];
  /** 不支持的原因 */
  unsupportedReason?: string;
  /** 建议的替代方案 */
  alternatives: string[];
}

/**
 * 模型能力适配器
 */
export class ModelCapabilityAdapter extends EventEmitter {
  private currentModelId: string | null = null;
  private currentCapabilities: IModelCapabilityInfo | null = null;
  private capabilityCache = new Map<string, IModelCapabilityInfo>();
  private analysisCache = new Map<string, ICapabilityAdaptedResult>();

  constructor() {
    super();
    this.initializeAdapter();
  }

  /**
   * 初始化适配器
   */
  private async initializeAdapter(): Promise<void> {
    try {
      // 获取当前选择的模型
      this.currentModelId = configService.getValue<string>('SELECTED_MODEL_ID') as string;
      
      if (this.currentModelId) {
        await this.loadModelCapabilities(this.currentModelId);
      }

      loggingService.info(LogCategory.MODEL_CAPABILITY_ADAPTER, '模型能力适配器初始化完成');
    } catch (error) {
      loggingService.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '初始化失败', error);
    }
  }

  /**
   * 根据模型能力分析文件
   */
  async analyzeFileWithCapabilityAdaptation(
    context: IFileAnalysisContext,
    options: {
      forceFullAnalysis?: boolean;
      skipCache?: boolean;
      timeout?: number;
    } = {}
  ): Promise<ICapabilityAdaptedResult> {
    const startTime = Date.now();
    
    try {
      loggingService.debug(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `开始能力适配分析: ${context.fileName}`
      );

      // 检查缓存
      if (!options.skipCache) {
        const cached = this.getCachedResult(context);
        if (cached) {
          loggingService.debug(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `使用缓存结果: ${context.fileName}`
      );
          return cached;
        }
      }

      // 确保模型能力已加载
      await this.ensureModelCapabilitiesLoaded();

      // 检查模型能力匹配
      const capabilityMatch = await this.checkModelCapabilityMatch(context);

      let result: ICapabilityAdaptedResult;

      if (capabilityMatch.matches && !options.forceFullAnalysis) {
        // 执行完整AI分析
        result = await this.performFullAIAnalysis(context, capabilityMatch);
      } else if (capabilityMatch.matchScore > 30) {
        // 执行降级分析
        result = await this.performDegradedAnalysis(context, capabilityMatch);
      } else {
        // 执行基础元数据分析
        result = await this.performMetadataOnlyAnalysis(context, capabilityMatch);
      }

      result.processingTime = Date.now() - startTime;

      // 缓存结果
      this.cacheResult(context, result);

      loggingService.debug(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `能力适配分析完成: ${context.fileName}, 类型: ${result.analysisType}, 耗时: ${result.processingTime}ms`
      );

      this.emit('analysis-completed', { context, result });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      loggingService.error(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `能力适配分析失败: ${context.fileName}`, error
      );

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
      };

      this.emit('analysis-failed', { context, error });

      return errorResult;
    }
  }

  /**
   * 批量分析文件（考虑模型能力）
   */
  async batchAnalyzeWithCapabilityAdaptation(
    contexts: IFileAnalysisContext[],
    options: {
      maxConcurrency?: number;
      skipUnsupported?: boolean;
      progressCallback?: (progress: number, current: string) => void;
    } = {}
  ): Promise<ICapabilityAdaptedResult[]> {
    const maxConcurrency = options.maxConcurrency || 3;
    const results: ICapabilityAdaptedResult[] = [];
    
    loggingService.info(LogCategory.MODEL_CAPABILITY_ADAPTER, 
      `开始批量能力适配分析，文件数: ${contexts.length}`
    );

    // 按能力支持情况分组
    const { supported, unsupported } = await this.groupFilesByCapability(contexts);

    loggingService.debug(LogCategory.MODEL_CAPABILITY_ADAPTER, 
      `文件分组完成 - 支持: ${supported.length}, 不支持: ${unsupported.length}`
    );

    // 处理支持的文件
    for (let i = 0; i < supported.length; i += maxConcurrency) {
      const batch = supported.slice(i, i + maxConcurrency);
      const batchPromises = batch.map(context => 
        this.analyzeFileWithCapabilityAdaptation(context)
      );
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // 报告进度
      if (options.progressCallback) {
        const progress = Math.round(((i + batch.length) / contexts.length) * 100);
        const currentFile = batch[batch.length - 1]?.fileName || '';
        options.progressCallback(progress, currentFile);
      }
    }

    // 处理不支持的文件（如果不跳过）
    if (!options.skipUnsupported) {
      for (const context of unsupported) {
        const result = await this.performMetadataOnlyAnalysis(context, {
          matches: false,
          matchScore: 0,
          supportedFormats: [],
          unsupportedReason: '模型不支持此文件类型',
          alternatives: ['使用支持该文件类型的模型', '手动添加标签']
        });
        
        results.push(result);
      }
    }

    loggingService.info(LogCategory.MODEL_CAPABILITY_ADAPTER, 
      `批量能力适配分析完成，处理文件数: ${results.length}`
    );

    return results;
  }

  /**
   * 获取当前模型的能力限制信息
   */
  async getCurrentModelLimitations(): Promise<{
    modelId: string | null;
    capabilities: TModelCapabilityType[];
    supportedFormats: Record<TModelCapabilityType, string[]>;
    limitations: string[];
    recommendations: string[];
  }> {
    await this.ensureModelCapabilitiesLoaded();

    if (!this.currentModelId || !this.currentCapabilities) {
      return {
        modelId: null,
        capabilities: [],
        supportedFormats: {} as Record<TModelCapabilityType, string[]>,
        limitations: ['没有选择AI模型'],
        recommendations: ['请先选择一个AI模型']
      };
    }

    const modelConfig = await llamaModelManager.getModelInfo(this.currentModelId);
    const limitations: string[] = [];
    const recommendations: string[] = [];

    // 分析模型限制
    if (modelConfig) {
      // 基于模型大小的限制
      if (modelConfig.totalSizeBytes < 2 * 1024 ** 3) { // 小于2GB
        limitations.push('小型模型，处理复杂内容可能效果有限');
        recommendations.push('考虑使用更大的模型以获得更好的分析质量');
      }

      // 基于量化的限制
      if (modelConfig.quantization?.includes('Q2')) {
        limitations.push('低精度量化，可能影响输出质量');
        recommendations.push('如有足够显存，建议使用更高精度的模型');
      }

      // 基于多模态支持
      if (!modelConfig.isMultiModal) {
        limitations.push('非多模态模型，仅支持文本分析');
        recommendations.push('使用多模态模型以支持图像、音频、视频分析');
      }

      // 基于硬件要求
      if (modelConfig.vramRequiredGB > 8) {
        limitations.push('需要大显存GPU支持以获得最佳性能');
        recommendations.push('确保有足够的GPU显存或使用CPU模式');
      }
    }

    return {
      modelId: this.currentModelId,
      capabilities: Object.keys(this.currentCapabilities.supportedFileTypes) as TModelCapabilityType[],
      supportedFormats: this.currentCapabilities.supportedFileTypes as Record<TModelCapabilityType, string[]>,
      limitations,
      recommendations
    };
  }

  /**
   * 切换模型并更新能力
   */
  async switchModel(modelId: string): Promise<void> {
    if (modelId === this.currentModelId) return;

    loggingService.info(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `切换模型: ${this.currentModelId} -> ${modelId}`
      );

    try {
      // 清除缓存
      this.clearCache();

      // 加载新模型能力
      await this.loadModelCapabilities(modelId);
      
      this.currentModelId = modelId;
      
      // 保存到配置
      configService.updateValue('SELECTED_MODEL_ID', modelId);

      loggingService.info(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `模型切换完成: ${modelId}`
      );

      this.emit('model-switched', { 
        previousModelId: this.currentModelId,
        newModelId: modelId,
        capabilities: this.currentCapabilities
      });
    } catch (error) {
      loggingService.error(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `模型切换失败: ${modelId}`, error
      );
      throw error;
    }
  }

  /**
   * 获取文件类型支持状态
   */
  async getFileTypeSupportStatus(fileExtension: string): Promise<{
    supported: boolean;
    capabilityType?: TModelCapabilityType;
    analysisType: AnalysisType;
    limitations: string[];
    userMessage: string;
  }> {
    await this.ensureModelCapabilitiesLoaded();

    if (!this.currentCapabilities) {
      return {
        supported: false,
        analysisType: AnalysisType.METADATA_ONLY,
        limitations: ['没有选择AI模型'],
        userMessage: '请先选择一个AI模型以启用智能分析'
      };
    }

    const context: IFileAnalysisContext = {
      filePath: `test.${fileExtension}`,
      fileName: `test.${fileExtension}`,
      fileExtension: `.${fileExtension}`,
      fileSize: 0
    };

    const capabilityMatch = await this.checkModelCapabilityMatch(context);

    if (capabilityMatch.matches) {
      return {
        supported: true,
        capabilityType: capabilityMatch.capabilityType,
        analysisType: AnalysisType.FULL_AI,
        limitations: [],
        userMessage: `支持完整AI分析（${capabilityMatch.capabilityType}类型）`
      };
    } else if (capabilityMatch.matchScore > 30) {
      return {
        supported: true,
        capabilityType: capabilityMatch.capabilityType,
        analysisType: AnalysisType.DEGRADED,
        limitations: [capabilityMatch.unsupportedReason || '部分支持'],
        userMessage: '支持基础分析，但功能有限'
      };
    } else {
      return {
        supported: false,
        analysisType: AnalysisType.METADATA_ONLY,
        limitations: [capabilityMatch.unsupportedReason || '不支持此文件类型'],
        userMessage: '仅支持基于文件名和元数据的基础分析'
      };
    }
  }

  /**
   * 判断文件是否为多模态类型（图像、音频、视频）
   * 根据当前模型能力判断
   */
  async isMultimodalFileType(fileExtension: string): Promise<boolean> {
    await this.ensureModelCapabilitiesLoaded();

    if (!this.currentCapabilities) {
      return false;
    }

    const ext = fileExtension.toLowerCase().replace(/^\./, '');

    // 检查模型是否支持该文件的多模态能力
    // 只检查图像、音频、视频类型
    const multimodalTypes: TModelCapabilityType[] = ['IMAGE', 'AUDIO', 'VIDEO'];

    for (const type of multimodalTypes) {
      const supportedFormats = this.currentCapabilities.supportedFileTypes[type];
      if (supportedFormats && supportedFormats.includes(ext)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.analysisCache.clear();
    this.capabilityCache.clear();
    loggingService.debug(LogCategory.MODEL_CAPABILITY_ADAPTER, '缓存已清除');
  }

  /**
   * 加载模型能力
   */
  private async loadModelCapabilities(modelId: string): Promise<void> {
    try {
      // 检查缓存
      const cached = this.capabilityCache.get(modelId);
      if (cached) {
        this.currentCapabilities = cached;
        return;
      }

      // 从检测器获取能力
      const capabilities = await modelCapabilityDetector.detectModelCapabilities(modelId);
      
      this.currentCapabilities = capabilities;
      this.capabilityCache.set(modelId, capabilities);

      loggingService.debug(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `模型能力已加载: ${modelId}`, capabilities
      );
    } catch (error) {
      loggingService.error(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `加载模型能力失败: ${modelId}`, error
      );
      throw error;
    }
  }

  /**
   * 确保模型能力已加载
   */
  private async ensureModelCapabilitiesLoaded(): Promise<void> {
    if (!this.currentModelId) {
      this.currentModelId = configService.getValue<string>('SELECTED_MODEL_ID') as string;
    }

    if (this.currentModelId && !this.currentCapabilities) {
      await this.loadModelCapabilities(this.currentModelId);
    }
  }

  /**
   * 检查模型能力匹配
   */
  private async checkModelCapabilityMatch(
    context: IFileAnalysisContext
  ): Promise<IModelCapabilityMatch> {
    if (!this.currentCapabilities || !this.currentModelId) {
      return {
        matches: false,
        matchScore: 0,
        supportedFormats: [],
        unsupportedReason: '没有可用的模型',
        alternatives: ['选择一个AI模型']
      };
    }

    const fileExtension = context.fileExtension.toLowerCase().replace('.', '');
    
    // 检查每种能力类型
    for (const [capabilityType, supportedFormats] of Object.entries(this.currentCapabilities.supportedFileTypes)) {
      if (supportedFormats && supportedFormats.includes(fileExtension)) {
        // 获取能力详情
        const modelConfig = await llamaModelManager.getModelInfo(this.currentModelId);
        const capability = modelConfig?.capabilities.find(cap => cap.type === capabilityType as TModelCapabilityType);

        return {
          matches: true,
          capabilityType: capabilityType as TModelCapabilityType,
          capability,
          matchScore: 100,
          supportedFormats,
          alternatives: []
        };
      }
    }

    // 检查部分匹配（相似文件类型）
    const partialMatch = this.findPartialMatch(fileExtension);
    if (partialMatch) {
      return partialMatch;
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
    };
  }

  /**
   * 查找部分匹配
   */
  private findPartialMatch(fileExtension: string): IModelCapabilityMatch | null {
    if (!this.currentCapabilities) return null;

    // 文件类型相似性映射
    const similarityMap: Record<string, string[]> = {
      'jpg': ['jpeg', 'png', 'bmp', 'webp'],
      'jpeg': ['jpg', 'png', 'bmp', 'webp'],
      'png': ['jpg', 'jpeg', 'bmp', 'webp'],
      'mp4': ['avi', 'mov', 'mkv', 'webm'],
      'avi': ['mp4', 'mov', 'mkv', 'wmv'],
      'mp3': ['wav', 'flac', 'aac', 'm4a'],
      'wav': ['mp3', 'flac', 'aac', 'ogg'],
      'txt': ['md', 'rtf', 'log'],
      'md': ['txt', 'rtf', 'html'],
      'pdf': ['doc', 'docx', 'rtf']
    };

    const similarFormats = similarityMap[fileExtension] || [];
    
    for (const [capabilityType, supportedFormats] of Object.entries(this.currentCapabilities.supportedFileTypes)) {
      if (supportedFormats) {
        const hasPartialMatch = similarFormats.some(format => supportedFormats.includes(format));
        if (hasPartialMatch) {
          return {
            matches: false,
            capabilityType: capabilityType as TModelCapabilityType,
            matchScore: 40,
            supportedFormats,
            unsupportedReason: `模型支持相似的${capabilityType}文件，但不直接支持 .${fileExtension}`,
            alternatives: [
              `转换为支持的格式: ${supportedFormats.join(', ')}`,
              '使用基础分析模式'
            ]
          };
        }
      }
    }

    return null;
  }

  /**
   * 执行完整AI分析
   */
  private async performFullAIAnalysis(
    context: IFileAnalysisContext,
    capabilityMatch: IModelCapabilityMatch
  ): Promise<ICapabilityAdaptedResult> {
    // 这里应该调用实际的AI分析服务
    // 为了演示，我们创建一个模拟结果
    const result: AIClassificationResult = {
      fileId: context.fileName || 'unknown',
      timestamp: new Date(),
      category: this.inferCategoryFromCapability(capabilityMatch.capabilityType!),
      confidence: 0.85,
      tags: this.generateTagsFromContext(context, capabilityMatch),
      summary: `AI智能分析: ${context.fileName}`
    };

    return {
      result,
      analysisType: AnalysisType.FULL_AI,
      modelId: this.currentModelId!,
      modelCapabilities: this.currentCapabilities!,
      supportedCapability: capabilityMatch.capability,
      limitations: [],
      userMessage: `已使用AI模型完整分析（${capabilityMatch.capabilityType}类型）`,
      processingTime: 0, // 将在调用处设置
      requiresConfirmation: false
    };
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
    };

    return {
      result,
      analysisType: AnalysisType.DEGRADED,
      modelId: this.currentModelId!,
      limitations: [capabilityMatch.unsupportedReason || '模型部分支持此文件类型'],
      userMessage: '已进行基础智能分析，建议使用支持该文件类型的模型获得更好效果',
      confidenceNote: '置信度较低，因为模型对此文件类型支持有限',
      processingTime: 0,
      requiresConfirmation: true
    };
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
    };

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
    };
  }

  /**
   * 按能力支持情况分组文件
   */
  private async groupFilesByCapability(
    contexts: IFileAnalysisContext[]
  ): Promise<{
    supported: IFileAnalysisContext[];
    unsupported: IFileAnalysisContext[];
  }> {
    const supported: IFileAnalysisContext[] = [];
    const unsupported: IFileAnalysisContext[] = [];

    for (const context of contexts) {
      const match = await this.checkModelCapabilityMatch(context);
      if (match.matches) {
        supported.push(context);
      } else {
        unsupported.push(context);
      }
    }

    return { supported, unsupported };
  }

  /**
   * 从能力类型推断分类
   */
  private inferCategoryFromCapability(capabilityType: TModelCapabilityType): string {
    const categoryMap: Record<TModelCapabilityType, string> = {
      'TEXT': '文档',
      'IMAGE': '图片',
      'AUDIO': '音频',
      'VIDEO': '视频'
    };

    return categoryMap[capabilityType] || '未知';
  }

  /**
   * 从扩展名推断分类
   */
  private inferCategoryFromExtension(fileExtension: string): string {
    const ext = fileExtension.toLowerCase();
    
    if (['.txt', '.md', '.doc', '.docx', '.pdf', '.rtf'].includes(ext)) {
      return '文档';
    } else if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.bmp', '.webp'].includes(ext)) {
      return '图片';
    } else if (['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm'].includes(ext)) {
      return '视频';
    } else if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'].includes(ext)) {
      return '音频';
    } else if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
      return '压缩包';
    } else if (['.exe', '.msi', '.app', '.deb', '.rpm'].includes(ext)) {
      return '程序';
    }
    
    return '文件';
  }

  /**
   * 从上下文和能力匹配生成标签
   */
  private generateTagsFromContext(
    context: IFileAnalysisContext,
    capabilityMatch: IModelCapabilityMatch
  ): string[] {
    const tags: string[] = [];
    
    // 添加能力类型标签
    if (capabilityMatch.capabilityType) {
      tags.push(capabilityMatch.capabilityType);
    }
    
    // 添加基础标签
    tags.push(...this.generateBasicTags(context));
    
    // 添加AI分析标签
    tags.push('AI分析');
    
    return [...new Set(tags)]; // 去重
  }

  /**
   * 生成基础标签
   */
  private generateBasicTags(context: IFileAnalysisContext): string[] {
    const tags: string[] = [];
    const fileName = context.fileName.toLowerCase();
    const ext = context.fileExtension.toLowerCase();
    
    // 添加扩展名标签
    if (ext) {
      tags.push(ext.replace('.', ''));
    }
    
    // 基于文件名的标签
    if (fileName.includes('screenshot') || fileName.includes('截图')) {
      tags.push('截图');
    }
    if (fileName.includes('backup') || fileName.includes('备份')) {
      tags.push('备份');
    }
    if (fileName.includes('temp') || fileName.includes('临时')) {
      tags.push('临时');
    }
    if (fileName.includes('draft') || fileName.includes('草稿')) {
      tags.push('草稿');
    }
    if (fileName.includes('final') || fileName.includes('最终')) {
      tags.push('最终版');
    }
    
    // 基于文件大小的标签
    if (context.fileSize > 100 * 1024 * 1024) { // 大于100MB
      tags.push('大文件');
    } else if (context.fileSize < 1024) { // 小于1KB
      tags.push('小文件');
    }
    
    return tags;
  }

  /**
   * 获取缓存结果
   */
  private getCachedResult(context: IFileAnalysisContext): ICapabilityAdaptedResult | null {
    const cacheKey = this.generateCacheKey(context);
    return this.analysisCache.get(cacheKey) || null;
  }

  /**
   * 缓存结果
   */
  private cacheResult(context: IFileAnalysisContext, result: ICapabilityAdaptedResult): void {
    const cacheKey = this.generateCacheKey(context);
    this.analysisCache.set(cacheKey, result);
    
    // 限制缓存大小
    if (this.analysisCache.size > 1000) {
      const firstKey = this.analysisCache.keys().next().value;
      if (firstKey !== undefined) {
        this.analysisCache.delete(firstKey);
      }
    }
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(context: IFileAnalysisContext): string {
    return `${this.currentModelId}_${context.filePath}_${context.fileSize}_${context.modifiedAt?.getTime() || 0}`;
  }
}

/**
 * 单例实例
 */
export const modelCapabilityAdapter = new ModelCapabilityAdapter();