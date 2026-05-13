import * as fs from 'fs';
import * as path from 'path';

import {
  DownloadStrategy,
  ModelSource,
  UnifiedModelConfig,
  UnifiedModelListConfig,
  IModelResolution
} from '@yonuc/types';
import { LogCategory, logger, ModelResolver, parseSizeToGB } from '@yonuc/shared';

import { ConfigOrchestrator } from '../../config/config-orchestrator';
import { AIEngineFactory } from '../ai/adapters/ai-engine-factory';
import { app } from 'electron';
import { llamaEngineService } from './llama-engine-service';
import { platformAdapter } from '@yonuc/electron-llamaIndex-service';

/**
 * Unified Model Manager - 统一模型管理与调度中心
 * 实现 docs/llama/unified-model-manager.md 规范
 */
export class UnifiedModelManager {
  private static instance: UnifiedModelManager;
  private models: UnifiedModelConfig[] = [];
  private lastUpdated: string = '';
  private isInitialized: boolean = false;

  private constructor() {}

  static getInstance(): UnifiedModelManager {
    if (!UnifiedModelManager.instance) {
      UnifiedModelManager.instance = new UnifiedModelManager();
    }
    return UnifiedModelManager.instance;
  }

  /**
   * 加载模型配置
   * @param configPaths 配置文件路径列表 (如 [model_zh-CN.json, ollama_zh-CN.json])
   */
  public loadConfigs(configPaths: string[]): void {
    const allModels: UnifiedModelConfig[] = [];
    
    logger.info(LogCategory.MODEL_CONFIG, `[UnifiedModelManager] 开始加载配置, 路径列表: ${JSON.stringify(configPaths)}`);

    for (const configPath of configPaths) {
      try {
        if (!fs.existsSync(configPath)) {
          logger.warn(LogCategory.MODEL_CONFIG, `[UnifiedModelManager] 配置文件物理路径不存在: ${configPath}`);
          continue;
        }

        const content = fs.readFileSync(configPath, 'utf-8');
        if (!content || content.trim() === '') {
          continue;
        }

        const config: UnifiedModelListConfig = JSON.parse(content);
        
        if (config.models && Array.isArray(config.models)) {
          allModels.push(...config.models);
          if (config.lastUpdated > this.lastUpdated) {
            this.lastUpdated = config.lastUpdated;
          }
        }
      } catch (error) {
        logger.error(LogCategory.MODEL_CONFIG, `[UnifiedModelManager] 加载配置失败: ${configPath}`, error);
      }
    }

    this.models = allModels;
    logger.info(LogCategory.MODEL_CONFIG, `[UnifiedModelManager] 成功加载 ${this.models.length} 个统一模型配置`);
  }

  /**
   * 获取所有模型列表
   */
  public getAllModels(): UnifiedModelConfig[] {
    return this.models;
  }

  /**
   * 按来源获取模型列表
   */
  public getModelsBySource(source: ModelSource): UnifiedModelConfig[] {
    return this.models.filter(m => m.source === source);
  }

  /**
   * 获取模型存储基础目录
   */
  public getModelBaseDir(): string {
    const storagePath = ConfigOrchestrator.getInstance().getValue<string>('MODEL_STORAGE_PATH');
    return storagePath ? path.resolve(String(storagePath).trim()) : path.join(app.getPath('userData'), 'models');
  }

