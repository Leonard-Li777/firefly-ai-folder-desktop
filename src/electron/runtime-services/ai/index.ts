/**
 * AI 服务模块导出
 */

// Ollama 服务
export { OllamaService, ollamaService, OllamaStatus, OllamaEvent } from './ollama-service'
export type { OllamaModelConfig } from './ollama-service'

// 平台适配器工厂
export { AIEngineFactory } from './adapters/ai-engine-factory'
