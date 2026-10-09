/**
 * @deprecated 原“分析设置”已被解构并拆分为三个独立 Tab 组件：
 * 1. ContentExtractionSettings (内容萃取设置 - content-extraction-settings.tsx)
 * 2. AdvancedAIPromptsSettings (高级AI提示词 - advanced-ai-prompts-settings.tsx)
 * 3. AnalysisIgnoreRulesSettings (AI分析忽略规则 - analysis-ignore-rules-settings.tsx)
 *
 * 为保持兼容，此处提供 ContentExtractionSettings 作为别名重导出。
 */

export { ContentExtractionSettings, ContentExtractionSettings as AnalysisSettings } from './content-extraction-settings'
export { default } from './content-extraction-settings'
