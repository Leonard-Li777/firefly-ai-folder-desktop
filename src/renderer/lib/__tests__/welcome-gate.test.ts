import { describe, it, expect } from 'vitest'
import { isInstalledBaseEngineModule, resolveWelcomeGateState } from '../welcome-gate'

describe('welcome-gate 强校验门禁测试', () => {
  it('isInstalledBaseEngineModule 仅放行已安装且可用的基础引擎槽位', () => {
    expect(
      isInstalledBaseEngineModule({
        id: 'engine_classic_light',
        capability_slot: 'base_embedding',
        install_state: 'active'
      })
    ).toBe(true)

    expect(
      isInstalledBaseEngineModule({
        id: 'engine_gemma_unified',
        capability_slot: 'base_ai_engine',
        state: 'installed_inactive'
      })
    ).toBe(true)

    expect(
      isInstalledBaseEngineModule({
        id: 'plugin_ocr',
        capability_slot: 'ocr_parser',
        install_state: 'active'
      })
    ).toBe(false)

    expect(
      isInstalledBaseEngineModule({
        id: 'engine_classic_light',
        capability_slot: 'base_embedding',
        install_state: 'not_installed'
      })
    ).toBe(false)

    expect(isInstalledBaseEngineModule(null)).toBe(false)
  })

  it('未确认语言时强制进入 Step 1', () => {
    expect(
      resolveWelcomeGateState({
        config: { languageConfirmed: false, isFirstRun: true },
        installedModules: []
      })
    ).toEqual({
      completed: false,
      step: 1,
      reason: 'language_unconfirmed'
    })
  })

  it('语言已确认但未安装基础 AI 引擎时，强制继续 Step 2（绝不跳过）', () => {
    expect(
      resolveWelcomeGateState({
        config: { languageConfirmed: true, isFirstRun: true },
        installedModules: []
      })
    ).toEqual({
      completed: false,
      step: 2,
      reason: 'base_engine_missing'
    })

    // 即使 isFirstRun 为 false，只要基础引擎丢失也要强制回到 Step 2 装配
    expect(
      resolveWelcomeGateState({
        config: { languageConfirmed: true, isFirstRun: false },
        installedModules: [{ id: 'plugin_ocr', capability_slot: 'ocr_parser', install_state: 'active' }]
      })
    ).toEqual({
      completed: false,
      step: 2,
      reason: 'base_engine_missing'
    })
  })

  it('基础 AI 引擎已安装但尚未点击向导完成（isFirstRun=true）时仍停留在 Step 2，除非 ignoreFirstRunFlag=true', () => {
    const installed = [
      { id: 'engine_classic_light', capability_slot: 'base_embedding', install_state: 'active' }
    ]

    expect(
      resolveWelcomeGateState({
        config: { languageConfirmed: true, isFirstRun: true },
        installedModules: installed
      })
    ).toEqual({
      completed: false,
      step: 2,
      reason: 'first_run_incomplete'
    })

    expect(
      resolveWelcomeGateState({
        config: { languageConfirmed: true, isFirstRun: true },
        installedModules: installed,
        ignoreFirstRunFlag: true
      })
    ).toEqual({
      completed: true
    })
  })

  it('离线环境下只要语言已确认、基础 AI 引擎已安装且正式完成向导，即可放行进入后续授权检查', () => {
    expect(
      resolveWelcomeGateState({
        config: { languageConfirmed: true, isFirstRun: false },
        installedModules: [
          { id: 'engine_gemma_unified', capability_slot: 'base_ai_engine', install_state: 'active' }
        ]
      })
    ).toEqual({
      completed: true
    })
  })
})
