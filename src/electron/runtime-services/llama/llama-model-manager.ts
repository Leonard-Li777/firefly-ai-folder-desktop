/**
 * Llama Model Manager - 管理 llama-server 兼容的 GGUF 格式模型
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { calculateFileFingerprint as calculateFileFingerprintCore } from '@yonuc/core-engine/utils/file-fingerprint';

import { BrowserWindow, app, net, session, webContents } from 'electron';
import {
  ILlamaModelConfig,
  ILlamaModelManager,
  IModelCapabilityInfo,
  IModelDownloadTask,
  IModelEventData,
  IModelRecommendation,
  IModelSummary,
  IModelValidationResult,
  ModelEvent,
  TModelCapabilityType,
  ISystemResources
} from '@yonuc/types';
import { LogCategory, logger } from '@yonuc/shared';
import {
  getAllLlamaModelConfigs,
  getLlamaModelConfig,
  isMultiModalModel,
  recommendLlamaModelsByFileType,
  recommendLlamaModelsByHardware
} from '../../model';

import { EventEmitter } from 'events';
import { configService } from '../config/config-service';
import { createWriteStream } from 'fs';
import { ModelCapabilityDetector } from './model-capability-detector';
import { ModelDownloadManager } from '../ai/model-download-manager';
import { ModelStatusService } from './model-status-service';
import { MultiModalModelService } from '../ai/multimodal-model-service';
import { t } from '@app/languages';
import { ConfigOrchestrator } from '../../config/config-orchestrator';
import { OllamaService } from '../ai/ollama-service';

/**
 * Llama 模型管理器实现
 */
export class LlamaModelManager extends EventEmitter implements ILlamaModelManager {
  private static instance: LlamaModelManager;
  private downloadTasks = new Map<string, IModelDownloadTask>();
  private modelCache = new Map<string, ILlamaModelConfig>();
  private capabilityCache = new Map<string, IModelCapabilityInfo>();

  public static getInstance(): LlamaModelManager {
    if (!LlamaModelManager.instance) {
      LlamaModelManager.instance = new LlamaModelManager();
    }
    return LlamaModelManager.instance;
  }

  private constructor() {
    super();
    // 延迟初始化缓存以避免循环依赖
    setImmediate(() => {
      this.initializeCache();
    });

    if (logger) {
      logger.debug(LogCategory.LLAMA_MODEL_MANAGER, '[LlamaModelManager] Llama模型管理器已创建')
    }
  }

  /**
   * 初始化缓存
   */
  private initializeCache(): void {
    // 预加载所有模型配置到缓存
    getAllLlamaModelConfigs().forEach(config => {
      this.modelCache.set(config.id, config);
    });
  }

  /**
   * 获取模型列表（极致轻量化 - 不再检测安装状态，不再产生 IO 日志）
   */
  async listModels(): Promise<IModelSummary[]> {
    const models = getAllLlamaModelConfigs();
    
    // 预先获取硬件信息用于动态推荐 (从缓存配置读取，极快)
    let maxVramMB = 0;
    let totalMemMB = 0;
    try {
      const conf = ConfigOrchestrator.getInstance();
      const memInfo = conf.getValue<any>('HARDWARE_MEMORY_INFO');
      const gpuInfos = conf.getValue<any[]>('HARDWARE_GPU_INFO') || [];
      if (memInfo) totalMemMB = memInfo.total;
      if (gpuInfos.length > 0) maxVramMB = Math.max(...gpuInfos.map(g => g.memory || 0));
    } catch { /* ignore */ }

    const summaries: IModelSummary[] = models.map((model) => {
      // 动态推荐逻辑
      let isRecommended = false;
      const vramReq = (model.vramRequiredGB || 0) * 1024;
      const memReq = (model.hardwareRequirements?.minMemoryGB || 0) * 1024;

      if (maxVramMB > 0) {
        if (vramReq > 0 && vramReq <= maxVramMB) {
          isRecommended = (model.performance?.score || 0) >= 70;
        }
      } else {
        if (memReq <= totalMemMB) {
          isRecommended = (model.performance?.score || 0) >= 60;
        }
      }

      return {
        id: model.id,
        name: model.name,
        description: model.description,
        company: model.company,
        parameterSize: model.parameterSize,
        totalSizeText: model.totalSize,
        totalSizeBytes: model.totalSizeBytes,
        minVramGB: model.hardwareRequirements?.minMemoryGB ?? model.performance?.minMemoryGB ?? 0,
        recommendedVramGB: model.hardwareRequirements?.recommendedVramGB || 0,
        gpuAccelerated: model.hardwareRequirements?.gpuAccelerated ?? false,
        performance: model.performance || { speed: 'medium', quality: 'medium', score: 0 },
        capabilities: (model.capabilities ?? []).map(c => c.type),
        tags: model.tags || [],
        files: model.files || [],
        vramRequiredGB: model.vramRequiredGB || 0,
        isDownloaded: false, // 默认不下载，由前端通过 checkModelsStatus 异步确认
        isRecommended: !!isRecommended
      };
    });

    // 按推荐优先级排序
    return summaries.sort((a, b) => {
      if (a.isRecommended !== b.isRecommended) return a.isRecommended ? -1 : 1;
      return (b.performance?.score || 0) - (a.performance?.score || 0);
    });
  }

