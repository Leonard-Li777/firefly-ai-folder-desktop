/**
 * OmniService 拓扑变更、优雅停止与视觉资产重载逻辑
 */
import { ChildProcess, spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsAsync, statOrNull } from '../../../infra/fs'
import { subscribePowerEvent } from '../../../main/power-hub'
import { Agent as UndiciAgent, Dispatcher } from 'undici'
import {
  ResourceLocator,
  logger,
  LogCategory,
  APP_PORTS,
  findAvailablePort,
  isPathEqual,
  PluginPathResolver,
  resolveActiveModelPaths,
  BUILTIN_PLUGIN_CATALOG_META,
  BuiltinSharedResourceId,
  CHILD_MODEL_ENV_KEYS_TO_PURGE,
  ServiceDiscoveryFile,
  ServiceDiscoveryFileV1,
  readReadyMarkerSync,
  isPidAlive,
  killProcessTree,
  SSE_CONNECT_TIMEOUT_MS,
  SSE_READ_WATCHDOG_MS,
  DORMANT_MAX_ATTEMPTS,
  ConnectedTargetIdentity,
  readWithWatchdog,
  sleepCancellable,
  SseWatchdogTimeoutError,
  isTestEnvironment
} from '@firefly/shared'
import { MagikaFileCategory } from '@firefly/types'
import { resolveAnalysisTimeoutBudget } from '../analysis-timeout-policy'
import {
  isConnectionRefusedError,
  isTransientStatusFetchError,
  isTransientStatusHttpCode,
  shouldForceKillBeforeRespawn,
  shouldTriggerRestartOnFetchError,
  STATUS_VERIFY_BACKOFF_MS,
  STATUS_VERIFY_MAX_ATTEMPTS,
  STATUS_VERIFY_TIMEOUT_MS
} from './mount-verify-classify'
import { isLocalDevRuntime } from '../../../main/worktree-env'
import { OmniInstanceLock, OmniTokenManager } from '../omni-security'
import { OmniPerceptionHttpError, type VisualVocabStatusTelemetry } from './types'
import type { AssetsReloadResult } from '../visual-vocab-txn'
import type {
  OmniRuntimeStatus,
  OmniBenchmarkResponse,
  PerceptionSlotResult,
  OmniExtractionResponse,
  OmniGeoReversePoint,
  OmniGeoReverseItem,
  OmniGeoReverseResponse,
  OmniPerceptionOptions,
  OmniExtractOptions,
  OmniPerceptionBenchmarkResponse,
  OmniTagChainItem,
  OmniResolveParentRequest,
  OmniResolveParentResponse,
  OmniRamTagItem,
  BinaryAnalysisInfo,
  OmniPerceptionResponse,
  OmniVideoChunkItem,
  OmniAudioTranscribeResponse,
  OmniAudioConvertResponse,
  OmniVisionTagsResponse,
  OmniVisionInspectResponse,
  OmniFsAdsResponse,
  OmniIndexedDocument,
  OmniIndexResponse,
  OmniFusedResult,
  OmniHybridSearchResponse,
  ClusteringMode,
  OmniClusterDocument,
  OmniClusterGroup,
  OmniClusterTreeResult,
  OmniClusterResponse,
  OmniHowNetSlot,
  OmniHowNetDescribeResult,
  OmniExtractedEntity,
  OmniStructuredSummary,
  OmniDocumentChunk,
  OmniTextAnalysisResult,
  InspectControlledTagItem,
  InspectControlledTagResult,
  InspectControlledTagsResponse
} from './types'
import { broadcastOmniStatus } from './helpers'
import {
  OmniStatusEvent,
  FireflyReadyFrame,
  parseOmniStatusEvent,
  parseFireflyReadyLine,
  verifyOmniSameOrigin
} from './omni-status-contract'
import {
  buildCoverUrl,
  buildExtractRequestBody,
  buildPerceiveRequestBody
} from './request-serialization'
import {
  classifyOmniCrash,
  computeNextDmlCrashMarker,
  serializeDmlCrashMarker,
  shouldForceCpuFromMarker
} from './ort-dml-crash-guard'
import {
  ServeContractCache,
  buildServeContractMismatchDetail,
  probeServeContract
} from './omni-binary-contract'
import {
  OmniService,
  type VerifyInstanceResult,
  type OmniFetchOptions,
  type OmniFetchKind,
  type LaunchContext
} from './omni-service'

