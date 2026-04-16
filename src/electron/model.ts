import * as os from 'os';
import {
  ILlamaModelConfig,
  IModelCapability,
  IModelFile,
  IDownloadSource,
  IHardwareRequirements,
  IModelPerformance,
  TModelCapabilityType,
  TModelQuality,
  TModelPerformance
} from '@yonuc/types/model-manager';
import { ModelConfigService } from './runtime-services/analysis/model-config-service';

/**
 * 模型配置类型 - 导出以供其他模块使用
 */
export type ModelConfig = ILlamaModelConfig;

/**
 * 根据硬件配置推荐模型
 * @param memoryGB 可用内存(GB)
 * @param hasGPU 是否有GPU支持
 * @param vramGB 显存大小(GB，可选)
 * @returns 推荐的模型ID数组，按推荐优先级排序
 */
export function recommendModelByHardware(memoryGB: number, hasGPU = false, vramGB?: number): string[] {
  const modelConfigs = ModelConfigService.getInstance().loadModelConfig();

  // 1. 筛选 Qwen3.5 系列模型
  const qwen35Models = modelConfigs.filter(model => 
    model.id.toLowerCase().includes('qwen3.5') || 
    model.name.toLowerCase().includes('qwen3.5')
  );

  if (qwen35Models.length === 0) {
    // 如果没有 Qwen3.5 模型，退回到原来的逻辑（保持兼容性）
    if (vramGB !== undefined) {
      const maxVramForModel = vramGB * 0.75;
      const eligibleModels = modelConfigs.filter(model => {
        const modelVram = model.vramRequiredGB || model.hardwareRequirements?.minMemoryGB;
        return modelVram <= maxVramForModel;
      });
      if (eligibleModels.length > 0) {
        const sortedModels = [...eligibleModels].sort((a, b) => {
          const capabilitiesA = a.capabilities.length;
          const capabilitiesB = b.capabilities.length;
          if (capabilitiesB !== capabilitiesA) return capabilitiesB - capabilitiesA;
          return a.capabilities.reduce((sum, cap) => sum + cap.supportedFormats.length, 0) - b.capabilities.reduce((sum, cap) => sum + cap.supportedFormats.length, 0);
        });
        return [sortedModels[0].id];
      }
    }
    // 默认兜底
    return ["qwen3.5:4b"]; 
  }

  // 2. 在 Qwen3.5 系列中根据显存推荐
  if (vramGB !== undefined) {
    // 显存推荐逻辑 (针对 Qwen3.5)
    // 27B 需要约 20GB+ 显存
    // 9B 需要约 8GB+ 显存
    // 4B 需要约 4GB+ 显存
    // 2B 需要约 2GB+ 显存
    
    if (vramGB >= 22) {
      const m = qwen35Models.find(m => m.id.includes('27b'));
      if (m) return [m.id];
    }
    if (vramGB >= 10) {
      const m = qwen35Models.find(m => m.id.includes('9b'));
      if (m) return [m.id];
    }
    if (vramGB >= 6) {
      const m = qwen35Models.find(m => m.id === 'qwen3.5:4b' || m.id.includes('4b'));
      if (m) return [m.id];
    }
    // 兜底推荐 2B 或最小的 Qwen3.5
    const minModel = qwen35Models.sort((a, b) => (a.vramRequiredGB || 0) - (b.vramRequiredGB || 0))[0];
    return [minModel.id];
  }

  // 3. 基于内存的推荐 (针对 Qwen3.5)
  if (memoryGB >= 24) {
    const m = qwen35Models.find(m => m.id.includes('27b'));
    if (m) return [m.id];
  }
  if (memoryGB >= 12) {
    const m = qwen35Models.find(m => m.id.includes('9b'));
    if (m) return [m.id];
  }
  
  const defaultM = qwen35Models.find(m => m.id === 'qwen3.5:4b' || m.id.includes('4b')) || qwen35Models[0];
  return [defaultM.id];
}

/**
 * 根据文件类型推荐模型
 * @param fileType 文件类型（文本、图像、音频、视频）
 * @returns 推荐的模型ID数组
 */