  /**
   * 专职负责检测所有模型的安装状态 (IO 密集型)
   */
  async checkModelsStatus(): Promise<Record<string, { isDownloaded: boolean, downloadProgress?: number }>> {
    const models = getAllLlamaModelConfigs();
    const platform = ConfigOrchestrator.getInstance().getValue<string>('AI_PLATFORM') || 'llama.cpp';
    const isOllamaPlatform = platform === 'ollama';
    const downloadMgr = ModelDownloadManager.getInstance();

    logger.debug(LogCategory.LLAMA_MODEL_MANAGER, `[checkModelsStatus] 正在异步扫描模型安装状态, 平台: ${platform}`);

    const results = await Promise.all(models.map(async (model) => {
      let isDownloaded = false;
      let downloadProgress: number | undefined;
      const downloadTask = this.getActiveDownloadTask(model.id);

      if (isOllamaPlatform) {
        try {
          isDownloaded = await OllamaService.getInstance().checkModelInstalled(model.id);
        } catch { /* ignore */ }
      } else {
        const status = await downloadMgr.checkModelDownloadStatus(model.id);
        isDownloaded = !!status.isDownloaded;
        if (downloadTask?.status === 'downloading') {
          downloadProgress = Math.round((downloadTask.receivedBytes / downloadTask.totalBytes) * 100);
        }
      }

      return { id: model.id, isDownloaded, downloadProgress };
    }));

    const statusMap: Record<string, { isDownloaded: boolean, downloadProgress?: number }> = {};
    results.forEach(r => {
      statusMap[r.id] = { isDownloaded: !!r.isDownloaded, downloadProgress: r.downloadProgress };
    });
    return statusMap;
  }

  /**
   * 获取模型详细信息 (纯内存操作)
   */
  async getModelInfo(modelId: string): Promise<ILlamaModelConfig | null> {
    return this.modelCache.get(modelId) || null;
  }

  /**
   * 获取模型路径 (严谨的文件匹配逻辑)
   */
  async getModelPath(modelId: string): Promise<string | null> {
    const downloadStatus = await ModelDownloadManager.getInstance().checkModelDownloadStatus(modelId);
    if (!downloadStatus.isDownloaded) return null;

    const modelDir = await this.getModelDirectory(modelId);
    
    try {
      const files = await fs.readdir(modelDir);
      const ggufFiles = files.filter(file => file.endsWith('.gguf'));
      if (ggufFiles.length === 0) return null;
      
      const modelFiles = ggufFiles.filter(file => !file.toLowerCase().includes('mmproj'));
      let mainModelFile = modelFiles.find(file => file.includes(modelId) || file.toLowerCase().includes('instruct') || file.toLowerCase().includes('chat')) || modelFiles[0];
      
      if (!mainModelFile) return null;
      return path.join(modelDir, mainModelFile);
    } catch (error) {
      logger.error(LogCategory.LLAMA_MODEL_MANAGER, `[getModelPath] 读取目录失败: ${modelDir}`, error);
      return null;
    }
  }

