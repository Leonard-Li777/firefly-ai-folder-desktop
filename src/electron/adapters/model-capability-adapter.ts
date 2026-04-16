/**
 * 模型能力适配器实现
 * 将模型能力检测 API 适配到核心引擎
 */

import * as path from 'path'

import { LogCategory, logger } from '@yonuc/shared'

import { IModelCapabilityAdapter } from '@yonuc/core-engine'
import { configService } from '../runtime-services/config/config-service'
import { getLlamaModelConfig } from '../model'
import { modelCapabilityDetector } from '../runtime-services/llama'

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
 * 模型能力适配器
 */
export class ModelCapabilityAdapter implements IModelCapabilityAdapter {
  async checkFileTypeSupport(fileType: string, filePath?: string): Promise<boolean> {
    try {
      // 从文件路径中提取扩展名
      const extension = filePath ? path.extname(filePath).toLowerCase().slice(1) : fileType.toLowerCase()

      // 获取当前模型ID
      const currentModelId = configService.getValue<string>('SELECTED_MODEL_ID') as string

      if (!currentModelId) {
        logger.warn(LogCategory.MODEL_CAPABILITY_ADAPTER, '没有选中的模型，无法检查文件类型支持')
        return false
      }

      // 检查文件类型支持
      const result = await modelCapabilityDetector.checkFileTypeSupport(currentModelId, extension)
      return result.supported
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '检查文件类型支持失败:', error)
      return false
    }
  }

  isMultiModalModel(modelId?: string): boolean {
    // 获取当前模型ID
    const currentModelId = modelId || configService.getValue<string>('SELECTED_MODEL_ID') as string

    if (!currentModelId) {
      logger.warn(LogCategory.MODEL_CAPABILITY_ADAPTER, '没有选中的模型，无法检查文件类型支持')
      return false
    }
    const modelConfig = getLlamaModelConfig(currentModelId)
    if (modelConfig) {
      return modelCapabilityDetector.isMultiModalModel(modelConfig)
    } else {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '检查模型多模态支持失败:')
      return false
    }
  }

  async isMultimodalFileType(fileType: string): Promise<boolean> {
    try {
      const ext = fileType.toLowerCase().replace('.', '')
      const multimodalExtensions = [
        // 图片
        'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'svg',
        // 音频
        'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a',
        // 视频
        'mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv'
      ]
      if (!multimodalExtensions.includes(ext)) {
        return false
      }
      // 从文件路径中提取扩展名
      const extension = fileType.toLowerCase()
      // 回退到默认逻辑（兼容旧代码）

      // 获取当前模型ID
      const currentModelId = configService.getValue<string>('SELECTED_MODEL_ID') as string
      if (!currentModelId) {
        logger.warn(LogCategory.MODEL_CAPABILITY_ADAPTER, '没有选中的模型，无法检查文件类型支持')
        return false
      }

      // 检查文件类型支持
      const result = await modelCapabilityDetector.checkFileTypeSupport(currentModelId, extension)
      logger.info(LogCategory.MODEL_CAPABILITY_ADAPTER, '多模态文件类型支持检查结果:', result)
      return result.supported
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '检查文件类型支持失败:', error)
      return false
    }
  }

  async checkRuntimeCapabilities(): Promise<{ supportsVision: boolean; supportsAudio: boolean }> {
    const capabilities = await modelCapabilityDetector.checkRuntimeCapabilities()
    return {
      supportsVision: capabilities.vision,
      supportsAudio: capabilities.audio
    }
  }

  clearCache(): void {
    modelCapabilityDetector.clearCache()
  }

  /**
   * 获取当前模型的上下文长度（官方声明值）
   */
  async getContextLength(): Promise<number> {
    try {
      const aiServiceMode = configService.getValue<string>('AI_SERVICE_MODE')
      
      let serviceConfig: any
      if (aiServiceMode === 'cloud') {
        const provider = configService.getValue<string>('AI_CLOUD_PROVIDER')
        const model = configService.getValue<string>('AI_CLOUD_SELECTED_MODEL_ID')
        serviceConfig = {
          mode: 'cloud',
          cloud: { provider, model },
          platform: 'cloud'
        }
      } else {
        const modelId = configService.getValue<string>('SELECTED_MODEL_ID')
        if (!modelId) return 4096
        serviceConfig = {
          mode: 'local',
          local: { modelId },
          platform: 'ollama' // Assuming local is ollama for now, or get from config
        }
      }

      const capabilities = await modelCapabilityDetector.detectCapabilities(serviceConfig)
      return capabilities.maxContextSize || 4096
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '获取上下文长度失败:', error)
      return 4096
    }
  }

  /**
   * 获取实际可用的上下文长度限制
   * 优先使用 recommendedConfig.numCtx，否则根据模型大小计算
   */
  async getActualContextLimit(): Promise<number> {
    try {
      const aiServiceMode = configService.getValue<string>('AI_SERVICE_MODE')
      
      // 云端模式：使用更大的上下文
      if (aiServiceMode === 'cloud') {
        const officialContext = await this.getContextLength()
        return Math.min(officialContext, 32768) // 云端限制为 32K
      }
      
      // 本地模式：需要更保守的限制
      const modelId = configService.getValue<string>('SELECTED_MODEL_ID')
      if (!modelId) return 4096
      
      const modelConfig = getLlamaModelConfig(modelId)
      if (!modelConfig) return 4096
      
      // 解析模型参数大小
      const paramSizeB = parseParameterSize(modelConfig.parameterSize)
      const sizeLimits = getModelSizeLimits(paramSizeB)
      
      // 优先使用 recommendedConfig.numCtx
      if (modelConfig.recommendedConfig?.numCtx) {
        const recommendedCtx = modelConfig.recommendedConfig.numCtx
        // 确保不超过模型大小限制
        const actualLimit = Math.min(recommendedCtx, sizeLimits.maxCtx)
        logger.info(LogCategory.MODEL_CAPABILITY_ADAPTER, 
          `使用推荐上下文限制: ${actualLimit} (推荐: ${recommendedCtx}, 模型限制: ${sizeLimits.maxCtx})`)
        return actualLimit
      }
      
      // 否则根据官方值和安全系数计算
      const officialContext = modelConfig.contextLength || 4096
      const calculatedLimit = Math.min(
        Math.floor(officialContext * sizeLimits.ctxSafetyFactor),
        sizeLimits.maxCtx
      )
      
      logger.info(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `计算上下文限制: ${calculatedLimit} (官方: ${officialContext}, 安全系数: ${sizeLimits.ctxSafetyFactor})`)
      
      return calculatedLimit
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '获取实际上下文限制失败:', error)
      return 4096
    }
  }

  /**
   * 获取安全的输出 token 限制 (num_predict)
   */
  async getSafeOutputLimit(): Promise<number> {
    try {
      const aiServiceMode = configService.getValue<string>('AI_SERVICE_MODE')
      
      // 云端模式：允许更大的输出
      if (aiServiceMode === 'cloud') {
        return 4096
      }
      
      // 本地模式
      const modelId = configService.getValue<string>('SELECTED_MODEL_ID')
      if (!modelId) return 2048
      
      const modelConfig = getLlamaModelConfig(modelId)
      if (!modelConfig) return 2048
      
      // 解析模型参数大小
      const paramSizeB = parseParameterSize(modelConfig.parameterSize)
      const sizeLimits = getModelSizeLimits(paramSizeB)
      
      // 优先使用 recommendedConfig.numPredict
      if (modelConfig.recommendedConfig?.numPredict) {
        const recommendedPredict = modelConfig.recommendedConfig.numPredict
        const safeLimit = Math.min(recommendedPredict, sizeLimits.maxPredict)
        logger.info(LogCategory.MODEL_CAPABILITY_ADAPTER, 
          `使用推荐输出限制: ${safeLimit} (推荐: ${recommendedPredict}, 模型限制: ${sizeLimits.maxPredict})`)
        return safeLimit
      }
      
      // 否则根据上下文限制计算（输出不超过上下文的 25%）
      const actualContextLimit = await this.getActualContextLimit()
      const calculatedLimit = Math.min(
        Math.floor(actualContextLimit * 0.25),
        sizeLimits.maxPredict
      )
      
      logger.info(LogCategory.MODEL_CAPABILITY_ADAPTER, 
        `计算输出限制: ${calculatedLimit} (上下文: ${actualContextLimit})`)
      
      return calculatedLimit
    } catch (error) {
      logger.error(LogCategory.MODEL_CAPABILITY_ADAPTER, '获取安全输出限制失败:', error)
      return 2048
    }
  }
}

/**
 * 创建模型能力适配器实例
 */
export function createModelCapabilityAdapter(): IModelCapabilityAdapter {
  return new ModelCapabilityAdapter()
}