export function recommendModelByFileType(fileType: string): string[] {
  const recommendedModels: string[] = [];

  // 根据文件类型推荐最合适的模型
  switch (fileType) {
    case '文本':
    case 'TEXT':
      // 文本处理优先推荐文本能力强的模型
      recommendedModels.push("qwen3-4b");
      // recommendedModels.push("gemma-3n-e4b-q4_k_m");
      // recommendedModels.push("phi-4-mini-3.8b");
      // recommendedModels.push("llama-3.2-3b-instruct");
      recommendedModels.push("qwen3-0.6b-mlx-4bit");
      break;
    case '图像':
    case 'IMAGE':
      // 图像处理优先推荐多模态模型
      recommendedModels.push("qwen2.5-omni-7b-q4_k_m");
      recommendedModels.push("qwen2.5-omni-7b-q8_0");
      recommendedModels.push("qwen2.5-vl-7b-q2_k");
      recommendedModels.push("gemma-3-12b-q4_0-mmproj");
      recommendedModels.push("minicpm-v-4_5-q2_k");
      break;
    case '音频':
    case 'AUDIO':
      // 音频处理优先推荐多模态模型
      recommendedModels.push("qwen2.5-omni-7b-q4_k_m");
      recommendedModels.push("qwen2.5-omni-7b-q8_0");
      recommendedModels.push("minicpm-v-4_5-q2_k");
      break;
    case '视频':
    case 'VIDEO':
      // 视频处理优先推荐多模态模型
      recommendedModels.push("qwen2.5-omni-7b-q4_k_m");
      recommendedModels.push("qwen2.5-omni-7b-q8_0");
      recommendedModels.push("minicpm-v-4_5-q2_k");
      break;
    default:
      // 默认推荐平衡型模型
      recommendedModels.push("qwen2.5-omni-7b-q4_k_m");
      recommendedModels.push("qwen3-4b");
      recommendedModels.push("minicpm-v-4_5-q2_k");
  }

  return recommendedModels;
}

/**
 * 获取模型支持的文件格式
 * @param modelId 模型ID
 * @returns 支持的文件格式数组
 */
export function getSupportedFileFormats(modelId: string): string[] {
  const modelConfigs = ModelConfigService.getInstance().loadModelConfig();
  const model = modelConfigs.find(m => m.id === modelId);
  if (!model) return [];

  const formats: string[] = [];
  model.capabilities.forEach(capability => {
    formats.push(...capability.supportedFormats);
  });

  // 去重
  return [...new Set(formats)];
}

/**
 * 检查模型是否支持特定文件扩展名
 * @param modelId 模型ID
 * @param fileExtension 文件扩展名
 * @returns 是否支持
 */
export function isFileTypeSupported(modelId: string, fileExtension: string): boolean {
  const supportedFormats = getSupportedFileFormats(modelId);
  return supportedFormats.includes(fileExtension.toLowerCase());
}

/**
 * 新的 GGUF 格式模型配置缓存
 */

/**
 * 延迟加载 GGUF 格式模型配置，避免循环依赖
 */
function getLlamaModelsConfig(modelConfigs?: ILlamaModelConfig[]): ILlamaModelConfig[] {
  const configs = modelConfigs || ModelConfigService.getInstance().loadModelConfig();
  if (!configs) {
    return [];
  }
  return configs;
}

/**
 * 获取 GGUF 格式的模型配置
 * @param modelId 模型ID
 * @returns GGUF 格式的模型配置
 */
export function getLlamaModelConfig(modelId: string, modelConfigs?: ILlamaModelConfig[]): ILlamaModelConfig | null {
  return getLlamaModelsConfig(modelConfigs).find(m => m.id === modelId) || null;
}

/**
 * 获取所有 GGUF 格式的模型配置
 * @returns 所有 GGUF 格式的模型配置
 */
export function getAllLlamaModelConfigs(modelConfigs?: ILlamaModelConfig[]): ILlamaModelConfig[] {
  return getLlamaModelsConfig(modelConfigs);
}

/**
 * 根据能力类型获取支持的模型
 * @param capabilityType 能力类型
 * @returns 支持该能力的模型ID列表
 */
export function getModelsByCapability(capabilityType: TModelCapabilityType, modelConfigs?: ILlamaModelConfig[]): string[] {
  return getLlamaModelsConfig(modelConfigs)
    .filter(model => model.capabilities.some(cap => cap.type === capabilityType))
    .map(model => model.id);
}

