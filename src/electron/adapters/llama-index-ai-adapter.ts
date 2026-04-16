/**
 * LlamaIndex AI适配器
 * 实现Core Engine与AI服务的解耦，提供依赖注入机制
 * 确保Core Engine的纯净性，不直接依赖具体的AI服务实现
 */

import { nativeImage } from 'electron'
import * as fs from 'fs/promises'
import sharp from 'sharp'
import * as path from 'path'
import type {
  IAIAdapter,
  IAIInferenceRequest,
  IAIInferenceResponse,
  AIChatMessage,
  ILlamaIndexAIService
} from '@yonuc/types'
import type { ICoreEngine, IModelCapabilityAdapter } from '@yonuc/core-engine'
import { LlamaIndexAIService } from '@yonuc/electron-llamaIndex-service'
import { AIServiceAdapter, type IAIServiceAdapter, type IUnifiedAIServiceManager } from '../runtime-services/ai/ai-service-adapter'
import { logger, LogCategory } from '@yonuc/shared'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { audioConverter } from '../runtime-services/filesystem/audio-converter'
import { JSONParser } from '@yonuc/core-engine'
/**
 * LlamaIndex AI适配器接口
 * 提供Core Engine的依赖注入机制
 */
export interface ILlamaIndexAIAdapter {
  /**
   * 向Core Engine注入AI服务
   */
  injectAIService(coreEngine: ICoreEngine): void

  /**
   * 从Core Engine移除AI服务
   */
  removeAIService(coreEngine: ICoreEngine): void
}

/**
 * LlamaIndex AI适配器实现类
 * 实现IAIAdapter接口，用于Core Engine的AI推理
 */
export class LlamaIndexAIAdapter implements IAIAdapter {
  private llamaIndexService: ILlamaIndexAIService
  capabilityAdapter!: IModelCapabilityAdapter