  /**
   * 获取多模态模型配置 (严谨匹配逻辑)
   */
  async getMultiModalModelConfig(modelId: string): Promise<{
    modelPath: string;
    mmprojPath?: string;
    isMultiModal: boolean;
  } | null> {
    const downloadStatus = await ModelDownloadManager.getInstance().checkModelDownloadStatus(modelId);
    if (!downloadStatus.isDownloaded) return null;

    const modelDir = await this.getModelDirectory(modelId);
    try {
      const files = await fs.readdir(modelDir);
      const ggufFiles = files.filter(file => file.endsWith('.gguf'));
      if (ggufFiles.length === 0) return null;
      
      const mmprojFiles = ggufFiles.filter(file => file.toLowerCase().includes('mmproj'));
      const modelFiles = ggufFiles.filter(file => !file.toLowerCase().includes('mmproj'));
      
      let mainModelFile = modelFiles.find(file => file.includes(modelId) || file.toLowerCase().includes('instruct') || file.toLowerCase().includes('chat')) || modelFiles[0];
      if (!mainModelFile) return null;
      
      const mmprojFile = mmprojFiles.length > 0 ? mmprojFiles[0] : undefined;
      return {
        modelPath: path.join(modelDir, mainModelFile),
        mmprojPath: mmprojFile ? path.join(modelDir, mmprojFile) : undefined,
        isMultiModal: !!mmprojFile
      };
    } catch (error) {
      logger.error(LogCategory.LLAMA_MODEL_MANAGER, `[getMultiModal] 匹配失败: ${modelId}`, error);
      return null;
    }
  }

  /**
   * 获取活跃的下载任务
   */
  private getActiveDownloadTask(modelId: string): IModelDownloadTask | undefined {
    for (const task of this.downloadTasks.values()) {
      if (task.modelId === modelId && (task.status === 'downloading' || task.status === 'pending')) {
        return task;
      }
    }
    return undefined;
  }

  /**
   * 获取下载任务（用于测试）
   */
  getDownloadTask(taskId: string): IModelDownloadTask | null {
    return this.downloadTasks.get(taskId) || null;
  }

  /**
   * 从旧版配置迁移（用于测试）
   */
  async migrateFromLegacyConfig(): Promise<any> {
    // 旧版配置迁移逻辑（如果有的话）
    // 目前版本不需要迁移，返回空对象
    return {};
  }

  /**
   * 验证模型完整性 (恢复严谨的哈希和大小校验逻辑)
   */
  async validateModel(modelId: string): Promise<IModelValidationResult> {
    const model = await this.getModelInfo(modelId);
    if (!model) {
      return { isValid: false, modelId, validatedFiles: [], missingFiles: [], corruptedFiles: [], errors: [t('模型配置不存在')], warnings: [] };
    }

    const modelDir = await this.getModelDirectory(modelId);
    if (model.isMultiModal) {
      return await MultiModalModelService.getInstance().checkMultiModalIntegrity(modelId, modelDir);
    }

    const validatedFiles: IModelValidationResult['validatedFiles'] = [];
    const missingFiles: string[] = [];
    const corruptedFiles: string[] = [];
    const warnings: string[] = [];

    for (const file of model.files) {
      const filePath = path.join(modelDir, file.name);
      try {
        const stats = await fs.stat(filePath);
        // 5% 误差范围内认为大小匹配
        const sizeMatch = Math.abs(stats.size - file.sizeBytes) <= (file.sizeBytes * 0.05);
        
        let hashMatch: boolean | undefined;
        if (file.sha256) {
          try {
            const hash = await this.calculateFileFingerprint(filePath);
            hashMatch = hash === file.sha256;
          } catch (error) {
            warnings.push(t('无法计算文件哈希: {file}', {file: file.name}));
          }
        }

        validatedFiles.push({ fileName: file.name, exists: true, sizeMatch, hashMatch, error: !sizeMatch ? t('文件大小不匹配') : undefined });
        if (!sizeMatch) corruptedFiles.push(file.name);
      } catch {
        validatedFiles.push({ fileName: file.name, exists: false, sizeMatch: false, error: t('文件不存在') });
        if (file.required) missingFiles.push(file.name);
      }
    }

    return {
      isValid: missingFiles.length === 0 && corruptedFiles.length === 0,
      modelId,
      validatedFiles,
      missingFiles,
      corruptedFiles,
      errors: [],
      warnings
    };
  }