/**
 * 独立视觉资产热重载入口（POST /api/v1/assets/reload），与 /api/v1/taxonomy/reload-policies 物理隔离
 */
export async function omniLauncherReloadVisualAssets(
  host: any,
  langOpt?: string
): Promise<AssetsReloadResult> {
  try {
    const lang =
      (typeof langOpt === 'string' && langOpt.trim()) ||
      host.getConfigValue('DEFAULT_LANGUAGE') ||
      ''
    const qs = lang.trim() ? `?lang=${encodeURIComponent(lang.trim())}` : ''
    const res = await host.omniFetch(`${host.baseUrl}/api/v1/assets/reload${qs}`, {
      kind: 'call',
      method: 'POST',
      timeoutMs: 15_000,
      internal: true
    })
    const json = (await res.json().catch(() => null)) as Record<string, any> | null
    if (!res.ok || json?.success === false) {
      const errMsg =
        (typeof json?.error?.message === 'string' && json.error.message) || `HTTP ${res.status}`
      return { success: false, error: errMsg }
    }
    const tagger = json?.assets?.tagger as
      | {
          status?: string
          activeStatus?: string
          activeEncoderId?: number
          byEncoder?: Record<string, any>
        }
      | undefined
    const activeEncoderId =
      typeof tagger?.activeEncoderId === 'number' ? tagger.activeEncoderId : undefined
    const resolvedActiveStatus =
      tagger?.activeStatus ??
      (activeEncoderId !== undefined
        ? tagger?.byEncoder?.[String(activeEncoderId)]?.status
        : undefined) ??
      tagger?.status
    if (resolvedActiveStatus === 'ok') {
      host.visualTaggerAvailable = true
    }

    const recoveredIds = new Set<number>()
    if (tagger?.byEncoder && typeof tagger.byEncoder === 'object') {
      for (const [k, slot] of Object.entries(tagger.byEncoder)) {
        if (slot?.status === 'ok') {
          const id = typeof slot?.encoderId === 'number' ? slot.encoderId : Number(k)
          if (Number.isInteger(id) && id > 0) {
            recoveredIds.add(id)
          }
        }
      }
    }
    if (resolvedActiveStatus === 'ok' && activeEncoderId !== undefined) {
      recoveredIds.add(activeEncoderId)
    }
    for (const encId of recoveredIds) {
      host.notifyVisualTaggerRecovered(encId)
    }

    return {
      success: true,
      activeStatus: resolvedActiveStatus,
      byEncoder: tagger?.byEncoder
    }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) }
  }
}

/**
 * 双向核验 /api/v1/engine/status 中的 mountManifest 与 visualVocab / mobileClipVocab
 */
export async function omniLauncherVerifyMountManifestStatus(
  host: any,
  expected?: {
    manifestPath: string | null
    sharedDir: string | null
    expectedResourceIds: string[]
    strict: boolean
  }
): Promise<{
  ok: boolean
  error?: string
  /** true 表示失败源于超时/网络等瞬时故障（重试耗尽），不代表挂载清单不一致 */
  transient?: boolean
  statusData?: Record<string, any>
  visualVocabStatus?: string
  visualVocab?: VisualVocabStatusTelemetry
}> {
  return host.verifyMountManifestStatusAttempt(expected, 1)
}

/**
 * 单次核验实现；瞬时故障（超时/网络/5xx/半截响应）按预算重试，
 * 确定性不一致立即返回，避免把忙碌引擎误判为清单错误。
 */