  constructor(llamaIndexService?: ILlamaIndexAIService) {
    // 如果没有提供服务实例，获取单例实例
    this.llamaIndexService = llamaIndexService || LlamaIndexAIService.getInstance()

    if (logger) {
      logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] LlamaIndex AI适配器已创建')
    }
  }

  /**
   * AI推理接口实现
   * 将Core Engine的推理请求适配到LlamaIndexAIService
   */
  async inference(request: IAIInferenceRequest): Promise<IAIInferenceResponse> {
    try {
      const startTime = Date.now()
      let messages: AIChatMessage[] = []

      // 1. 初始化消息列表
      if (request.messages && request.messages.length > 0) {
        messages = [...request.messages]
      } else if (request.prompt) {
        // 如果没有消息但有prompt，创建默认用户消息
        messages = [{ role: 'user', content: request.prompt }]

      }
      // 创建副本以避免修改原始引用
      logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 执行AI推理:', {
        promptLength: messages.map(m => m.content).join('').length,
        hasFilePath: !!request.filePath,
        hasMessages: !!request.messages
      })

      // 2. 如果提供了文件路径，注入文件内容
      if (request.filePath) {
        const ext = request.filePath.split('.').pop()?.toLowerCase() || ''
        const mimeType = this.getMimeType(ext)
        let mediaPart: any = null

        // 检查当前平台是否为 Ollama
        const configOrchestrator = ConfigOrchestrator.getInstance()
        const aiPlatform = configOrchestrator.getValue('AI_PLATFORM')
        const isOllama = aiPlatform === 'ollama'

        try {
          // 支持的图片格式列表（与 quality-scoring-service.ts 保持一致）
          // 注意：SVG 是矢量图形，会通过 sharp 转换为位图格式
          const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'svg']
          
          if (imageExtensions.includes(ext)) {
            let buffer: Buffer

            try {
              const normalizedPath = path.resolve(request.filePath)
              const image = nativeImage.createFromPath(normalizedPath)
              
              if (image.isEmpty()) {
                throw new Error('nativeImage returned empty image')
              }

              const { width, height } = image.getSize()

              // 检查方法是否存在（某些平台或Electron版本可能不存在）
              if ((width > 800 || height > 800) && typeof (nativeImage as any).createThumbnailFromPath === 'function') {
                const resizedImage = await (nativeImage as any).createThumbnailFromPath(normalizedPath, { width: 800, height: 800 })
                buffer = resizedImage.toJPEG(80)
              } else if (width > 800 || height > 800) {
                // 回退到使用 sharp 处理大图
                logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 使用 sharp 调整大图尺寸:', normalizedPath)
                buffer = await sharp(normalizedPath)
                  .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                  .jpeg({ quality: 80 })
                  .toBuffer()
              } else {
                buffer = await fs.readFile(normalizedPath)
              }
            } catch (imgError) {
              const errMsg = imgError instanceof Error ? imgError.message : String(imgError)
              logger.warn(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] Native处理图片失败，尝试直接使用sharp:', errMsg)
              // 最后的保底手段：直接使用 sharp 处理（处理可能存在的路径/格式兼容性问题）
              const normalizedPath = path.resolve(request.filePath)
              buffer = await sharp(normalizedPath)
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer()
            }

            mediaPart = {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` }
            }
          } else if (['mp4', 'mov', 'avi'].includes(ext)) {
            const buffer = await fs.readFile(request.filePath)
            mediaPart = {
              type: 'video_url',
              video_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` }
            }
          } else if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) {
            if (isOllama) {
              // 针对 Ollama 的特殊音频处理：转换为标准 WAV 并放入 images 字段
              logger.info(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 检测到 Ollama 音频任务，开始转换为标准格式...')
              const startTimeConv = Date.now()
              const standardWavPath = await audioConverter.convertToStandard(request.filePath)
              const buffer = await fs.readFile(standardWavPath)
              const audioBase64 = buffer.toString('base64')
              logger.info(LogCategory.AI_SERVICE, `[LlamaIndexAIAdapter] 音频转换完成，耗时: ${Date.now() - startTimeConv}ms`)

              // 找到最后一条用户消息
              let lastUserMsgIndex = -1
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'user') {
                  lastUserMsgIndex = i
                  break
                }
              }

              if (lastUserMsgIndex !== -1) {
                messages[lastUserMsgIndex].images = [...(messages[lastUserMsgIndex].images || []), audioBase64]
              } else {
                messages.push({ role: 'user', content: '', images: [audioBase64] })
              }
              // 不需要 mediaPart，因为已经通过 images 字段处理了
            } else {
              const buffer = await fs.readFile(request.filePath)
              mediaPart = {
                type: 'audio_url',
                audio_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` }
              }
            }
          }

          if (mediaPart) {
            // 找到最后一条用户消息
            let lastUserMsgIndex = -1
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'user') {
                lastUserMsgIndex = i
                break
              }
            }

            if (lastUserMsgIndex !== -1) {
              const lastMsg = messages[lastUserMsgIndex]
              let newContent: any[] = []

              if (typeof lastMsg.content === 'string') {
                newContent = [{ type: 'text', text: lastMsg.content }]
              } else if (Array.isArray(lastMsg.content)) {
                newContent = [...lastMsg.content]
              }

              newContent.push(mediaPart)

              // 更新消息
              messages[lastUserMsgIndex] = {
                ...lastMsg,
                content: newContent
              }
            } else {
              // 如果没有用户消息，创建一个新的
              messages.push({
                role: 'user',
                content: [mediaPart]
              })
            }
          }
        } catch (fileError) {
          const errorMsg = fileError instanceof Error ? fileError.message : String(fileError)
          const ext = request.filePath?.split('.').pop()?.toLowerCase() || ''
          const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'svg']
          const audioExtensions = ['mp3', 'wav', 'flac', 'ogg', 'm4a']
          const videoExtensions = ['mp4', 'mov', 'avi']
          
          // 判断是否为多模态文件
          const isMultimodalFile = imageExtensions.includes(ext) || audioExtensions.includes(ext) || videoExtensions.includes(ext)
          
          if (isMultimodalFile) {
            // 多模态文件处理失败应该抛出错误，而非静默忽略
            logger.error(LogCategory.AI_SERVICE, `[LlamaIndexAIAdapter] 多模态文件处理失败 (${ext}):`, errorMsg)
            throw new Error(`处理多模态文件失败 [${request.filePath}]: ${errorMsg}`)
          } else {
            // 其他文件类型可以静默忽略（如文本文件等）
            logger.warn(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 读取或处理文件失败，忽略文件内容:', errorMsg)
          }
        }
      }

      // 调用LlamaIndexAIService进行推理
      const response = await this.llamaIndexService.chat(messages, false, {
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        response_format: request.response_format,
        signal: request.signal  // 透传中止信号，支持取消请求
      })
      const processingTime = Date.now() - startTime
      // 创建副本以避免修改原始引用
      // logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 原始响应:', response)

      // 提取响应文本
      let responseText = ""
      if (typeof response.message === 'string') {
        responseText = response.message
      } else if (response.message && typeof response.message === 'object' && 'content' in response.message) {
        const content = (response.message as { content: string | Array<{ text?: string }> }).content
        if (typeof content === 'string') {
          responseText = content
        } else if (Array.isArray(content)) {
          responseText = content.map(c => c.text || "").join(" ")
        }
      }

      // 统一使用 JSONParser 处理 <think> 标签（这是唯一处理 <think> 的地方）
      responseText = JSONParser.parse(JSONParser.cleanResponse(responseText))

      logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] AI推理完成:', responseText)
      return {
        success: response.success,
        response: responseText,
        processingTime,
        error: response.error
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] AI推理失败:', errorMessage)

      return {
        success: false,
        error: errorMessage
      }
    }
  }

  private getMimeType(ext: string): string {
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg'
      case 'png':
        return 'image/png'
      case 'webp':
        return 'image/webp'
      case 'gif':
        return 'image/gif'
      case 'bmp':
        return 'image/bmp'
      case 'tiff':
      case 'tif':
        return 'image/tiff'
      case 'svg':
        return 'image/svg+xml'
      case 'mp3':
        return 'audio/mpeg'
      case 'wav':
        return 'audio/wav'
      case 'mp4':
        return 'video/mp4'
      case 'mov':
        return 'video/quicktime'
      case 'avi':
        return 'video/x-msvideo'
      case 'txt':
        return 'text/plain'
      case 'md':
        return 'text/markdown'
      case 'json':
        return 'application/json'
      case 'pdf':
        return 'application/pdf'
      case 'doc':
        return 'application/msword'
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      case 'csv':
        return 'text/csv'
      case 'xml':
        return 'text/xml'
      default:
        return 'application/octet-stream'
    }
  }

  /**
   * 健康检查接口实现
   */
  async checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    try {
      logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 执行健康检查')

      const healthy = await this.llamaIndexService.healthCheck()

      logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 健康检查完成:', { healthy })

      return { healthy }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 健康检查失败:', errorMessage)

      return {
        healthy: false,
        error: errorMessage
      }
    }
  }
}

/**
 * Core Engine AI适配器实现类
 * 提供依赖注入机制，确保Core Engine与AI服务的解耦
 */
export class CoreEngineAIAdapter implements ILlamaIndexAIAdapter {
  private serviceAdapter: IAIServiceAdapter
  private unifiedManager: IUnifiedAIServiceManager | null = null

  constructor() {
    // 创建AI服务适配器（需求10.1: 通过AIServiceAdapter提供统一的服务接口）
    this.serviceAdapter = new AIServiceAdapter()

    if (logger) {
      logger.debug(LogCategory.AI_SERVICE, '[CoreEngineAIAdapter] Core Engine AI适配器已创建')
    }
  }

  /**
   * 向Core Engine注入AI服务
   * 实现依赖注入机制，保持Core Engine的纯净性
   */
  injectAIService(coreEngine: ICoreEngine): void {
    try {
      logger.info(LogCategory.AI_SERVICE, '[CoreEngineAIAdapter] 开始向Core Engine注入AI服务')

      // 创建统一服务管理器（需求10.3: 通过适配器模式提供一致的接口）
      this.unifiedManager = this.serviceAdapter.createUnifiedAIServiceManager()

      // 创建LlamaIndex AI适配器
      const aiService = this.serviceAdapter.getAIService()
      const llamaAdapter = new LlamaIndexAIAdapter(aiService)

      // 注入到Core Engine（需求10.2: 通过LlamaIndexAIAdapter注入AI服务，保持core-engine的纯净性）
      if ('setAIAdapter' in coreEngine && typeof (coreEngine as { setAIAdapter?: (adapter: LlamaIndexAIAdapter) => void }).setAIAdapter === 'function') {
        (coreEngine as { setAIAdapter: (adapter: LlamaIndexAIAdapter) => void }).setAIAdapter(llamaAdapter)
      } else if ('injectAIService' in coreEngine && typeof (coreEngine as { injectAIService?: (service: IUnifiedAIServiceManager) => void }).injectAIService === 'function') {
        (coreEngine as { injectAIService: (service: IUnifiedAIServiceManager) => void }).injectAIService(this.unifiedManager)
      } else {
        logger.warn(LogCategory.AI_SERVICE, '[CoreEngineAIAdapter] Core Engine不支持AI服务注入，可能需要更新接口')
      }

      logger.info(LogCategory.AI_SERVICE, '[CoreEngineAIAdapter] AI服务注入完成')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[CoreEngineAIAdapter] AI服务注入失败:', error)
      throw error
    }
  }

  /**
   * 从Core Engine移除AI服务
   */
  removeAIService(coreEngine: ICoreEngine): void {
    try {
      logger.info(LogCategory.AI_SERVICE, '[CoreEngineAIAdapter] 开始从Core Engine移除AI服务')

      // 移除AI服务
      if ('setAIAdapter' in coreEngine && typeof (coreEngine as { setAIAdapter?: (adapter: LlamaIndexAIAdapter | null) => void }).setAIAdapter === 'function') {
        (coreEngine as { setAIAdapter: (adapter: LlamaIndexAIAdapter | null) => void }).setAIAdapter(null)
      } else if ('removeAIService' in coreEngine && typeof (coreEngine as { removeAIService?: () => void }).removeAIService === 'function') {
        (coreEngine as { removeAIService: () => void }).removeAIService()
      }

      // 清理统一服务管理器
      this.unifiedManager = null

      logger.info(LogCategory.AI_SERVICE, '[CoreEngineAIAdapter] AI服务移除完成')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[CoreEngineAIAdapter] AI服务移除失败:', error)
      throw error
    }
  }

  /**
   * 获取统一服务管理器
   * 
   * @remarks 此方法仅在测试文件中使用 (adapter-pattern.test.ts)
   * 如果未来不再使用，可以考虑移除以简化接口
   */
  getUnifiedManager(): IUnifiedAIServiceManager | null {
    return this.unifiedManager
  }

  /**
   * 获取AI服务适配器
   * 
   * @remarks 此方法仅在测试文件中使用 (adapter-pattern.test.ts)
   * 如果未来不再使用，可以考虑移除以简化接口
   */
  getServiceAdapter(): IAIServiceAdapter {
    return this.serviceAdapter
  }
}