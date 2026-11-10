import React from 'react'
import { InterfaceSettings } from './interface-settings'
import { AIEngineConfigSettings } from './ai-engine-config-settings'
import { TTSSettings } from './tts-settings'
import { M5TTSSettings } from './m5-tts-settings'
import { AnalysisIgnoreRulesSettings } from './analysis-ignore-rules-settings'
import { BasicAIEngineTab } from './workspace/BasicAIEngineTab'
import { ContentExtractionTab } from './workspace/ContentExtractionTab'
import { WorkspaceAdmissionRulesTab } from './workspace/WorkspaceAdmissionRulesTab'
import { WorkspaceMaintenanceTab } from './workspace/WorkspaceMaintenanceTab'
import { ExternalApiSettingsTab } from './external-api-settings'
import { usePluginCenterStore } from '../../stores/plugin-center-store'

/**
 * TTS 统一自适应动态分派容器
 * 依据当前激活的插件自适应渲染 M5-TTS (无克隆) 或 Moss-TTS (有克隆)
 */
export const TTSDynamicContainerSettings: React.FC = () => {
  const modules = usePluginCenterStore(s => s.modules)
  const activeTts = modules.find(
    m =>
      (m.capability_slot === 'voice_tts' || m.id === 'tts_moss_onnx' || m.id === 'tts_m5_onnx') &&
      m.install_state === 'active'
  )
  if (!activeTts) {
    return null
  }
  if (activeTts.id === 'tts_m5_onnx') {
    return React.createElement(M5TTSSettings)
  }
  return React.createElement(TTSSettings)
}

/**
 * 静态白名单组件映射表 (SETTINGS_COMPONENT_MAP)
 * 严格杜绝从插件外部或动态代码加载组件，防范 XSS 注入风险 (Ticket 05 / Spec §5.2)
 */
export const SETTINGS_COMPONENT_MAP: Record<string, React.ComponentType<any>> = {
  interface: InterfaceSettings,
  ai_engine_config: AIEngineConfigSettings,
  tts: TTSDynamicContainerSettings,
  tts_moss: TTSSettings,
  tts_m5: M5TTSSettings,
  analysis_ignore_rules: AnalysisIgnoreRulesSettings,
  external_api: ExternalApiSettingsTab,
  basic_ai_engine: BasicAIEngineTab,
  content_extraction: ContentExtractionTab,
  workspace_admission_rules: WorkspaceAdmissionRulesTab,
  workspace_maintenance: WorkspaceMaintenanceTab
}