export async function omniLauncherVerifyMountManifestStatusAttempt(
  host: any,
  expected:
    | {
        manifestPath: string | null
        sharedDir: string | null
        expectedResourceIds: string[]
        strict: boolean
      }
    | undefined,
  attempt: number
): Promise<{
  ok: boolean
  error?: string
  transient?: boolean
  statusData?: Record<string, any>
  visualVocabStatus?: string
  visualVocab?: VisualVocabStatusTelemetry
}> {
  const target = expected ?? host.lastExpectedMounts
  try {
    const lang = (host.getConfigValue('DEFAULT_LANGUAGE') || '').trim()
    const qs = lang ? `?lang=${encodeURIComponent(lang)}` : ''
    const res = await host.omniFetch(`${host.baseUrl}/api/v1/engine/status${qs}`, {
      kind: 'probe',
      timeoutMs: STATUS_VERIFY_TIMEOUT_MS,
      internal: true
    })
    if (!res.ok) {
      const transient = isTransientStatusHttpCode(res.status)
      if (transient && attempt < STATUS_VERIFY_MAX_ATTEMPTS) {
        await host.sleepStatusVerifyBackoff(attempt)
        return host.verifyMountManifestStatusAttempt(expected, attempt + 1)
      }
      return {
        ok: false,
        transient,
        error: `/api/v1/engine/status 响应异常: HTTP ${res.status}`
      }
    }
    const data = (await res.json()) as Record<string, any>
    const mm = data?.mountManifest

    if (target?.manifestPath) {
      if (!mm || typeof mm !== 'object') {
        return { ok: false, error: 'Omni 未返回 mountManifest 遥测对象', statusData: data }
      }
      if (mm.strict !== true || mm.mode !== 'manifest_single_track') {
        return {
          ok: false,
          error: `Omni 未以单轨 strict 清单模式运行 (mode=${mm.mode}, strict=${mm.strict}, error=${mm.error || 'none'})`,
          statusData: data
        }
      }
      if (mm.manifestPath && !isPathEqual(mm.manifestPath, target.manifestPath)) {
        return {
          ok: false,
          error: `Omni 挂载清单路径不一致: expected=${target.manifestPath}, actual=${mm.manifestPath}`,
          statusData: data
        }
      }
      if (mm.error) {
        return { ok: false, error: `Omni 挂载清单校验报错: ${mm.error}`, statusData: data }
      }

      const actualActiveSet = new Set<string>(
        Array.isArray(mm.activeResourceIds) ? mm.activeResourceIds : []
      )
      const rejectedList = Array.isArray(mm.rejectedMounts) ? mm.rejectedMounts : []
      for (const reqId of target.expectedResourceIds) {
        const rej = rejectedList.find((r: any) => r?.resourceId === reqId)
        if (rej) {
          return {
            ok: false,
            error: `资源 ${reqId} 被 Rust 运行时门禁拒绝: ${rej.reason || '未知原因'}`,
            statusData: data
          }
        }
        if (!actualActiveSet.has(reqId)) {
          return {
            ok: false,
            error: `预期激活资源 ${reqId} 未出现在 Omni activeResourceIds 中`,
            statusData: data
          }
        }
      }

      const visualVocab = data?.visualVocab as VisualVocabStatusTelemetry | undefined
      const visualVocabStatus =
        typeof visualVocab?.activeStatus === 'string' ? visualVocab.activeStatus : undefined
      return {
        ok: true,
        statusData: data,
        visualVocabStatus,
        visualVocab
      }
    }

    const visualVocabEarly = data?.visualVocab as VisualVocabStatusTelemetry | undefined
    const visualVocabStatusEarly =
      typeof visualVocabEarly?.activeStatus === 'string' ? visualVocabEarly.activeStatus : undefined
    return {
      ok: true,
      statusData: data,
      visualVocabStatus: visualVocabStatusEarly,
      visualVocab: visualVocabEarly
    }
  } catch (err: any) {
    // 半截响应导致的 JSON 解析失败同样属于瞬时故障，应重试而非判死。
    const transient = isTransientStatusFetchError(err) || err?.name === 'SyntaxError'
    if (transient && attempt < STATUS_VERIFY_MAX_ATTEMPTS) {
      await host.sleepStatusVerifyBackoff(attempt)
      return host.verifyMountManifestStatusAttempt(expected, attempt + 1)
    }
    return {
      ok: false,
      transient,
      error: `查询 /api/v1/engine/status 异常: ${err?.message || String(err)}`
    }
  }
}

/**
 * 响应插件拓扑变更（激活、切换、卸载、后台修复完成）：
 * 重启 Omni 刷新单轨清单并执行真实能力探活；失败即抛出异常以触发上层状态/Epoch 回滚
 */
