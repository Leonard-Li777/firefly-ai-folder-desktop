import { BrowserWindow, app, ipcMain, webContents } from 'electron'
import type {
  HardwareInfo,
  ModelSummary,
  IModelSummary
} from '@yonuc/types'
import { LogCategory, logger, mapInternalQualityToDisplay } from '@yonuc/shared'
import EventEmitter from 'events'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { LlamaModelManager } from './llama-model-manager'
import { unifiedModelManager } from './unified-model-manager'
import { ModelDownloadManager } from '../ai/model-download-manager'
import { hardwareDetectionService } from '../system/hardware-detection-service'
import path from 'node:path'

/**
 * Model Service - 负责模型相关的 IPC 调度和业务逻辑适配
 */
export class ModelService extends EventEmitter {
  private static instance: ModelService;

  public static getInstance(): ModelService {
    if (!ModelService.instance) {
      ModelService.instance = new ModelService();
    }
    return ModelService.instance;
  }

  private constructor() {
    super()
  }

  /**
   * 获取模型列表
   * 核心重构：直接透传 LlamaModelManager 的数据，确保 source 和 vramRequiredGB 完整
   */
  async listModels(): Promise<ModelSummary[]> {
    const internalModels = await LlamaModelManager.getInstance().listModels();
    
    // 由于 ModelSummary 现在就是 IModelSummary，这里可以直接返回，
    // 除非前端组件还需要一些特定的字段适配，但目前的定义已经统一。
    return internalModels as any as ModelSummary[];
  }

  /**
   * 检查模型状态
   */
  async checkModelsStatus() {
    return await LlamaModelManager.getInstance().checkModelsStatus()
  }

  /**
   * 获取硬件信息
   */
  async getHardwareInfo(): Promise<HardwareInfo> {
    return await hardwareDetectionService.getHardwareInfo();
  }

  /**
   * 推荐模型
   */
  async recommendModelsByHardware(memoryGB: number, hasGPU?: boolean, vramGB?: number) {
    return await LlamaModelManager.getInstance().recommendModelsByHardware(memoryGB, hasGPU, vramGB);
  }

  /**
   * 设置活跃模型
   */
  async setCurrentModel(modelId: string) {
    return await LlamaModelManager.getInstance().setCurrentModel(modelId)
  }

  /**
   * 获取内建模型 ID
   */
  getBuiltinModelId(): string {
    return unifiedModelManager.getBuiltinModelId();
  }

  /**
   * 删除模型
   */
  async deleteModel(modelId: string): Promise<boolean> {
    try {
      await LlamaModelManager.getInstance().deleteModel(modelId);
      return true
    } catch (error) {
      logger.error(LogCategory.MODEL_SERVICE, `删除模型失败: ${modelId}`, error)
      throw error
    }
  }

  /**
   * 获取模型物理路径
   */
  async getModelPath(modelId: string): Promise<string | null> {
    const { llamaEngineService } = await import('./llama-engine-service');
    return await llamaEngineService.resolveModelPath(modelId);
  }
}

export const modelService = ModelService.getInstance();