  /**
   * 获取特定模型的存储目录
   * 封装不同来源模型（Ollama vs HuggingFace/ModelScope）的路径规范
   */
  public getModelDirectory(modelId: string): string {
    const baseDir = this.getModelBaseDir();
    const model = this.getModelById(modelId);

    // 逻辑合并自各服务实现：判断是否为 Ollama 或简单 ID 结构
    const isOllama = model?.source === 'ollama' || (!model && !modelId.includes('/'));

    if (!isOllama) {
      // 针对 llama.cpp / HF / ModelScope 模型，使用规范化结构: models--org--repo
      const repoPart = modelId.split(':')[0];
      const dirName = `models--${repoPart.replace(/\//g, '--')}`;
      return path.join(baseDir, dirName);
    }

    // Ollama 或 简单 ID 结构
    return path.join(baseDir, modelId.replace(/\//g, '_').replace(/:/g, '_'));
  }

  /**
   * 解析模型的完整物理路径（主模型、投影器、目录信息）
   * 宏观 API：一次性解决“模型在哪里”以及“有什么文件”的问题
   */
  public async resolveModelPaths(modelId: string): Promise<IModelResolution | null> {
    const baseDir = this.getModelBaseDir();
    const model = this.getModelById(modelId);
    const isOllama = model?.source === 'ollama';

    return ModelResolver.resolve(modelId, baseDir, isOllama);
  }

  /**
   * 确保配置已加载
   */
  public ensureLoaded(): void {
    if (this.isInitialized) return;
    
    this.reloadAllConfigs();
    
    // 监听 ConfigOrchestrator 的配置变化，实现热更新
    ConfigOrchestrator.getInstance().onConfigChange((changes) => {
      if (changes.LOCAL_MODEL_CONFIGS || changes.LOCAL_MODEL_CONFIGS_OLLAMA) {
        logger.info(LogCategory.MODEL_CONFIG, '[UnifiedModelManager] 检测到远程模型配置更新，正在重新加载...');
        this.reloadAllConfigs();
      }
    });

    this.isInitialized = true;
  }

  /**
   * 重新加载并合并所有来源的模型配置
   */
  private reloadAllConfigs(): void {
    // 1. 先从本地文件加载基础配置
    const language = ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN';
    const resourcesPath = platformAdapter.getExtraResourcesPath();
    
    // 兼容逻辑：检查是否存在额外的 extraResources 目录（部分打包环境可能会出现）
    let modelConfigDir = path.join(resourcesPath, 'model');
    const extraModelDir = path.join(resourcesPath, 'extraResources', 'model');
    
    if (!fs.existsSync(modelConfigDir) && fs.existsSync(extraModelDir)) {
      modelConfigDir = extraModelDir;
      logger.info(LogCategory.MODEL_CONFIG, `[UnifiedModelManager] 检测到 extraResources 嵌套目录: ${extraModelDir}`);
    }
    
    const configPaths = [
      path.join(modelConfigDir, `model_${language}.json`),
      path.join(modelConfigDir, `ollama_${language}.json`)
    ];
    
    this.loadConfigs(configPaths); // 这个方法会把文件配置写到 this.models

    // 1.1 加载并同步云端服务商配置
    this.loadAndSyncCloudProviders(resourcesPath, language);

    // 2. 从 ConfigOrchestrator 读取云端同步下来的远程配置（如果有）
    const remoteLocal = ConfigOrchestrator.getInstance().getValue<any>('LOCAL_MODEL_CONFIGS');
    const remoteOllama = ConfigOrchestrator.getInstance().getValue<any>('LOCAL_MODEL_CONFIGS_OLLAMA');

    const remoteModels: UnifiedModelConfig[] = [];
    if (remoteLocal?.models && Array.isArray(remoteLocal.models)) {
      remoteModels.push(...remoteLocal.models);
    }
    if (remoteOllama?.models && Array.isArray(remoteOllama.models)) {
      remoteModels.push(...remoteOllama.models);
    }

    // 3. 将远程配置合并到本地配置中
    if (remoteModels.length > 0) {
      const modelMap = new Map<string, UnifiedModelConfig>();
      
      // 先将本地文件加载的模型放入 Map
      for (const model of this.models) {
        modelMap.set(model.id, model);
      }

      // 将远程模型覆盖进去（以 ID 为唯一标识）
      // 云端的配置为最新，优先级最高
      for (const rm of remoteModels) {
        modelMap.set(rm.id, rm);
      }

      this.models = Array.from(modelMap.values());
      logger.info(LogCategory.MODEL_CONFIG, `[UnifiedModelManager] 与云端配置合并完成，最终模型数量: ${this.models.length}`);
    }
  }

  /**
   * 加载并同步云端服务商配置
   */
  private loadAndSyncCloudProviders(resourcesPath: string, language: string): void {
    const orchestrator = ConfigOrchestrator.getInstance();
    const configPath = path.join(resourcesPath, 'model', `providers_${language}.json`);
    
    try {
      if (!fs.existsSync(configPath)) {
        logger.warn(LogCategory.MODEL_CONFIG, `[UnifiedModelManager] 云端提供商预设文件不存在: ${configPath}`);
        return;
      }

      const content = fs.readFileSync(configPath, 'utf-8');
      const localPresets = JSON.parse(content);
      
      if (!Array.isArray(localPresets)) return;

      const configProviders = orchestrator.getValue<any[]>('CLOUD_MODEL_CONFIGS') || [];
      
      // 合并逻辑
      const merged = this.mergeCloudConfigs(localPresets, configProviders);
      
      // 写回配置中心，作为唯一源
      orchestrator.updateValue('CLOUD_MODEL_CONFIGS', merged);
      logger.info(LogCategory.MODEL_CONFIG, `[UnifiedModelManager] 成功加载并同步 ${merged.length} 个云端服务商配置`);
    } catch (error) {
      logger.error(LogCategory.MODEL_CONFIG, `[UnifiedModelManager] 加载云端提供商配置失败: ${configPath}`, error);
    }
  }

  /**
   * 合并云端预设和用户配置
   */
  private mergeCloudConfigs(presets: any[], userConfigs: any[]): any[] {
    const userMap = new Map<string, any>(userConfigs.map((c: any) => [c.id || c.provider, c]));
    const presetIds = new Set(presets.map((p: any) => p.id));
    
    const result: any[] = [];

    // 1. 处理预设列表
    presets.forEach(preset => {
      const userConfig = userMap.get(preset.id);
      if (userConfig) {
        // 合并：保留用户设置 (apiKey, baseUrl, model)，覆盖预设元数据 (name, models, capabilities)
        result.push({
          ...userConfig, // 基础用户配置
          ...preset,     // 预设元数据覆盖
          baseUrl: userConfig.baseUrl || preset.baseUrl,
          model: userConfig.model || preset.model
        });
      } else {
        result.push(preset);
      }
    });

    // 2. 添加用户自定义的服务商
    userConfigs.forEach(userConfig => {
      const id = userConfig.id || userConfig.provider;
      if (id && !presetIds.has(id)) {
        result.push(userConfig);
      }
    });

    return result
  }

  /**
   * 获取系统内置模型的 ID
   * 优先从 LOCAL_MODEL_CONFIGS 配置中查找 isBuiltin: true 的模型
   */
  public getBuiltinModelId(): string {
    const config = this.getBuiltinModelConfig();
    return config?.id || 'ggml-org/Qwen3.5-0.8B-GGUF:Q4_0';
  }

  /**
   * 获取系统内置模型的完整配置
   */
  public getBuiltinModelConfig(): UnifiedModelConfig | undefined {
    this.ensureLoaded();
    return this.models.find(m => m.isBuiltin);
  }

  /**
   * 根据 ID 获取模型配置
   */
  public getModelById(id: string): UnifiedModelConfig | undefined {
    // 这种同步调用无法等待 ensureLoaded，但绝大多数情况 listModels 已经触发了加载
    // 为了极致稳健，我们可以考虑在 startDownload 等异步入口处先 ensureLoaded
    return this.models.find(m => m.id === id);
  }

  /**
   * 核心动态逻辑：根据 totalSize 计算显存需求 (GB)
   * 公式：模型体积 * 系数 (1.15) + Context Buffer (0.5GB)
   */
  public calculateRequiredVRAM(totalSizeStr: string | undefined): number {
    const sizeInGB = parseSizeToGB(totalSizeStr);

    // 模型加载到显存通常会有一定的膨胀，且需要预留 KV Cache 空间
    const overheadFactor = 1.15; // 15% 冗余
    const contextBuffer = 0.5;   // 512MB 基础上下文占用

    const vram = sizeInGB * overheadFactor + contextBuffer;

    // 显存需求向上取整，确保显示和判定的稳健性
    return Math.ceil(vram);
  }

  /**
   * 生成下载/执行策略
   * @param modelId 模型 ID
   */
  public async getDownloadStrategy(modelId: string): Promise<DownloadStrategy> {
    const model = this.getModelById(modelId);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }

    const adapter = AIEngineFactory.getAdapter();
    const commandCtx = await adapter.buildDownloadCommand(modelId);
    
    // 如果 adapter 没有提供特定的环境变量，我们保留一些默认逻辑（如镜像设置）
    // 实际上 Ollama 不需要这些，但 Llamafile/Llamacpp 可能需要
    const env = { ...commandCtx.env };
    
    // 处理下载镜像 (仅针对 Hugging Face 来源)
    if (model.source === 'huggingface') {
      const mirror = ConfigOrchestrator.getInstance().getValue<'cn' | 'global'>('DOWNLOAD_MIRROR') || 'global';
      if (mirror === 'cn') {
        env['HF_ENDPOINT'] = 'https://hf-mirror.com';
      }
    } else if (model.source === 'modelscope') {
      env['MODEL_ENDPOINT'] = 'https://www.modelscope.cn/';
      env['HF_ENDPOINT'] = 'https://modelscope.cn';
    }

    // 设置 LLAMA_CACHE 确保下载到用户指定的模型目录
    env['LLAMA_CACHE'] = this.getModelBaseDir();

    return {
      command: commandCtx.args ? `"${commandCtx.command}" ${commandCtx.args.join(' ')}` : commandCtx.command,
      env
    };
  }

  /**
   * 清除缓存
   */
  public clearCache(): void {
    this.models = [];
    this.isInitialized = false;
    logger.info(LogCategory.MODEL_CONFIG, '[UnifiedModelManager] 缓存已清除');
  }
}

export const unifiedModelManager = UnifiedModelManager.getInstance();