export async function omniLauncherHandleTopologyChanged(
  host: any,
  opts: {
    moduleId?: string
    reason: string
    restartPolicy: 'restart' | 'ensure-running' | 'none'
  }
): Promise<void> {
  if (!host.managedLifecycleActive || opts.restartPolicy === 'none') {
    return
  }

  let ok = false
  if (opts.restartPolicy === 'ensure-running' && !host.process) {
    const alive = await host.checkHealth().catch(() => false)
    ok = alive ? true : await host.start()
  } else {
    ok = await host.restart()
  }

  if (!ok) {
    throw new Error(host.lastMountValidationError || 'Omni 引擎重启或单轨挂载清单双向校验失败')
  }

  // 针对主动切换/激活的独占能力执行实时健康冒烟验证（防止仅进程存活而推理链断链）
  const isActivationCheck = opts.reason === 'module_change' && Boolean(opts.moduleId)
  if (!isActivationCheck || !opts.moduleId) {
    return
  }

  if (opts.moduleId === 'engine_classic_light' || opts.moduleId === 'engine_gemma_unified') {
    const profile = opts.moduleId === 'engine_gemma_unified' ? 'gemma_unified' : 'classic_light'
    const smoke = await host.runSmokeTest({ profile })
    if (!smoke.success) {
      const err = new Error(smoke.error || `向量底座 ${opts.moduleId} 激活冒烟失败`)
      if (smoke.errorCode) {
        ;(err as any).code = smoke.errorCode
      }
      throw err
    }
  } else if (opts.moduleId === 'tts_moss_onnx' || opts.moduleId === 'tts_m5_onnx') {
    const expectedEngine = opts.moduleId === 'tts_m5_onnx' ? 'express-voice-24k' : 'clone-voice-48k'
    const hibernationTargetId = opts.moduleId === 'tts_m5_onnx' ? 'tts-m5-onnx' : 'tts-moss-onnx'

    // 1. 先探活 /api/audio/tts/status 确认挂载路由激活且模型包已安装 (installed)
    const statusDeadline = Date.now() + 5_000
    let lastError = ''
    let installedOrReady = false

    while (Date.now() < statusDeadline) {
      try {
        const statusRes = await host.omniFetch(`${host.baseUrl}/api/audio/tts/status`, {
          kind: 'probe',
          timeoutMs: 2000,
          internal: true
        })
        if (statusRes.ok) {
          const ttsStatus = (await statusRes.json()) as {
            ready?: boolean
            installed?: boolean
            total_voices?: number
            engine?: string
          }
          const engineMatched = ttsStatus.engine === expectedEngine
          const hasCapability =
            ttsStatus.installed === true ||
            ttsStatus.ready === true ||
            (ttsStatus.installed === undefined && (ttsStatus.total_voices ?? 0) > 0)
          if (engineMatched && hasCapability) {
            installedOrReady = true
            break
          }
          lastError = `ready=${Boolean(ttsStatus?.ready)}, installed=${String(ttsStatus?.installed)}, engine=${ttsStatus?.engine || 'none'}`
        } else {
          lastError = `HTTP ${statusRes.status}`
        }
      } catch (err: any) {
        lastError = err?.message || String(err)
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }

    if (!installedOrReady) {
      throw new Error(`TTS 引擎挂载验证未通过 (expected=${expectedEngine}, details: ${lastError})`)
    }

    // 2. 冒烟正式接入统一休眠协调器（懒加载模式下经 withHibernationGate 按需激活会话并确认 ready）
    try {
      const [{ moduleHibernationCoordinator }, { engineBridgeService }] = await Promise.all([
        import('../../hibernation/module-hibernation-coordinator'),
        import('../../engine-bridge')
      ])
      moduleHibernationCoordinator.setOmniLifecycleProvider(host)
      if (!moduleHibernationCoordinator.getEngineBridgeService()) {
        moduleHibernationCoordinator.setEngineBridgeService(engineBridgeService)
      }
      moduleHibernationCoordinator.forceResetExternalHibernated(
        hibernationTargetId,
        host.getGeneration()
      )
      await moduleHibernationCoordinator.withHibernationGate(
        {
          targetId: hibernationTargetId,
          clusterId: 'tts_media',
          livenessSourceKey: 'task_progress'
        },
        async () => {
          const statusRes = await host.omniFetch(`${host.baseUrl}/api/audio/tts/status`, {
            kind: 'probe',
            timeoutMs: 3000,
            internal: true
          })
          if (!statusRes.ok) {
            throw new Error(`HTTP ${statusRes.status}`)
          }
          const ttsStatus = (await statusRes.json()) as {
            ready?: boolean
            engine?: string
          }
          if (!ttsStatus?.ready || ttsStatus.engine !== expectedEngine) {
            throw new Error(
              `ready=${Boolean(ttsStatus?.ready)}, engine=${ttsStatus?.engine || 'none'}`
            )
          }
        }
      )
    } catch (smokeErr: any) {
      throw new Error(
        `TTS 引擎协调器冒烟未通过 (expected=${expectedEngine}, details: ${smokeErr?.message || String(smokeErr)})`
      )
    }
  }
}

/**
 * 两阶段停机协议：同步段先捕获身份并断开 SSE / watcher -> SIGTERM 优雅落盘（<=1.5s）-> taskkill /T /F + SIGKILL -> 按 pid/instanceId 撤销发现文件
 */
export async function omniLauncherStop(host: any): Promise<void> {
  // 并发重入合并：若已有停机流程在途，直接复用同一 Promise，防止后发空 stop() 覆盖 stopPromise 并提前复位 isIntentionalStopping
  if (host.stopPromise) {
    return host.stopPromise
  }

  // 同步段：先局部捕获 childPid 与 lastInstanceId，再清空连接状态并递增代际
  const child = host.process
  const childPid = child?.pid
  const lastInstanceId =
    host.connectedTarget?.instanceId || host.expectedIdentity?.instanceId || undefined

  host.isIntentionalStopping = true
  host.isStarting = false
  if (host.currentLaunchCtx && host.currentLaunchCtx.child === child) {
    host.currentLaunchCtx.intentionalKill = true
  }
  ++host.stopEpoch
  ++host.connectionEpoch
  host.stopController.abort()
  host.unmountDiscoveryWatcher()
  host.eventStreamAbortController?.abort()
  host.reconnectAbortController?.abort()
  host.activeLoopEpoch = null
  host.cachedVersion = null
  host.connectedTarget = null
  host.expectedIdentity = null
  host.lastVerifiedAtMs = 0
  host.unhealthySince = null
  host.lastFailureAt = null
  host.lastStatusEvent = null

  const nextGen = ++host.currentGeneration
  host.emitLifecycleInactive(nextGen)

  if (host.restartTimeout) {
    clearTimeout(host.restartTimeout)
    host.restartTimeout = null
  }
  const manifestToCleanup = host.currentMountManifestPath
  host.currentMountManifestPath = null

  const runAsyncStop = async (): Promise<void> => {
    try {
      if (child) {
        const pid = child.pid
        host.process = null
        try {
          const { processReaper } = require('../../../main/process-reaper')
          processReaper.unregisterChild(pid)
        } catch {}

        const waitChildClose = new Promise<void>(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
            return
          }
          const onDone = () => resolve()
          child.once('close', onDone)
          child.once('exit', onDone)
        })

        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM')
          }
        } catch {}

        await Promise.race([
          waitChildClose,
          new Promise<void>(resolve => setTimeout(resolve, 1500))
        ])

        if (child.exitCode === null && child.signalCode === null) {
          host.forceKillProcessTree(child, 'stop_graceful_timeout')
          await Promise.race([
            waitChildClose,
            new Promise<void>(resolve => setTimeout(resolve, 2000))
          ])
        }
      }

      if (childPid) {
        await host.getDiscoveryFile()?.revoke({ pid: childPid, instanceId: lastInstanceId })
      }

      if (host.instanceLock) {
        host.instanceLock.release()
        host.instanceLock = null
      }
      if (host.tokenManager) {
        host.tokenManager.removeToken()
        host.tokenManager = null
      }
      host.unlinkManifestSafe(manifestToCleanup)
      await host.waitForPortReleased(3000)
      // 主动推送"未运行"状态至渲染进程（基础AI引擎 Footer 展示）
      broadcastOmniStatus({ running: false, version: null })
    } finally {
      host.isIntentionalStopping = false
    }
  }

  const p = runAsyncStop()
  host.stopPromise = p
  try {
    await p
  } finally {
    if (host.stopPromise === p) {
      host.stopPromise = null
    }
  }
}
