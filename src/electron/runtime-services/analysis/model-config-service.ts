import * as fs from 'fs'
import * as path from 'path'

import { LogCategory, logger } from '@yonuc/shared'

import type { ILlamaModelConfig, TModelCapabilityType } from '@yonuc/types/model-manager'
import type { LocalModelConfigFile } from '@yonuc/types/config-types'
import { app } from 'electron'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { t } from '@app/languages'

import { unifiedModelManager } from '../llama/unified-model-manager'

/**
 * 模型配置服务
 * 负责加载、缓存和管理模型配置
 */
export class ModelConfigService {
  private static instance: ModelConfigService
  private cloudProvidersCache: Map<string, any> = new Map() // 云端提供商配置缓存
  private logger = logger.createLogger(LogCategory.MODEL_CONFIG)

  public static getInstance(): ModelConfigService {
    if (!ModelConfigService.instance) {
      ModelConfigService.instance = new ModelConfigService()
    }
    return ModelConfigService.instance
  }

  private constructor() {
    // 监听语言配置变化
    this.setupLanguageChangeListener()
  }

  /**
   * 获取当前语言
   */
  private getLanguage(): string {
    return ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN';
  }

  /**
   * 设置语言变更监听
   */
  private setupLanguageChangeListener(): void {
    ConfigOrchestrator.getInstance().onValueChange('DEFAULT_LANGUAGE', (lang) => {
      this.logger.info(`检测到语言变更: ${lang}，正在清理模型配置缓存...`)
      this.clearCache()
    })
  }

  /**
   * 加载模型配置 (核心重构：使用 UnifiedModelManager)
   */
  private ensureConfigsLoaded(): void {
    unifiedModelManager.ensureLoaded();
  }

  /**
   * 加载 Ollama 平台模型配置
   */
  loadOllamaModelConfig(language: string = this.getLanguage()): any[] {
    this.ensureConfigsLoaded();
    const models = unifiedModelManager.getAllModels().filter(m => m.source === 'ollama' || (m as any).ollama);
    return models.map(m => this.simplifyModel(m));
  }

  /**
   * 加载本地 Llama 平台模型配置
   */
  loadLocalModelConfig(language: string = this.getLanguage()): any[] {
    this.ensureConfigsLoaded();
    const models = unifiedModelManager.getAllModels().filter(m => m.source !== 'ollama' && !(m as any).ollama);
    return models.map(m => this.simplifyModel(m));
  }

  /**
   * 简化模型配置，统一使用 capabilities 字符串数组
   */
  private simplifyModel(model: any): any {
    return {
      ...model,
      capabilities: model.capabilities || model.supportedFormats || ['TEXT'],
      isBuiltin: !!model.isBuiltin,
      vramRequiredGB: model.vramRequiredGB || unifiedModelManager.calculateRequiredVRAM(model.totalSize || '0B')
    };
  }

  /**
   * 加载当前平台的模型配置
   */
  loadModelConfig(language: string = this.getLanguage()): any[] {
    const orchestrator = ConfigOrchestrator.getInstance();
    const platform = orchestrator.getValue<string>('AI_ENGINE') || 'llama.cpp';

    // 严格按引擎筛选，不混合模型
    return platform === 'ollama'
      ? this.loadOllamaModelConfig(language)
      : this.loadLocalModelConfig(language);
  }

  /**
   * 加载所有平台的模型配置（不按引擎筛选）
   */
  loadAllModelConfigs(language: string = this.getLanguage()): any[] {
    this.ensureConfigsLoaded();
    const models = unifiedModelManager.getAllModels();
    return models.map(m => this.simplifyModel(m));
  }

  /**
   * 清除所有缓存
   */
  clearCache(): void {
    this.cloudProvidersCache.clear()
    this.logger.info('已清除所有模型配置缓存（本地模型 + 云端提供商）')
  }

  /**
   * 加载云端提供商配置
   * 唯一入口：ConfigOrchestrator 中的 CLOUD_MODEL_CONFIGS
   */
  loadCloudProvidersConfig(language: string = this.getLanguage()): any[] {
    const orchestrator = ConfigOrchestrator.getInstance()
    const configs = orchestrator.getValue<any[]>('CLOUD_MODEL_CONFIGS') || []
    return configs
  }

  /**
   * 获取模型的能力类型列表
   */
  getModelCapabilityTypes(model: any): string[] {
    const caps = model.capabilities || model.supportedFormats || [];
    if (!Array.isArray(caps)) return [];

    return caps.map((cap: any) => typeof cap === 'string' ? cap : cap.type);
  }

  /**
   * 获取模型支持的文件格式
   * 注意：现在系统会自动转换格式，此处主要返回对应能力类型的通用格式
   */
  getModelSupportedFormats(model: any): string[] {
    const types = this.getModelCapabilityTypes(model);
    const formats = new Set<string>()

    types.forEach((type: any) => {
      this.getDefaultFormatsForType(type as TModelCapabilityType).forEach(f => formats.add(f));
    })

    return Array.from(formats)
  }

  /**
   * 检查模型是否支持多模态
   */
  isMultiModalModel(model: any): boolean {
    const types = this.getModelCapabilityTypes(model);
    return types.some(type => type !== 'TEXT');
  }

  /**
   * 根据文件类型选择合适的分析模式
   * @param model 模型配置
   * @param fileType 文件扩展名 (e.g., 'jpg', 'pdf')
   * @returns 分析模式: 'multimodal' | 'text-only'
   */
  selectAnalysisMode(model: any, fileType: string): 'multimodal' | 'text-only' {
    const cleanFileType = fileType.toLowerCase().replace(/^\./, '')
    const types = this.getModelCapabilityTypes(model);

    // 检查模型是否支持该文件类型的多模态能力
    const hasMultimodalCapability = types.some(type => {
      if (type === 'TEXT') return false;
      return this.getDefaultFormatsForType(type as TModelCapabilityType).includes(cleanFileType);
    });

    return hasMultimodalCapability ? 'multimodal' : 'text-only'
  }

  /**
   * 根据能力类型获取默认的支持格式（扩展名）
   * 用于从 UnifiedModelConfig 转换到 ILlamaModelConfig 时填充缺失信息
   */
  private getDefaultFormatsForType(type: TModelCapabilityType): string[] {
    switch (type) {
      case 'TEXT':
        return ['txt', 'md', 'pdf', 'doc', 'docx', 'rtf', 'html', 'xml', 'json']
      case 'IMAGE':
        return ['jpg', 'jpeg', 'jpe', 'png', 'bmp', 'webp', 'gif', 'svg', 'tiff', 'tif', 'heic']
      case 'AUDIO':
        return ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a']
      case 'VIDEO':
        return ['mp4', 'avi', 'mov', 'mkv', 'flv', 'webm', 'wmv']
      default:
        return []
    }
  }
}

