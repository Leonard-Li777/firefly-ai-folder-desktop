import React from 'react'
import { InterfaceSettings } from './interface-settings'
import { AIEngineConfigSettings } from './ai-engine-config-settings'
import { TTSSettings } from './tts-settings'
import { AnalysisIgnoreRulesSettings } from './analysis-ignore-rules-settings'
import { BasicAIEngineTab } from './workspace/BasicAIEngineTab'
import { ContentExtractionTab } from './workspace/ContentExtractionTab'
import { WorkspaceAdmissionRulesTab } from './workspace/WorkspaceAdmissionRulesTab'
import { WorkspaceMaintenanceTab } from './workspace/WorkspaceMaintenanceTab'
import { ExternalApiSettingsTab } from './external-api-settings'

/**
 * 静态白名单组件映射表 (SETTINGS_COMPONENT_MAP)
 * 严格杜绝从插件外部或动态代码加载组件，防范 XSS 注入风险 (Ticket 05 / Spec §5.2)
 */
export const SETTINGS_COMPONENT_MAP: Record<string, React.ComponentType<any>> = {
  interface: InterfaceSettings,
  ai_engine_config: AIEngineConfigSettings,
  tts: TTSSettings,
  analysis_ignore_rules: AnalysisIgnoreRulesSettings,
  external_api: ExternalApiSettingsTab,
  basic_ai_engine: BasicAIEngineTab,
  content_extraction: ContentExtractionTab,
  workspace_admission_rules: WorkspaceAdmissionRulesTab,
  workspace_maintenance: WorkspaceMaintenanceTab
}
