/**
 * Llama Model Manager - 统一管理本地 AI 模型
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { BrowserWindow, app } from 'electron';
import {
  ILlamaModelManager,
  IModelDownloadTask,
  IModelEventData,
  IModelSummary,
  IModelValidationResult,
  ModelEvent,
  TModelCapabilityType
} from '@yonuc/types';
import { LogCategory, configService, logger, parseSizeToGB } from '@yonuc/shared';

import { ConfigOrchestrator } from '../../config/config-orchestrator';
import { EventEmitter } from 'events';
import { createWriteStream } from 'fs';
import { ModelCapabilityDetector } from './model-capability-detector';
import { ModelConfigService } from '../analysis/model-config-service';
import { ModelDownloadManager } from '../ai/model-download-manager';
import { ModelStatusService } from './model-status-service';
import { MultiModalModelService } from '../ai/multimodal-model-service';
import { t } from '@app/languages';
import { ollamaService } from '../ai/ollama-service';
import { unifiedModelManager } from './unified-model-manager';
import { LlamaEngineService } from './llama-engine-service';

export class LlamaModelManager extends EventEmitter implements ILlamaModelManager {
  private static instance: LlamaModelManager;
  private downloadTasks = new Map<string, IModelDownloadTask>();

  public static getInstance(): LlamaModelManager {
    if (!LlamaModelManager.instance) {
      LlamaModelManager.instance = new LlamaModelManager();
    }
    return LlamaModelManager.instance;
  }

  private constructor() {
    super();
    logger.debug(LogCategory.LLAMA_MODEL_MANAGER, '[LlamaModelManager] 初始化完成');
  }

  /**
   * 获取模型列表 - 优先从统一配置中获取合并后的结果
   */
  async listModels(): Promise<IModelSummary[]> {
    const configOrchestrator = ConfigOrchestrator.getInstance();
    const language = configOrchestrator.getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN';
    const modelConfigService = ModelConfigService.getInstance();
    const rawModels = modelConfigService.loadModelConfig(language);
    return this.processModelsToSummaries(rawModels);
  }

  /**
   * 获取所有模型摘要（不按引擎筛选）
   */
  async listAllModels(): Promise<IModelSummary[]> {
    const configOrchestrator = ConfigOrchestrator.getInstance();
    const language = configOrchestrator.getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN';
    const modelConfigService = ModelConfigService.getInstance();
    const rawModels = modelConfigService.loadAllModelConfigs(language);
    return this.processModelsToSummaries(rawModels);
  }

  /**
   * 内部方法：执行数据加工与显存推导
   */
  private async processModelsToSummaries(rawModels: any[]): Promise<IModelSummary[]> {
    const configOrchestrator = ConfigOrchestrator.getInstance();
    const platform = configOrchestrator.getValue<string>('AI_ENGINE') || 'llama.cpp';
    
    // 确保统一管理器已加载
    await unifiedModelManager.ensureLoaded();

    // 3. 获取硬件信息进行动态计算
    let maxVramGB = 0;
    try {
      const gpuInfos = configOrchestrator.getValue<any[]>('HARDWARE_GPU_INFO') || [];
      if (gpuInfos.length > 0) maxVramGB = Math.max(...gpuInfos.map(g => g.memory || 0)) / 1024;
    } catch { }

    const downloadMgr = ModelDownloadManager.getInstance();

    // 4. 执行数据加工与显存推导
    const summaries: IModelSummary[] = await Promise.all(rawModels.map(async (model: any) => {
      // 显存需求计算结果强制向上取整为整数 GB
      const vramRequired = Math.ceil(model.vramRequiredGB || unifiedModelManager.calculateRequiredVRAM(model.totalSize));

      const isRecommended = maxVramGB > 1
        ? (vramRequired <= maxVramGB * 1.2 && model.performance?.quality !== 'low')
        : (vramRequired <= 2);

      // 实时检查下载状态
      let isDownloaded = false;
      const modelPlatform = model.source === 'ollama' || (model as any).ollama ? 'ollama' : 'llama.cpp';
      
      if (modelPlatform === 'ollama') {
        try { isDownloaded = await ollamaService.checkModelInstalled(model.id); } catch { }
      } else {
        const status = await downloadMgr.checkModelDownloadStatus(model.id);
        isDownloaded = !!(status as any).isDownloaded;
      }

      return {
        id: model.id,
        name: model.name,
        description: model.description,
        company: model.company,
        parameterSize: model.parameterSize,
        totalSize: model.totalSize,
        totalSizeText: model.totalSize,
        totalSizeBytes: Math.round(parseSizeToGB(model.totalSize) * (1024 ** 3)),
        source: model.source,
        minVramGB: vramRequired,
        recommendedVramGB: Math.ceil(vramRequired * 1.2),
        gpuAccelerated: true,
        performance: model.performance || { speed: 'medium', quality: 'medium', score: 0 },
        capabilities: model.capabilities || model.supportedFormats || ['TEXT'],
        tags: model.tags || [],
        files: [],
        vramRequiredGB: vramRequired,
        isDownloaded,
        isRecommended: !!isRecommended,
        isBuiltin: !!model.isBuiltin
      };
    }));

    return summaries.sort((a, b) => {
      if (a.isRecommended !== b.isRecommended) return a.isRecommended ? -1 : 1;
      return a.vramRequiredGB - b.vramRequiredGB;
    });
  }

  async checkModelsStatus(): Promise<Record<string, { isDownloaded: boolean, downloadProgress?: number }>> {
    // 动态引入 ModelConfigService 避免循环依赖
    const configService = ModelConfigService.getInstance();
    const orchestrator = ConfigOrchestrator.getInstance();

    const language = orchestrator.getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN';
    const statusMap: Record<string, { isDownloaded: boolean, downloadProgress?: number }> = {};

    try {
      const aiEngine = orchestrator.getValue<string>('AI_ENGINE') || 'llama.cpp';
      logger.debug(LogCategory.LLAMA_MODEL_MANAGER, `[checkModelsStatus] 正在扫描模型安装状态, 平台: ${aiEngine}`);

      const models = configService.loadModelConfig(language) || [];

      if (aiEngine === 'ollama') {
        const installedOllamaModels = await ollamaService.listInstalledModels();
        const pullingModels = ollamaService.getPullingModels();

        // 处理 Ollama 模型
        models.forEach((model: any) => {
          const isDownloaded = installedOllamaModels.some(installedName => {
            const installed = installedName.toLowerCase();
            const target = model.id.toLowerCase();

            if (installed === target) return true;
            if (target.endsWith(':latest') && installed === target.replace(':latest', '')) return true;
            if (installed.endsWith(':latest') && target === installed.replace(':latest', '')) return true;

            const installedBase = installed.includes(':') ? installed.split(':')[0] : installed;
            const targetBase = target.includes(':') ? target.split(':')[0] : target;

            if (installedBase === targetBase) return true;

            const installedSimple = installedBase.includes('/') ? installedBase.split('/')[1] : installedBase;
            const targetSimple = targetBase.includes('/') ? targetBase.split('/')[1] : targetBase;

            return installedSimple === targetSimple && installedSimple !== '';
          });

          let downloadProgress: number | undefined;
          if (!isDownloaded && pullingModels.has(model.id)) {
            downloadProgress = pullingModels.get(model.id)?.percent;
          }

          statusMap[model.id] = { isDownloaded, downloadProgress };
        });
      } else {
        const downloadMgr = ModelDownloadManager.getInstance();

        // 处理 Llama.cpp 模型
        await Promise.all(models.map(async (model: any) => {
          let isDownloaded = false;
          let downloadProgress: number | undefined;

          let taskStatus: string | undefined;
          try {
            const status = await downloadMgr.checkModelDownloadStatus(model.id);
            isDownloaded = !!(status as any).isDownloaded;

            const downloadTask = await downloadMgr.getModelTask(model.id);
            if (downloadTask) {
              taskStatus = downloadTask.status;
              if (taskStatus === 'downloading' || taskStatus === 'pending' || taskStatus === 'error') {
                downloadProgress = downloadTask.percent !== undefined ? downloadTask.percent : 0;
              }
            }
          } catch { /* ignore */ }

          statusMap[model.id] = { isDownloaded, downloadProgress, status: taskStatus };
        }));
      }
    } catch (e) {
      logger.error(LogCategory.LLAMA_MODEL_MANAGER, `[checkModelsStatus] 扫描模型安装状态失败:`, e);
    }

    return statusMap;
  }

  /**
   * 获取多模态模型配置（包含主模型路径和投影路径）
   */
  async getMultiModalModelConfig(modelId: string): Promise<{
    modelPath: string;
    mmprojPath?: string;
    isMultiModal: boolean;
  } | null> {
    if (!modelId) return null;

    try {
      const resolution = await unifiedModelManager.resolveModelPaths(modelId);
      if (!resolution) {
        logger.warn(LogCategory.LLAMA_MODEL_MANAGER, `无法解析模型路径: ${modelId}`);
        return null;
      }

      return {
        modelPath: resolution.modelPath,
        mmprojPath: resolution.mmprojPath,
        isMultiModal: !!resolution.mmprojPath
      };
    } catch (e) {
      logger.error(LogCategory.LLAMA_MODEL_MANAGER, `扫描多模态配置出错: ${modelId}`, e);
      return null;
    }
  }

  async getModelPath(modelId: string): Promise<string | null> {
    const resolution = await unifiedModelManager.resolveModelPaths(modelId);
    return resolution?.modelPath || null;
  }

  private async findGgufFileRecursive(dir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      // 1. 先在当前层级找
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.gguf') && !entry.name.toLowerCase().includes('mmproj')) {
          return path.join(dir, entry.name);
        }
      }
      
      // 2. 递归子目录
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const found = await this.findGgufFileRecursive(path.join(dir, entry.name));
          if (found) return found;
        }
      }
    } catch (e) {
      logger.error(LogCategory.LLAMA_MODEL_MANAGER, `查找 GGUF 文件出错: ${dir}`, e);
    }
    return null;
  }

  async deleteModel(modelId: string): Promise<void> {
    try {
      // 自动回退逻辑：如果删除的是当前选中的模型，自动切换回内置模型
      // 放在删除之前执行，有助于释放可能存在的文件锁（特别是 Windows 平台）
      const orchestrator = ConfigOrchestrator.getInstance();
      const currentSelectedModel = orchestrator.getValue<string>('SELECTED_MODEL_ID');
      
      if (currentSelectedModel === modelId) {
        const builtinModelId = unifiedModelManager.getBuiltinModelId();
        logger.info(LogCategory.LLAMA_MODEL_MANAGER, `正在删除当前激活模型 ${modelId}，自动回退到内置模型: ${builtinModelId}`);
        await orchestrator.updateValue('SELECTED_MODEL_ID', builtinModelId);
        
        // 给引擎一点时间响应配置变更并释放文件
        if (process.platform === 'win32') {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const llamaEngine = LlamaEngineService.getInstance();
      const filePath = await llamaEngine.resolveModelPath(modelId);
      const repoDir = unifiedModelManager.getModelDirectory(modelId);

      if (!filePath) {
        logger.warn(LogCategory.LLAMA_MODEL_MANAGER, `无法解析模型文件路径，尝试直接删除目录: ${modelId}`);
        await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
      } else {
        // 1. 删除具体的文件
        await fs.unlink(filePath).catch((e) => {
          logger.error(LogCategory.LLAMA_MODEL_MANAGER, `删除模型文件失败: ${filePath}`, e);
        });
        logger.info(LogCategory.LLAMA_MODEL_MANAGER, `已删除模型文件: ${filePath}`);

        // 2. 检查所属 Repo 目录下是否还有其它量化版本 (.gguf)
        let hasOtherQuantizations = false;
        const snapshotsDir = path.join(repoDir, 'snapshots');
        
        try {
          const snapshotsExist = await fs.stat(snapshotsDir).then(s => s.isDirectory()).catch(() => false);
          if (snapshotsExist) {
            const snapshots = await fs.readdir(snapshotsDir);
            for (const snapshot of snapshots) {
              const snapshotPath = path.join(snapshotsDir, snapshot);
              const stat = await fs.stat(snapshotPath).catch(() => null);
              if (stat?.isDirectory()) {
                const contents = await fs.readdir(snapshotPath);
                // 检查是否还有其它 .gguf 文件 (且不是刚才删掉的那个路径，虽然 unlink 已经删了)
                if (contents.some(name => name.toLowerCase().endsWith('.gguf'))) {
                  hasOtherQuantizations = true;
                  break;
                }
              }
            }
          } else {
            // 如果不是标准 snapshots 结构，检查 repoDir根目录
            const rootFiles = await fs.readdir(repoDir).catch(() => []);
            if (rootFiles.some(f => f.toLowerCase().endsWith('.gguf'))) {
              hasOtherQuantizations = true;
            }
          }
        } catch (e) {
          logger.error(LogCategory.LLAMA_MODEL_MANAGER, `检查残留模型文件时出错: ${repoDir}`, e);
        }

        // 3. 如果没有其它版本了，彻底删除整个 Repo 目录 (包含 blobs, refs 等)
        if (!hasOtherQuantizations) {
          logger.info(LogCategory.LLAMA_MODEL_MANAGER, `未发现其它量化版本，正在彻底删除仓库目录: ${repoDir}`);
          await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
        } else {
          logger.info(LogCategory.LLAMA_MODEL_MANAGER, `仍有其它量化版本存在，保留仓库结构。`);
        }
      }

      this.emitModelEvent(ModelEvent.MODEL_DELETED, { modelId });
    } catch (error) {
      throw new Error(t('删除模型失败: {error}', { error: String(error) }));
    }
  }

  private emitModelEvent(event: ModelEvent, data: IModelEventData): void {
    this.emit(event, data);
    BrowserWindow.getAllWindows().forEach(win => { win.webContents.send(`model-${event}`, data); });
  }

  // 接口适配占位
  async getModelInfo(id: string) { return (await this.listModels()).find(m => m.id === id) || null; }
  async validateModel(id: string): Promise<IModelValidationResult> { return { isValid: true, modelId: id, validatedFiles: [], missingFiles: [], corruptedFiles: [], errors: [], warnings: [] }; }
  async recommendModelsByHardware(m?: number, g?: boolean, v?: number) { const s = await this.listModels(); return { recommendedModels: s.filter(x => x.isRecommended).map(x => x.id), reasons: {} }; }
  async recommendModelsByFileType(t: string) { return []; }
  async setCurrentModel(id: string) {
    const orchestrator = ConfigOrchestrator.getInstance();
    const platform = orchestrator.getValue<string>('AI_ENGINE') || 'llama.cpp';
    
    let isDownloaded = false;
    if (platform === 'ollama') {
      try {
        isDownloaded = await ollamaService.checkModelInstalled(id);
      } catch (e) {
        logger.error(LogCategory.LLAMA_MODEL_MANAGER, `检查 Ollama 模型安装状态失败: ${id}`, e);
      }
    } else {
      try {
        const downloadMgr = ModelDownloadManager.getInstance();
        const status = await downloadMgr.checkModelDownloadStatus(id);
        isDownloaded = !!status.isDownloaded;
      } catch (e) {
        logger.error(LogCategory.LLAMA_MODEL_MANAGER, `检查 Llama 模型下载状态失败: ${id}`, e);
      }
    }

    if (!isDownloaded) {
      logger.warn(LogCategory.LLAMA_MODEL_MANAGER, `模型尚未下载完成，无法设置为当前模型: ${id}`);
      throw new Error(t('模型尚未下载完成，无法设置为当前模型'));
    }

    await orchestrator.updateValue('SELECTED_MODEL_ID', id);
    logger.info(LogCategory.LLAMA_MODEL_MANAGER, `成功设置当前模型: ${id}`);
  }
  async getModelCapabilities(id: string) { return null; }
  async checkFileTypeSupport(id: string, ext: string) { return true; }
  async getModelStatus(id: string) { return null; }
  async getModelsByFileType(ext: string) { return []; }
  async getCapabilityLimitations(id: string, type: any) { return null; }
  getStatusBarInfo() { return null; }
  async checkFileCompatibility(ext: string) { return true; }
  async isFileTypeSupported(id: string, ext: string) { return true; }
  async getSupportedFileFormats(id: string) { return []; }
  async getMultiModalInfo(id: string) { return null; }
  async validateMultiModalAssociations(id: string) { return { isValid: true, missingFiles: [] }; }
  async supportsModality(id: string, mod: any) { return true; }
  async getSupportedModalities(id: string) { return []; }

  /**
   * 清除所有模型相关缓存
   */
  clearCache(): void {
    ModelDownloadManager.getInstance().clearCache();
    ModelConfigService.getInstance().clearCache();
    unifiedModelManager.clearCache();
    logger.info(LogCategory.LLAMA_MODEL_MANAGER, 'Llama 模型管理器缓存已清除');
  }

  /**
   * 刷新基础目录和缓存
   */
  refreshBaseDirectory(): void {
    this.clearCache();
  }
}

export const llamaModelManager = LlamaModelManager.getInstance();
