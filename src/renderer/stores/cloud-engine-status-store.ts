/**
 * 云端引擎状态（PRD-0045）
 *
 * 会话级状态面：已启动粘性位、探针态、错误卡数据、模型列表已拉取位。
 * 与配置列表 store 分离——本 store 只描述「引擎状态徽章/错误卡」所需的运行态。
 */
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { logger, LogCategory } from '@firefly/shared'

/** 错误卡失败阶段 */
export type CloudErrorStage = 'fetch-models' | 'chat-probe' | 'analyze'

export interface CloudEngineErrorInfo {
  /** ISO 时间 */
  at: string
  provider: string
  model: string
  stage: CloudErrorStage
  message: string
}

export type CloudProbeState = 'idle' | 'probing' | 'success' | 'error'

export interface ICloudEngineStatusState {
  /** 轻量请求有回应（粘性；配置改坏/引擎异常时熄灭） */
  cloudStarted: boolean
  /** 探针进行中 */
  cloudProbeState: CloudProbeState
  /** 错误卡数据；null = 收起 */
  cloudLastError: CloudEngineErrorInfo | null
  /**
   * 引擎异常位：仅生效引擎=云端 时的自动探针/分析抛错会置位。
   * 手动点测失败只写 cloudLastError，不置位（PRD-0045 Q12 A）。
   */
  cloudEngineFailed: boolean
  /** 已成功拉取模型列表（已连接严格条件之一） */
  cloudModelsFetched: boolean
}

export interface ICloudEngineStatusActions {
  /** 探针/分析成功：点亮已启动并可计入模型列表 */
  markStarted: (opts?: { modelsFetched?: boolean }) => void
  /** 已成功拉取模型列表（即使尚未启动） */
  markModelsFetched: () => void
  /** 配置改坏：熄灭已启动，回落未连接 */
  extinguishForInvalidConfig: () => void
  /** 进入探针中 */
  beginProbe: () => void
  /**
   * 探针/分析失败。
   * @param asActiveEngine 仅当生效引擎=云端 时写入错误并进入引擎异常
   */
  markFailed: (info: Omit<CloudEngineErrorInfo, 'at'>, opts: { asActiveEngine: boolean }) => void
  /** 手动或成功后清除错误 */
  clearCloudError: () => void
  /** 切走云端不清错误；仅重置探针中状态 */
  resetProbeOnly: () => void
}

export type TCloudEngineStatusStore = ICloudEngineStatusState & ICloudEngineStatusActions

const initialState: ICloudEngineStatusState = {
  cloudStarted: false,
  cloudProbeState: 'idle',
  cloudLastError: null,
  cloudEngineFailed: false,
  cloudModelsFetched: false
}

export const useCloudEngineStatusStore = create<TCloudEngineStatusStore>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,

    markStarted: opts => {
      logger.debug(LogCategory.RENDERER, '[CloudEngineStatus] 已启动点亮')
      set({
        cloudStarted: true,
        cloudProbeState: 'success',
        cloudLastError: null,
        cloudEngineFailed: false,
        cloudModelsFetched: opts?.modelsFetched ? true : get().cloudModelsFetched
      })
    },

    markModelsFetched: () => {
      set({ cloudModelsFetched: true })
    },

    extinguishForInvalidConfig: () => {
      logger.info(LogCategory.RENDERER, '[CloudEngineStatus] 配置失效，熄灭已启动')
      set({ cloudStarted: false, cloudModelsFetched: false, cloudEngineFailed: false })
    },

    beginProbe: () => {
      set({ cloudProbeState: 'probing' })
    },

    markFailed: (info, opts) => {
      const at = new Date().toISOString()
      if (!opts.asActiveEngine) {
        // 非生效链路的手动点测失败：只进错误卡，不改徽章语义位
        logger.warn(LogCategory.RENDERER, '[CloudEngineStatus] 手动点测失败（非生效链路）:', info.message)
        set({ cloudLastError: { ...info, at }, cloudProbeState: 'error' })
        return
      }
      logger.warn(LogCategory.RENDERER, '[CloudEngineStatus] 引擎异常:', info.message)
      set({
        cloudStarted: false,
        cloudEngineFailed: true,
        cloudLastError: { ...info, at },
        cloudProbeState: 'error'
      })
    },

    clearCloudError: () => {
      set({
        cloudLastError: null,
        cloudEngineFailed: false,
        cloudProbeState: get().cloudProbeState === 'error' ? 'idle' : get().cloudProbeState
      })
    },

    resetProbeOnly: () => {
      if (get().cloudProbeState === 'probing') {
        set({ cloudProbeState: 'idle' })
      }
    }
  }))
)

/** 派生：云端「已连接」严格条件 = 已拉取模型列表 且 已选定模型 */
export function isCloudStrictConnected(modelsFetched: boolean, modelSelected: boolean): boolean {
  return modelsFetched && modelSelected
}
