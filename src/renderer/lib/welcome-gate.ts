/**
 * 欢迎向导完成度强校验门禁
 *
 * 确保在未完成全部欢迎向导流程（语言选择 + 基础 AI 引擎装配）前，
 * 任何离线授权失效、页面刷新或冷重启都不会跳过欢迎向导或被授权弹窗取代。
 */

export interface WelcomeGateConfig {
  languageConfirmed?: boolean
  isFirstRun?: boolean
}

export interface WelcomeGateModuleLike {
  id?: string
  capability_slot?: string
  install_state?: string
  state?: string
}

export type WelcomeGateDecision =
  | { completed: true }
  | {
      completed: false
      step: 1 | 2
      reason:
        | 'force_config_stage'
        | 'language_unconfirmed'
        | 'base_engine_missing'
        | 'first_run_incomplete'
    }

/**
 * 判断模块记录是否为已安装且可用的基础 AI 引擎
 */
export function isInstalledBaseEngineModule(mod: WelcomeGateModuleLike | null | undefined): boolean {
  if (!mod) return false
  const isBaseSlot =
    mod.capability_slot === 'base_embedding' ||
    mod.capability_slot === 'base_ai_engine' ||
    mod.id === 'engine_classic_light' ||
    mod.id === 'engine_gemma_unified'
  if (!isBaseSlot) return false

  const installState = mod.install_state ?? mod.state
  return installState === 'active' || installState === 'installed_inactive'
}

/**
 * 评估欢迎向导强门禁状态
 *
 * 1. 若尚未确认语言 -> 强制停留在 Step 1；
 * 2. 若语言已确认但未安装基础 AI 引擎，或尚未正式完成首次向导（isFirstRun !== false）
 *    -> 强制停留在 Step 2 继续完成插件装配，严禁擅自将 IS_FIRST_RUN 翻转为 false。
 */
export function resolveWelcomeGateState(params: {
  config: WelcomeGateConfig
  installedModules?: WelcomeGateModuleLike[] | null
  ignoreFirstRunFlag?: boolean
  forceConfigStage?: boolean
}): WelcomeGateDecision {
  const { config, installedModules, ignoreFirstRunFlag = false, forceConfigStage = false } = params
  const languageConfirmed = config.languageConfirmed ?? false
  const isFirstRun = config.isFirstRun ?? true

  if (forceConfigStage) {
    return {
      completed: false,
      step: languageConfirmed ? 2 : 1,
      reason: 'force_config_stage'
    }
  }

  if (!languageConfirmed) {
    return {
      completed: false,
      step: 1,
      reason: 'language_unconfirmed'
    }
  }

  const hasInstalledBaseEngine = Array.isArray(installedModules)
    ? installedModules.some(isInstalledBaseEngineModule)
    : !isFirstRun

  if (!hasInstalledBaseEngine) {
    return {
      completed: false,
      step: 2,
      reason: 'base_engine_missing'
    }
  }

  if (!ignoreFirstRunFlag && isFirstRun) {
    return {
      completed: false,
      step: 2,
      reason: 'first_run_incomplete'
    }
  }

  return { completed: true }
}
