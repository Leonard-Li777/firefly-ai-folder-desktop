import '@test/mocks/electron-mock'
import { describe, it, expect } from 'vitest'
import { INFINITY, resolveEffectiveAIConfig, type WorkspaceRuntimeContext } from '@firefly/shared'
import { DEFAULT_UNBOUND_AI_CONFIG, UserTier, type WorkspaceConfigReady } from '@firefly/types'
import { resolveWorkspaceVideoDurationLimits } from '@/electron/runtime-services/analysis-queue-service/file-processor/db-analysis-state'

function makeRuntime(overrides?: Partial<WorkspaceRuntimeContext>): WorkspaceRuntimeContext {
  return {
    isGenerativeAiEnabled: true,
    globalEmbeddingProfile: 'gemma_unified',
    globalPluginStates: {
      engine_gemma_unified: 'active',
      asr_sensevoice_onnx: 'active',
      perception_nsfw: 'active'
    },
    libreOfficeInstalled: true,
    userTier: UserTier.PRO,
    tierReady: true,
    videoInferenceBackend: 'gpu',
    hardwareInfo: { gpus: [{ name: 'NVIDIA RTX 4090' }] } as any,
    ...overrides
  }
}

function makeReadyConfig(videoAnalyzeDurationSec: number): WorkspaceConfigReady {
  return {
    schemaVersion: 1,
    status: 'ready',
    policyVersion: 1,
    workflowId: 'builtin.workflow.movie-cinema',
    customExcludeRules: [],
    customIncludeRules: [],
    baseAIConfig: {
      ...DEFAULT_UNBOUND_AI_CONFIG,
      videoAnalyzeDurationSec
    },
    workflowPluginDefaults: ['asr_sensevoice_onnx', 'perception_nsfw'],
    configuredAt: 1700000000000
  }
}

describe('resolveWorkspaceVideoDurationLimits', () => {
  it('免费版或 tierReady=false 时：configuredLimitSec 保留工作区 10800s 配置供待补展示，effectiveLimitSec 严格封顶 300s', () => {
    const config = makeReadyConfig(10800)

    const freeEffective = resolveEffectiveAIConfig(
      config,
      makeRuntime({ userTier: UserTier.FREE, tierReady: true })
    )
    expect(freeEffective.effectiveParams.videoAnalyzeDurationSec).toBe(300)
    expect(freeEffective.fields.videoAnalyzeDurationSec.desiredValue).toBe(10800)
    expect(resolveWorkspaceVideoDurationLimits(freeEffective)).toEqual({
      isFreeTier: true,
      entitlementLimitSec: 300,
      configuredLimitSec: 10800,
      effectiveLimitSec: 300
    })

    const notReadyEffective = resolveEffectiveAIConfig(
      config,
      makeRuntime({ userTier: UserTier.PRO, tierReady: false })
    )
    expect(resolveWorkspaceVideoDurationLimits(notReadyEffective)).toEqual({
      isFreeTier: true,
      entitlementLimitSec: 300,
      configuredLimitSec: 10800,
      effectiveLimitSec: 300
    })

    // 竞态门禁：tierReady=false 且本地存在上次会话缓存的 Pro computedLimits 时，仍须按 safeCapMax=300 封顶
    expect(
      resolveWorkspaceVideoDurationLimits(notReadyEffective, {
        video_max_duration_seconds: INFINITY
      })
    ).toEqual({
      isFreeTier: true,
      entitlementLimitSec: 300,
      configuredLimitSec: 10800,
      effectiveLimitSec: 300
    })
  })

  it('PRO / ENTERPRISE / AGENT 就绪时：两项上限均为工作区设定 10800s，支持 computedLimits 覆盖', () => {
    const config = makeReadyConfig(10800)
    for (const tier of [UserTier.PRO, UserTier.ENTERPRISE, UserTier.AGENT]) {
      const eff = resolveEffectiveAIConfig(config, makeRuntime({ userTier: tier, tierReady: true }))
      expect(resolveWorkspaceVideoDurationLimits(eff)).toEqual({
        isFreeTier: false,
        entitlementLimitSec: INFINITY,
        configuredLimitSec: 10800,
        effectiveLimitSec: 10800
      })
      expect(
        resolveWorkspaceVideoDurationLimits(eff, { video_max_duration_seconds: 1800 })
      ).toEqual({
        isFreeTier: false,
        entitlementLimitSec: 1800,
        configuredLimitSec: 10800,
        effectiveLimitSec: 1800
      })
    }
  })

  it('纯 CPU cpu_hardware_clamp 与引擎冻结态：effectiveLimitSec 严守硬件降级 1800s 与冻结态 0s，手动覆盖仍生效', () => {
    const templateConfig = makeReadyConfig(10800)
    const cpuClamped = resolveEffectiveAIConfig(
      templateConfig,
      makeRuntime({
        userTier: UserTier.PRO,
        tierReady: true,
        videoInferenceBackend: 'cpu',
        hardwareInfo: { gpus: [] } as any
      })
    )
    expect(resolveWorkspaceVideoDurationLimits(cpuClamped)).toEqual({
      isFreeTier: false,
      entitlementLimitSec: INFINITY,
      configuredLimitSec: 10800,
      effectiveLimitSec: 1800
    })

    const cpuOverridden = resolveEffectiveAIConfig(
      {
        ...templateConfig,
        overrides: { videoAnalyzeDurationSec: 10800 }
      },
      makeRuntime({
        userTier: UserTier.PRO,
        tierReady: true,
        videoInferenceBackend: 'cpu',
        hardwareInfo: { gpus: [] } as any
      })
    )
    expect(resolveWorkspaceVideoDurationLimits(cpuOverridden)).toEqual({
      isFreeTier: false,
      entitlementLimitSec: INFINITY,
      configuredLimitSec: 10800,
      effectiveLimitSec: 10800
    })

    const frozenClassicLight = resolveEffectiveAIConfig(
      templateConfig,
      makeRuntime({
        userTier: UserTier.PRO,
        tierReady: true,
        globalEmbeddingProfile: 'classic_light'
      })
    )
    expect(resolveWorkspaceVideoDurationLimits(frozenClassicLight)).toEqual({
      isFreeTier: false,
      entitlementLimitSec: INFINITY,
      configuredLimitSec: 10800,
      effectiveLimitSec: 0
    })
  })

  it('异常、负数或越界配置/权益值安全消毒而不透传负数或 NaN', () => {
    const dirtyConfig = {
      capabilities: { videoMaxAnalyzeSec: undefined },
      effectiveParams: { videoAnalyzeDurationSec: 300 },
      fields: { videoAnalyzeDurationSec: { desiredValue: Number.NaN } }
    } as any
    expect(
      resolveWorkspaceVideoDurationLimits(dirtyConfig, {
        video_max_duration_seconds: -500
      })
    ).toEqual({
      isFreeTier: false,
      entitlementLimitSec: INFINITY,
      configuredLimitSec: 300,
      effectiveLimitSec: 300
    })

    const overMaxConfig = {
      capabilities: { videoMaxAnalyzeSec: 300 },
      effectiveParams: { videoAnalyzeDurationSec: 300 },
      fields: { videoAnalyzeDurationSec: { desiredValue: 99999 } }
    } as any
    expect(
      resolveWorkspaceVideoDurationLimits(overMaxConfig, {
        video_max_duration_seconds: Number.NaN
      })
    ).toEqual({
      isFreeTier: true,
      entitlementLimitSec: 300,
      configuredLimitSec: 10800,
      effectiveLimitSec: 300
    })
  })
})
