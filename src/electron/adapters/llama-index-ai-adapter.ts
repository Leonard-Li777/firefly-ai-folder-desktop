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
import { logger, LogCategory, FileCategory, isCategory, getMimeTypeByExtension } from '@yonuc/shared'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { audioConverter } from '../runtime-services/filesystem/audio-converter'
import { JSONParser } from '@yonuc/core-engine'
import { t } from '@app/languages'
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
  private llamaIndexService: ILlamaIndexAIService | null = null
  capabilityAdapter!: IModelCapabilityAdapter

  constructor(llamaIndexService?: ILlamaIndexAIService) {
    // 优先使用传入的实例，否则尝试获取单例（允许为 null）
    this.llamaIndexService = llamaIndexService || LlamaIndexAIService.getInstance()

    if (logger) {
      logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] LlamaIndex AI适配器已创建')
    }
  }

  /**
   * 获取内部 AI 服务实例（支持动态获取）
   */
  private getService(): ILlamaIndexAIService {
    if (!this.llamaIndexService) {
      this.llamaIndexService = LlamaIndexAIService.getInstance()
    }
    
    if (!this.llamaIndexService) {
      logger.error(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] AI服务尚未初始化，无法执行操作')
      throw new Error(t('AI服务未就绪，请稍后重试'))
    }
    
    return this.llamaIndexService
  }

  /**
   * AI推理接口实现
   * 将Core Engine的推理请求适配到LlamaIndexAIService
   */
  async inference(request: IAIInferenceRequest): Promise<IAIInferenceResponse> {
    try {
      const service = this.getService()
      const startTime = Date.now()
      let messages: AIChatMessage[] = []
      // ... (省略部分逻辑以匹配上下文，实际应用中会包含原有推理逻辑)

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
        const aiEngine = configOrchestrator.getValue<string>('AI_ENGINE')
        const isOllama = aiEngine === 'ollama'

        try {
          if (isCategory(request.filePath, FileCategory.IMAGE)) {
            let buffer: Buffer

            try {
              const normalizedPath = path.resolve(request.filePath)
              const image = nativeImage.createFromPath(normalizedPath)
              
              if (image.isEmpty()) {
                throw new Error('nativeImage returned empty image')
              }

              const { width, height } = image.getSize()

              // 统一转换为 JPEG 格式以确保模型兼容性
              // 如果尺寸过大，则进行缩放
              if ((width > 800 || height > 800) && typeof (nativeImage as any).createThumbnailFromPath === 'function') {
                const resizedImage = await (nativeImage as any).createThumbnailFromPath(normalizedPath, { width: 800, height: 800 })
                buffer = resizedImage.toJPEG(80)
              } else if (width > 800 || height > 800) {
                // 使用 sharp 调整大图尺寸并转换
                buffer = await sharp(normalizedPath)
                  .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                  .jpeg({ quality: 80 })
                  .toBuffer()
              } else {
                // 即使不缩放，也强制通过 sharp 转换为 JPEG
                buffer = await sharp(normalizedPath)
                  .jpeg({ quality: 90 })
                  .toBuffer()
              }
            } catch (imgError) {
              const errMsg = imgError instanceof Error ? imgError.message : String(imgError)
              logger.warn(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] Native处理图片失败，尝试直接使用sharp:', errMsg)
              const normalizedPath = path.resolve(request.filePath)
              buffer = await sharp(normalizedPath)
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer()
            }

            mediaPart = {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` }
            }
          } else if (isCategory(request.filePath, FileCategory.VIDEO)) {
            const buffer = await fs.readFile(request.filePath)
            mediaPart = {
              type: 'video_url',
              video_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` }
            }
          } else if (isCategory(request.filePath, FileCategory.AUDIO)) {
            // 统一音频处理：所有音频格式（包括 ape, flac 等）都统一转换为标准 WAV
            logger.info(LogCategory.AI_SERVICE, `[LlamaIndexAIAdapter] 开始将音频转换为标准格式: ${request.filePath}`)
            const startTimeConv = Date.now()
            const standardWavPath = await audioConverter.convertToStandard(request.filePath)
            const buffer = await fs.readFile(standardWavPath)
            const audioBase64 = buffer.toString('base64')
            logger.info(LogCategory.AI_SERVICE, `[LlamaIndexAIAdapter] 音频转换完成，耗时: ${Date.now() - startTimeConv}ms`)

            if (isOllama) {
              // 针对 Ollama 的特殊音频处理：放入 images 字段
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
            } else {
              // 非 Ollama 引擎（如 llama-server 或 Cloud）使用标准数据 URL
              mediaPart = {
                type: 'audio_url',
                audio_url: { url: `data:audio/wav;base64,${audioBase64}` }
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
          // 判断是否为多模态文件
          const isMultimodalFile = isCategory(request.filePath || '', FileCategory.IMAGE) || 
                                 isCategory(request.filePath || '', FileCategory.AUDIO) || 
                                 isCategory(request.filePath || '', FileCategory.VIDEO)
          
          if (isMultimodalFile) {
            // 多模态文件处理失败应该抛出错误，而非静默忽略
            logger.error(LogCategory.AI_SERVICE, `[LlamaIndexAIAdapter] 多模态文件处理失败 (${ext}):`, errorMsg)
            throw new Error(t('处理多模态文件失败 [{filePath}]: {errorMsg}', {filePath: request.filePath, errorMsg}))
          } else {
            // 其他文件类型可以静默忽略（如文本文件等）
            logger.warn(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 读取或处理文件失败，忽略文件内容:', errorMsg)
          }
        }
      }

      const response = await service.chat(messages, false, {
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        response_format: request.response_format,
        json_schema: request.json_schema,
        signal: request.signal  // 透传中止信号，支持取消请求
      })
      const processingTime = Date.now() - startTime
      // 创建副本以避免修改原始引用
      // logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 原始响应:', response)

      // 提取响应文本
      let rawResponseText = ""
      if (typeof response.message === 'string') {
        rawResponseText = response.message
      } else if (response.message && typeof response.message === 'object' && 'content' in response.message) {
        const content = (response.message as { content: string | Array<{ text?: string }> }).content
        if (typeof content === 'string') {
          rawResponseText = content
        } else if (Array.isArray(content)) {
          rawResponseText = content.map(c => c.text || "").join(" ")
        }
      }

      // 统一使用 JSONParser 处理 <think> 标签并提取 JSON 字符串
      // 注意：这里我们只需要清理后的字符串
      const responseText = JSONParser.parse(rawResponseText)

      logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] AI推理完成 (预览):', responseText)
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
    return getMimeTypeByExtension(ext)
  }

  /**
   * 健康检查接口实现
   */
  async checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    try {
      logger.debug(LogCategory.AI_SERVICE, '[LlamaIndexAIAdapter] 执行健康检查')

      const service = this.getService()
      const healthy = await service.healthCheck()

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