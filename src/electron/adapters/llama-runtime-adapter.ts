import { t } from '@app/languages'
/**
 * Llama 运行时适配器实现
 * 将 Llama 服务器 API 适配到核心引擎
 */

import { ILlamaRuntimeAdapter } from '@yonuc/core-engine'
import { llamaServerService } from '@yonuc/electron-llamaIndex-service'
import { modelCapabilityDetector } from '../runtime-services/llama'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { logger, LogCategory } from '@yonuc/shared'

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
    json_schema?: any  // JSON Schema 约束
    messages?: Array<{
      role: 'system' | 'user' | 'assistant'
      content: string | Array<{ type: string; text?: string; image_url?: any; input_audio?: any }>
    }>
    signal?: AbortSignal
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
          error: t('没有加载的模型'),
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
        messages: messages || [],
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens ?? 2048,
        stream: false,
        json_schema: request.json_schema,
        response_format: request.response_format,
      })

      // 提取内容
      let content = ''
      if (typeof response === 'string') {
        content = response
      } else if (response && typeof response === 'object') {
        if ('choices' in response && Array.isArray(response.choices) && response.choices.length > 0) {
          const firstChoice = response.choices[0]
          if (firstChoice.message && firstChoice.message.content) {
            content = typeof firstChoice.message.content === 'string'
              ? firstChoice.message.content
              : JSON.stringify(firstChoice.message.content)
          }
        } else if ('content' in response) {
          content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content)
        }
      }

      const processingTime = Date.now() - startTime

      return {
        success: true,
        response: content,
        processingTime,
      }
    } catch (error) {
      const processingTime = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        processingTime,
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
      temperature: request.temperature ?? 0.7,
      maxTokens: request.max_tokens ?? 2048,
      stream: request.stream ?? false,
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
          content = typeof firstChoice.message.content === 'string'
            ? firstChoice.message.content
            : JSON.stringify(firstChoice.message.content)
        }
      } else if ('content' in response) {
        content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content)
      }
    }

    return {
      content,
      usage: (response as any)?.usage,
    }
  }


  async checkRuntimeCapabilities(): Promise<{
    supportsVision: boolean
    supportsAudio: boolean
  }> {
    const capabilities = await modelCapabilityDetector.checkRuntimeCapabilities()
    return {
      supportsVision: capabilities.vision,
      supportsAudio: capabilities.audio
    }
  }

  getCurrentModelId(): string | null {
    // 从modelService获取当前加载的模型ID
    try {
      // 使用async/await异步方法获取
      const currentModelId = ConfigOrchestrator.getInstance().getValue<string>('SELECTED_MODEL_ID') as string
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

