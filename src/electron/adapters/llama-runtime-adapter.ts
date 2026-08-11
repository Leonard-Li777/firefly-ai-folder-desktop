import { t } from '@app/languages'
/**
 * Llama 运行时适配器实现
 * 将 Llama 服务器 API 适配到核心引擎
 */

import { ILlamaRuntimeAdapter } from '@firefly/core-engine'
import { llamaServerService } from '@firefly/electron-llamaIndex-service'
import { modelCapabilityDetector } from '../runtime-services/llama'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { logger, LogCategory, FileCategory, isCategory } from '@firefly/shared'
import sharp from 'sharp'

/**
 * Llama 运行时适配器
 */
export class LlamaRuntimeAdapter implements ILlamaRuntimeAdapter {
  /**
   * 统一推理接口
   */
  async inference(request: {
    prompt?: string
    temperature?: number
    maxTokens?: number
    filePath?: string
    response_format?: { type: 'json_object' | 'text' }
    json_schema?: any // JSON Schema 约束
    messages?: Array<{
      role: 'system' | 'user' | 'assistant'
      content: string | Array<{ type: string; text?: string; image_url?: any; input_audio?: any }>
    }>
    signal?: AbortSignal
    disableThinking?: boolean
  }): Promise<{
    success: boolean
    response?: string
    error?: string
    processingTime?: number
  }> {
    const startTime = Date.now()

    try {
      // 获取当前模型ID
      const modelId = this.getCurrentModelId()
      if (!modelId) {
        return {
          success: false,
          error: t('没有加载的模型')
        }
      }

      // 如果有 filePath 且为图片，则根据 ADR-0007 要求处理尺寸
      let imageBuffer: Buffer | null = null
      let imageMimeType = 'image/jpeg'
      if (request.filePath && isCategory(request.filePath, FileCategory.IMAGE)) {
        try {
          const metadata = await sharp(request.filePath).metadata()
          if (metadata.format) {
            imageMimeType = `image/${metadata.format}`
          }
          if (metadata.width && metadata.width > 500) {
            imageBuffer = await sharp(request.filePath)
              .resize(500, null, { withoutEnlargement: true })
              .toBuffer()
            logger.info(
              LogCategory.AI_SERVICE,
              `[AI多模态] 图片宽度 > 500px (${metadata.width}px)，已临时 resize 到 500px`
            )
          }
        } catch (err) {
          logger.warn(LogCategory.AI_SERVICE, '[AI多模态] 图片尺寸检查/缩放失败，使用原图:', err)
        }
      }

      // 转换消息格式
      const messages = request.messages?.map(msg => {
        if (typeof msg.content === 'string') {
          return {
            role: msg.role,
            content: msg.content
          }
        } else {
          // 处理多模态内容
          const multimodalContents: any[] = []
          msg.content.forEach(item => {
            if (item.type === 'text' && item.text) {
              multimodalContents.push({
                type: 'text',
                data: item.text
              })
            } else if (item.image_url) {
              // 如果已有缩放后的 buffer，则替换原本的 image_url (如有)
              // 注意：此处假设 item.image_url 如果存在，可能是原本的文件路径或 base64
              // 但 ADR 要求在 inference 前检查尺寸，如果是图片且 > 600px 则 resize。
              // 如果 llamaServerService 支持直接传 buffer，这里可以优化。
              // 如果 item.image_url 是路径，这里可以用 base64 替换它以确保使用了 resize 后的数据。
              if (imageBuffer) {
                multimodalContents.push({
                  type: 'image',
                  data: `data:${imageMimeType};base64,${imageBuffer.toString('base64')}`
                })
              } else {
                multimodalContents.push({
                  type: 'image',
                  data: item.image_url
                })
              }
            }
          })
          return {
            role: msg.role,
            content: multimodalContents
          }
        }
      })

      const response = await llamaServerService.chatCompletion({
        model: modelId,
        messages: messages || [],
        temperature: request.temperature ?? 0.3,
        maxTokens: request.maxTokens ?? 2048,
        stream: false,
        json_schema: request.json_schema,
        response_format: request.response_format,
        disableThinking: request.disableThinking
      })

      // 提取内容
      let content = ''
      if (typeof response === 'string') {
        content = response
      } else if (response && typeof response === 'object') {
        if (
          'choices' in response &&
          Array.isArray(response.choices) &&
          response.choices.length > 0
        ) {
          const firstChoice = response.choices[0]
          if (firstChoice.message && firstChoice.message.content) {
            content =
              typeof firstChoice.message.content === 'string'
                ? firstChoice.message.content
                : JSON.stringify(firstChoice.message.content)
          }
        } else if ('content' in response) {
          content =
            typeof response.content === 'string'
              ? response.content
              : JSON.stringify(response.content)
        }
      }

      const processingTime = Date.now() - startTime

      return {
        success: true,
        response: content,
        processingTime
      }
    } catch (error) {
      const processingTime = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        processingTime
      }
    }
  }

  async sendChatRequest(request: {
    messages: Array<{
      role: 'system' | 'user' | 'assistant'
      content: string | Array<{ type: string; text?: string; image_url?: any; input_audio?: any }>
    }>
    temperature?: number
    max_tokens?: number
    stream?: boolean
  }): Promise<{
    content: string
    usage?: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
    }
  }> {
    // 获取当前模型ID
    const modelId = this.getCurrentModelId()
    if (!modelId) {
      throw new Error(t('没有加载的模型'))
    }

    // 转换消息格式
    const convertedMessages = request.messages.map(msg => {
      if (typeof msg.content === 'string') {
        return {
          role: msg.role,
          content: msg.content
        }
      } else {
        // 处理多模态内容
        const multimodalContents: any[] = []
        msg.content.forEach(item => {
          if (item.type === 'text' && item.text) {
            multimodalContents.push({
              type: 'text',
              data: item.text
            })
          } else if (item.image_url) {
            multimodalContents.push({
              type: 'image',
              data: item.image_url
            })
          }
        })
        return {
          role: msg.role,
          content: multimodalContents
        }
      }
    })

    const response = await llamaServerService.chatCompletion({
      model: modelId,
      messages: convertedMessages,
      temperature: request.temperature ?? 0.3,
      maxTokens: request.max_tokens ?? 2048,
      stream: request.stream ?? false
    })

    // 提取内容和使用情况
    let content = ''
    if (typeof response === 'string') {
      content = response
    } else if (response && typeof response === 'object') {
      // 处理不同的响应格式
      if ('choices' in response && Array.isArray(response.choices) && response.choices.length > 0) {
        const firstChoice = response.choices[0]
        if (firstChoice.message && firstChoice.message.content) {
          // 确保转换为字符串
          content =
            typeof firstChoice.message.content === 'string'
              ? firstChoice.message.content
              : JSON.stringify(firstChoice.message.content)
        }
      } else if ('content' in response) {
        content =
          typeof response.content === 'string' ? response.content : JSON.stringify(response.content)
      }
    }

    return {
      content,
      usage: (response as any)?.usage
    }
  }

  async checkRuntimeCapabilities(): Promise<{
    supportsVision: boolean
    supportsAudio: boolean
    supportsVideo: boolean
  }> {
    const capabilities = await modelCapabilityDetector.checkRuntimeCapabilities()
    return {
      supportsVision: capabilities.vision,
      supportsAudio: capabilities.audio,
      supportsVideo: capabilities.video
    }
  }

  getCurrentModelId(): string | null {
    // 从modelService获取当前加载的模型ID
    try {
      // 使用async/await异步方法获取
      const currentModelId = ConfigOrchestrator.getInstance().getValue<string>(
        'SELECTED_MODEL_ID'
      ) as string
      return currentModelId ?? null
    } catch (error) {
      logger.error(LogCategory.MODEL_SERVICE, '获取当前模型ID失败:', error)
      return null
    }
  }

  async checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    return await llamaServerService.checkHealth()
  }
}

/**
 * 创建 Llama 运行时适配器实例
 */
export function createLlamaRuntimeAdapter(): ILlamaRuntimeAdapter {
  return new LlamaRuntimeAdapter()
}
