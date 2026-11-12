/**
 * 欢迎向导跨步骤共享的领域类型。
 *
 * 5 步向导把「选择」与「安装」彻底拆开：Step2（能力）/ Step3（目录）/
 * Step4（获取方式）只负责收集选择，Step5 才真正执行安装或导入。
 * 因此选择结果必须提升到 WelcomeWizard 共享状态，不能随某个步骤组件卸载而丢失。
 * installMethod 在 Step4 才确定，Step5 据此切换「在线进度条 / 离线选包按钮」两种展示态。
 */

/** 插件获取方式：联网在线下载，或导入事先准备好的官方离线总包 */
export type WelcomeInstallMethod = 'online' | 'offline'

export type WelcomeEngineId = 'engine_classic_light' | 'engine_gemma_unified'

export type WelcomeGenerativeMode = 'cpu' | 'local' | 'cloud'

export interface HardwareProbeResult {
  totalMemGB: number
  totalMemMB: number
  gpuName: string
  vramGB: number
  isGpuSupported: boolean
  storageFreeGB: number
}

export interface WelcomeSelection {
  installMethod: WelcomeInstallMethod
  selectedEngine: WelcomeEngineId
  selectedOptionals: Record<string, boolean>
  generativeEngineMode: WelcomeGenerativeMode
}

export const DEFAULT_WELCOME_SELECTION: WelcomeSelection = {
  installMethod: 'online',
  selectedEngine: 'engine_gemma_unified',
  selectedOptionals: {
    perception_nsfw: true,
    asr_sensevoice_onnx: false,
    // 欢迎向导的「离线语音朗读」恒为单一插件，不提供二选一；插件中心不受影响
    tts_m5_onnx: true
  },
  generativeEngineMode: 'cpu'
}

export const DEFAULT_HARDWARE: HardwareProbeResult = {
  totalMemGB: 16,
  totalMemMB: 16384,
  gpuName: '检测中...',
  vramGB: 0,
  isGpuSupported: false,
  storageFreeGB: 50
}
