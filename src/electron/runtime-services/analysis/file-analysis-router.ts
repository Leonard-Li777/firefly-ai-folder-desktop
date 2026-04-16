import { ILlamaModelConfig } from '@yonuc/types'
import { t } from '@app/languages'
import { ModelConfigService } from './model-config-service'

/**
 * 文件分析路由器
 * 根据模型能力和文件类型选择合适的分析模式和提示词
 */
export class FileAnalysisRouter {
  private static instance: FileAnalysisRouter
  private modelConfigService: ModelConfigService

  private constructor() {
    this.modelConfigService = ModelConfigService.getInstance()
  }

  static getInstance(): FileAnalysisRouter {
    if (!FileAnalysisRouter.instance) {
      FileAnalysisRouter.instance = new FileAnalysisRouter()
    }
    return FileAnalysisRouter.instance
  }

  /**
   * 根据模型配置获取文件的多模态类型分类
   * 仅用于区分是否需要多模态分析（图像、音频、视频）
   * 
   * @param model 模型配置
   * @param fileExtension 文件扩展名
   * @returns 多模态类型：'image' | 'audio' | 'video' | null（表示非多模态或不支持）
   */
  private getMultimodalFileType(model: ILlamaModelConfig, fileExtension: string): 'image' | 'audio' | 'video' | null {
    const ext = fileExtension.toLowerCase().replace(/^\./, '')

    if (!model.capabilities || !Array.isArray(model.capabilities)) {
      return null
    }

    // 检查模型支持的各类型格式
    for (const capability of model.capabilities) {
      if (!capability.supportedFormats || !Array.isArray(capability.supportedFormats)) {
        continue
      }

      const supportedFormats = capability.supportedFormats.map((f: string) => f.toLowerCase())

      // 统一使用原始常量进行比较
      if ((capability.type === 'IMAGE' || capability.type === t('图像')) && supportedFormats.includes(ext)) {
        return 'image'
      }
      if ((capability.type === 'AUDIO' || capability.type === t('音频')) && supportedFormats.includes(ext)) {
        return 'audio'
      }
      if ((capability.type === 'VIDEO' || capability.type === t('视频')) && supportedFormats.includes(ext)) {
        return 'video'
      }
    }

    return null
  }

  /**
   * 检查模型是否支持文件类型
   */
  supportsFileType(model: ILlamaModelConfig, fileExtension: string): boolean {
    const supportedFormats = this.modelConfigService.getModelSupportedFormats(model)
    const cleanExt = fileExtension.toLowerCase().replace(/^\./, '')
    return supportedFormats.includes(cleanExt)
  }

  /**
   * 检查模型是否支持多模态
   */
  isMultiModalModel(model: ILlamaModelConfig): boolean {
    return this.modelConfigService.isMultiModalModel(model)
  }

  /**
   * 选择分析模式（用于第二阶段质量评分）
   * 
   * 逻辑说明：
   * - 所有模型都支持文本分析（content已在第一阶段提取）
   * - 仅多模态类型（图像、音频、视频）需要判断模型是否支持
   * - 如果模型支持该类型的多模态分析，使用 'multimodal'，否则降级为 'text-only'
   * 
   * @param model 模型配置
   * @param fileExtension 文件扩展名
   * @returns 分析模式: 'multimodal' | 'text-only'
   */
  selectAnalysisMode(model: ILlamaModelConfig, fileExtension: string): 'multimodal' | 'text-only' {
    // 检查是否为多模态类型（图像、音频、视频）
    const multimodalType = this.getMultimodalFileType(model, fileExtension)

    // 如果是多模态类型且模型支持，使用多模态分析
    if (multimodalType !== null) {
      return 'multimodal'
    }

    // 否则使用文本分析（所有文件的content已在第一阶段提取）
    return 'text-only'
  }

  /**
   * 判断文件是否需要多模态分析
   * 根据模型配置和文件类型判断
   * 
   * @param model 模型配置
   * @param fileExtension 文件扩展名
   * @returns true 表示需要多模态分析，false 表示使用文本分析
   */
  isMultimodalFileType(model: ILlamaModelConfig, fileExtension: string): boolean {
    return this.getMultimodalFileType(model, fileExtension) !== null
  }
}

