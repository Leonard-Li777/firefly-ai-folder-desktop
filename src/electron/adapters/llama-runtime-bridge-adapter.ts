/**
 * Llama运行时桥接适配器
 * 将新的IAIAdapter接口桥接到旧的ILlamaRuntimeAdapter接口
 */

import type { ILlamaRuntimeAdapter } from '@yonuc/core-engine'
import type { IAIAdapter, IAIInferenceRequest } from '@yonuc/types'

/**
 * 桥接适配器类
 * 将IAIAdapter适配到ILlamaRuntimeAdapter接口
 */
export class LlamaRuntimeBridgeAdapter implements ILlamaRuntimeAdapter {
  constructor(private aiAdapter: IAIAdapter) {}

  /**
   * 统一推理接口
   * 将ILlamaRuntimeAdapter的inference调用转换为IAIAdapter的inference调用
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
    try {
      // 构建IAIInferenceRequest
      const aiRequest: IAIInferenceRequest = {
        prompt: request.prompt || '',
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        filePath: request.filePath,
        response_format: request.response_format,
        json_schema: request.json_schema,  // 透传 json_schema
        messages: request.messages as any, // 类型兼容转换
        signal: request.signal
      }

      // 调用底层IAIAdapter
      const response = await this.aiAdapter.inference(aiRequest)
      
      return {
        success: response.success,
        response: response.response,
        error: response.error,
        processingTime: response.processingTime
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 检查服务健康状态
   */
  async checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    return await this.aiAdapter.checkHealth()
  }
}