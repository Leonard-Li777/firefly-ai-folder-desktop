import { usePluginCenterStore } from '../plugin-center-store'

/**
 * 探测当前环境是否安装并激活了 TTS 插件 (voice_tts / tts_moss_onnx / tts_m5_onnx)
 */
export function hasActiveTTSPlugin(): boolean {
  try {
    const modules = usePluginCenterStore.getState().modules
    return (modules || []).some(
      m =>
        (m.capability_slot === 'voice_tts' || m.id === 'tts_moss_onnx' || m.id === 'tts_m5_onnx') &&
        m.install_state === 'active'
    )
  } catch {
    return false
  }
}

/**
 * 获取当前激活的 TTS 插件 ID
 */
export function getActiveTTSPluginId(): 'tts_m5_onnx' | 'tts_moss_onnx' | null {
  try {
    const modules = usePluginCenterStore.getState().modules
    const active = (modules || []).find(
      m =>
        (m.capability_slot === 'voice_tts' || m.id === 'tts_moss_onnx' || m.id === 'tts_m5_onnx') &&
        m.install_state === 'active'
    )
    if (active?.id === 'tts_m5_onnx') return 'tts_m5_onnx'
    if (active?.id === 'tts_moss_onnx') return 'tts_moss_onnx'
    return null
  } catch {
    return null
  }
}

/**
 * 当前激活引擎是否支持声音克隆 (M5 专精预置极速发音人，不支持自定义音色克隆)
 */
export function isVoiceCloningSupported(): boolean {
  return getActiveTTSPluginId() === 'tts_moss_onnx'
}

