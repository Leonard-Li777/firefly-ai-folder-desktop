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
    // 语音识别默认不勾选：硬件探针判定内存 ≥ 8G 后由 isAsrRecommendedByHardware 自动勾上，
    // 内存不足的机器保持关闭；用户手动勾选后任何硬件回填都不得再改回未勾选
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

/**
 * ASR 语音识别的预勾选内存门槛（名义容量口径，单位 MB）。
 *
 * 口径说明：`totalMemGB` 是系统可用内存，8G 机器实测只有 7.6~7.8GB，
 * 直接拿它跟 8 比较会把所有 8G 机器误判为内存不足。
 * 因此门槛按名义容量判定，并对固件保留留出约 8% 容忍（8*1024*0.92 ≈ 7500MB）。
 */
export const ASR_MIN_NOMINAL_MEMORY_MB = 7_500

/**
 * 是否按硬件能力预勾选「语音识别与字幕提取」。
 *
 * 判定口径：内存 ≥ 8G 即满足（不再强制要求独立显卡）。
 * 语音识别模型是 int8 量化的小体量资产（~160MB），8G 内存的普通电脑即可承载，
 * 门槛过高只会让用户以为「装不了」而错过字幕提取能力。
 *
 * 该函数是向导 Step2 卡片提示与容器硬件回填的唯一事实源，严禁两处各写一套阈值。
 */
export function isAsrRecommendedByHardware(hardware: HardwareProbeResult): boolean {
  return hardware.totalMemGB >= 8 || hardware.totalMemMB >= ASR_MIN_NOMINAL_MEMORY_MB
}