/**
 * 检查模型是否为多模态模型
 * @param modelId 模型ID
 * @returns 是否为多模态模型
 */
export function isMultiModalModel(modelId: string, modelConfigs?: ILlamaModelConfig[]): boolean {
  const model = getLlamaModelConfig(modelId, modelConfigs);
  return model?.isMultiModal || false;
}

/**
 * 获取模型的量化类型
 * @param modelId 模型ID
 * @returns 量化类型
 */
export function getModelQuantization(modelId: string, modelConfigs?: ILlamaModelConfig[]): string | undefined {
  const model = getLlamaModelConfig(modelId, modelConfigs);
  return model?.quantization;
}

/**
 * 根据硬件配置推荐 GGUF 模型
 * @param memoryGB 可用内存(GB)
 * @param hasGPU 是否有GPU支持
 * @param vramGB 显存大小(GB，可选)
 * @returns 推荐的模型ID数组，按推荐优先级排序
 */
export function recommendLlamaModelsByHardware(memoryGB: number, hasGPU = false, vramGB?: number): string[] {
  const modelConfigs = ModelConfigService.getInstance().loadModelConfig();
  const llamaConfigs = getLlamaModelsConfig(modelConfigs);

  // 1. 筛选 Qwen3.5 系列模型
  const qwen35Models = llamaConfigs.filter(model => 
    model.id.toLowerCase().includes('qwen3.5') || 
    model.name.toLowerCase().includes('qwen3.5')
  );

  if (qwen35Models.length === 0) {
    // 如果没有 Qwen3.5 模型，退回到原来的逻辑
    if (vramGB !== undefined) {
      const maxVramForModel = vramGB * 0.75;
      const eligibleModels = llamaConfigs.filter(model => model.vramRequiredGB <= maxVramForModel);
      if (eligibleModels.length > 0) {
        const sortedModels = [...eligibleModels].sort((a, b) => {
          const capA = a.capabilities.length;
          const capB = b.capabilities.length;
          if (capB !== capA) return capB - capA;
          return b.performance.score - a.performance.score;
        });
        return [sortedModels[0].id];
      }
    }
    // 默认兜底
    return ["qwen3.5:4b"]; 
  }

  // 2. 在 Qwen3.5 系列中根据显存推荐
  if (vramGB !== undefined) {
    if (vramGB >= 22) {
      const m = qwen35Models.find(m => m.id.includes('27b'));
      if (m) return [m.id];
    }
    if (vramGB >= 10) {
      const m = qwen35Models.find(m => m.id.includes('9b'));
      if (m) return [m.id];
    }
    if (vramGB >= 6) {
      const m = qwen35Models.find(m => m.id === 'qwen3.5:4b' || m.id.includes('4b'));
      if (m) return [m.id];
    }
    const minModel = qwen35Models.sort((a, b) => (a.vramRequiredGB || 0) - (b.vramRequiredGB || 0))[0];
    return [minModel.id];
  }

  // 3. 基于内存的推荐 (针对 Qwen3.5)
  if (memoryGB >= 24) {
    const m = qwen35Models.find(m => m.id.includes('27b'));
    if (m) return [m.id];
  }
  if (memoryGB >= 12) {
    const m = qwen35Models.find(m => m.id.includes('9b'));
    if (m) return [m.id];
  }
  
  const defaultM = qwen35Models.find(m => m.id === 'qwen3.5:4b' || m.id.includes('4b')) || qwen35Models[0];
  return [defaultM.id];
}

/**
 * 根据文件类型推荐 GGUF 模型
 * @param fileType 文件类型（文本、图像、音频、视频）
 * @returns 推荐的模型ID数组
 */
export function recommendLlamaModelsByFileType(fileType: TModelCapabilityType): string[] {
  const modelConfigs = ModelConfigService.getInstance().loadModelConfig();
  return getModelsByCapability(fileType, modelConfigs)
    .sort((a, b) => {
      const modelA = getLlamaModelConfig(a, modelConfigs);
      const modelB = getLlamaModelConfig(b, modelConfigs);

      if (!modelA || !modelB) return 0;

      // 按性能评分排序
      return modelB.performance.score - modelA.performance.score;
    })
    .slice(0, 3); // 返回前3个推荐模型
}