  /**
   * 删除模型
   */
  async deleteModel(modelId: string): Promise<void> {
    const modelDir = await this.getModelDirectory(modelId);
    try {
      await fs.rm(modelDir, { recursive: true, force: true });
      this.emitModelEvent(ModelEvent.MODEL_DELETED, { modelId });
      logger.log(LogCategory.LLAMA_MODEL_MANAGER, `[LlamaModelManager] 模型已删除: ${modelId}`);
    } catch (error) {
      throw new Error(t('删除模型失败: {error}', {error: String(error)}));
    }
  }

  /**
   * 各种转发方法
   */
  async getModelCapabilities(modelId: string) { return await ModelCapabilityDetector.getInstance().detectModelCapabilities(modelId); }
  async checkFileTypeSupport(modelId: string, ext: string) { return await ModelCapabilityDetector.getInstance().checkFileTypeSupport(modelId, ext); }
  async getModelStatus(modelId: string) { return await ModelCapabilityDetector.getInstance().getModelStatus(modelId); }
  async getModelsByFileType(ext: string) { return await ModelCapabilityDetector.getInstance().getModelsByFileType(ext); }
  async getCapabilityLimitations(modelId: string, type: TModelCapabilityType) { return await ModelCapabilityDetector.getInstance().getCapabilityLimitations(modelId, type); }
  async setCurrentModel(modelId: string): Promise<void> { await ModelStatusService.getInstance().setCurrentModel(modelId); }
  getStatusBarInfo() { return ModelStatusService.getInstance().getStatusBarInfo(); }
  async checkFileCompatibility(ext: string) { return await ModelStatusService.getInstance().checkFileCompatibility(ext); }

  async recommendModelsByHardware(memoryGB?: number, hasGPU?: boolean, vramGB?: number): Promise<IModelRecommendation> {
    const summaries = await this.listModels();
    const recommended = summaries.filter(s => s.isRecommended).map(s => s.id);
    return { recommendedModels: recommended, reasons: {}, hardwareMatchScore: {}, useCaseMatchScore: {} };
  }

  async recommendModelsByFileType(fileType: TModelCapabilityType): Promise<string[]> { return recommendLlamaModelsByFileType(fileType); }
  async isFileTypeSupported(modelId: string, ext: string): Promise<boolean> {
    const model = await this.getModelInfo(modelId);
    return model?.capabilities.some(c => c.supportedFormats.includes(ext.toLowerCase())) || false;
  }

  async getSupportedFileFormats(modelId: string): Promise<string[]> {
    const model = await this.getModelInfo(modelId);
    return [...new Set(model?.capabilities.flatMap(c => c.supportedFormats) || [])];
  }

  async getMultiModalInfo(modelId: string) { return await MultiModalModelService.getInstance().analyzeMultiModalModel(modelId); }
  async validateMultiModalAssociations(modelId: string) {
    const modelDir = await this.getModelDirectory(modelId);
    return await MultiModalModelService.getInstance().validateFileAssociations(modelId, modelDir);
  }
  async supportsModality(modelId: string, modality: TModelCapabilityType): Promise<boolean> { return MultiModalModelService.getInstance().supportsModality(modelId, modality); }
  async getSupportedModalities(modelId: string): Promise<TModelCapabilityType[]> { return MultiModalModelService.getInstance().getSupportedModalities(modelId); }

  clearCache(): void {
    this.modelCache.clear();
    this.capabilityCache.clear();
    this.initializeCache();
    this.emitModelEvent(ModelEvent.CACHE_CLEARED, { modelId: 'all' });
  }

  refreshBaseDirectory(): void { this.clearCache(); }

  private async getModelDirectory(modelId: string): Promise<string> {
    const configuredPath = configService.getValue<string>('MODEL_STORAGE_PATH');
    const baseDir = configuredPath ? path.resolve(configuredPath.trim()) : path.join(app.getPath('userData'), 'models');
    await fs.mkdir(baseDir, { recursive: true });
    return path.join(baseDir, modelId);
  }

  private async calculateFileFingerprint(filePath: string): Promise<string> { return calculateFileFingerprintCore(filePath); }

  private emitModelEvent(event: ModelEvent, data: IModelEventData): void {
    this.emit(event, data);
    BrowserWindow.getAllWindows().forEach(win => { win.webContents.send(`model-${event}`, data); });
  }
}

export const llamaModelManager = LlamaModelManager.getInstance();
