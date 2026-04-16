/**
 * AI 服务模块导出
 */

// Ollama 服务
export { OllamaService, ollamaService, OllamaStatus, OllamaEvent } from './ollama-service'
export type { OllamaModelConfig } from './ollama-service'

// 平台配置
export { getAIPlatformConfig, getCurrentPlatform, isOllamaMode, isLlamaCppMode, clearPlatformCache, type AIPlatform } from './ai-platform'

// 导出通用类型
export type { AIPlatformConfig } from './ai-platform'
