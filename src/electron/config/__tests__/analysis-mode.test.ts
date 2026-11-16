import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  default: {
    app: {
      getPath: vi.fn(() => 'D:/mock-path'),
      getName: vi.fn(() => 'desktop'),
      getVersion: vi.fn(() => '1.0.0')
    },
    ipcMain: { on: vi.fn(), handle: vi.fn() }
  },
  app: {
    getPath: vi.fn(() => 'D:/mock-path'),
    getName: vi.fn(() => 'desktop'),
    getVersion: vi.fn(() => '1.0.0')
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('electron-conf', () => {
  return {
    Conf: class {
      get() {
        return undefined
      }
      set() {}
      onDidChange() {}
    }
  }
})

import {
  resolveEffectiveAnalysisMode,
  isAiStageEnabled,
  isAnalysisComplete,
  type AnalysisMode
} from '../analysis-mode'
import { ConfigOrchestrator } from '../config-orchestrator'

describe('resolveEffectiveAnalysisMode: 能力感知型分析模式收敛', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('当 hasInstalledAiEngine === false 时，强制将高级模式收敛为 simple', () => {
    vi.spyOn(ConfigOrchestrator.getInstance(), 'getValue').mockImplementation((key: string) => {
      if (key === 'AI_SERVICE_MODE') return 'local'
      if (key === 'ANALYSIS_MODE') return 'full'
      return undefined
    })

    const effective = resolveEffectiveAnalysisMode(false)
    expect(effective).toBe('simple')
    expect(isAiStageEnabled(effective)).toBe(false)
    expect(isAnalysisComplete(2, effective)).toBe(true)
  })

  it('当 hasInstalledAiEngine === false 且原配置为 quick_name 时，同样收敛为 simple', () => {
    vi.spyOn(ConfigOrchestrator.getInstance(), 'getValue').mockImplementation((key: string) => {
      if (key === 'AI_SERVICE_MODE') return 'local'
      if (key === 'ANALYSIS_MODE') return 'quick_name'
      return undefined
    })

    const effective = resolveEffectiveAnalysisMode(false)
    expect(effective).toBe('simple')
    expect(isAiStageEnabled(effective)).toBe(false)
  })

  it('当 hasInstalledAiEngine === true 时，保持配置的高级模式', () => {
    vi.spyOn(ConfigOrchestrator.getInstance(), 'getValue').mockImplementation((key: string) => {
      if (key === 'AI_SERVICE_MODE') return 'local'
      if (key === 'ANALYSIS_MODE') return 'full'
      return undefined
    })

    const effective = resolveEffectiveAnalysisMode(true)
    expect(effective).toBe('full')
    expect(isAiStageEnabled(effective)).toBe(true)
  })

  it('当 hasInstalledAiEngine === undefined 时，保持配置的模式', () => {
    vi.spyOn(ConfigOrchestrator.getInstance(), 'getValue').mockImplementation((key: string) => {
      if (key === 'AI_SERVICE_MODE') return 'local'
      if (key === 'ANALYSIS_MODE') return 'quick_name'
      return undefined
    })

    const effective = resolveEffectiveAnalysisMode(undefined)
    expect(effective).toBe('quick_name')
    expect(isAiStageEnabled(effective)).toBe(true)
  })

  it('当配置本身即为 simple 时，无论 hasInstalledAiEngine 状态为何均恒为 simple', () => {
    vi.spyOn(ConfigOrchestrator.getInstance(), 'getValue').mockImplementation((key: string) => {
      if (key === 'AI_SERVICE_MODE') return 'local'
      if (key === 'ANALYSIS_MODE') return 'simple'
      return undefined
    })

    expect(resolveEffectiveAnalysisMode(true)).toBe('simple')
    expect(resolveEffectiveAnalysisMode(false)).toBe('simple')
  })
})
