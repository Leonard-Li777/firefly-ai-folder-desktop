/**
 * OmniService 进程启动编排、挂载清单校验与停止重启逻辑
 * （由 omni-service.ts 拆分而来，保持原运行时行为与类型契约）
 */
/**
 * Omni Native Service - Omni Rust 原生微服务管理器
 * （class 主体按职责块原样搬移；types/helpers 已抽至同目录子文件）
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

export async function omniLauncherDoStart(host: any): Promise<boolean> {
  if (host.isIntentionalStopping) {
    return false
  }
  if (host.stopPromise) {
    await host.stopPromise.catch(() => {})
  }
  if (host.isIntentionalStopping) {
    return false
  }
  // 若存在上一代已退出或被强杀但 stderr 尚未排空的托管 LaunchContext，先等待其 closeDeferred（最多 2000ms）
  // 确保崩溃归因与 .omni-dml-crash.json 落盘完成后再决定本次是否需要 OMNI_DISABLE_DML=1
  const prevCtx = host.currentLaunchCtx
  if (
    prevCtx &&
    !prevCtx.closed &&
    (prevCtx.child.exitCode !== null ||
      prevCtx.child.signalCode !== null ||
      prevCtx.intentionalKill)
  ) {
    await host.awaitLaunchContextClose(prevCtx)
  }

  if (host.stopController.signal.aborted) {
    host.stopController = new AbortController()
  }
  host.mountDiscoveryWatcher()
  host.consecutiveFailures = 0
  host.lastAppliedRevision = 0
  host.lastAppliedInstanceId = null
  host.managedLifecycleActive = true
  host.isStarting = true
  host.lastMountValidationError = null

  try {
    // 缺失冷却检查：避免每个文件都触发一次 resolveOmniExecutable 的遍历
    if (host.missingBinaryRetryAt > Date.now()) {
      logger.debug(
        LogCategory.SYSTEM,
        '[OmniService] firefly-omni 二进制仍处于缺失冷却期，跳过本次拉起'
      )
      return false
    }
    // 契约不兼容冷却检查：旧版/错版构件已被确定性拒绝，冷却期内不再重复探测与拉起
    if (host.incompatibleBinaryRetryAt > Date.now()) {
      logger.debug(
        LogCategory.SYSTEM,
        '[OmniService] firefly-omni 构件 CLI 契约不兼容冷却中，跳过本次拉起'
      )
      return false
    }

    // 契约预检后再拉起：旧版二进制（仅 `-a/--addr`）在 clap 解析阶段即以退出码 2 自杀，
    // 盲目 spawn 只会把确定性失败伪装成崩溃并耗尽重试次数（2026-11-26 事故形态）。
    const resolution = await host.resolveContractCompatibleExecutable()
    const exePath = resolution.exePath
    if (!exePath && resolution.contractMismatch) {
      host.incompatibleBinaryRetryAt = Date.now() + (OmniService as any).BINARY_CONTRACT_RETRY_MS
      host.lastMountValidationError = resolution.contractMismatch
      if (!host.incompatibleBinaryReported) {
        host.incompatibleBinaryReported = true
        logger.error(
          LogCategory.SYSTEM,
          `[OmniService] ❌ 检索式引擎组件版本过旧，已阻止拉起（未做无效重启）。\n${resolution.contractMismatch}`
        )
      } else {
        logger.debug(
          LogCategory.SYSTEM,
          '[OmniService] 引擎组件 CLI 契约仍不兼容，冷却期内跳过拉起'
        )
      }
      return false
    }
    if (!exePath) {
      host.missingBinaryRetryAt = Date.now() + 60_000
      if (!host.missingBinaryReported) {
        host.missingBinaryReported = true
        logger.error(
          LogCategory.SYSTEM,
          `[OmniService] ❌ 未找到 firefly-omni 可执行二进制文件，基础AI引擎无法启动，分析能力将降级。${host.describeBinarySearch()}`
        )
      } else {
        logger.debug(LogCategory.SYSTEM, '[OmniService] firefly-omni 二进制仍缺失，跳过本次拉起')
      }
      host.notifyBinaryMissing()
      return false
    }
    // 二进制重新出现（如用户修复安装 / 从杀软隔离区恢复）后复位上报与冷却状态
    host.missingBinaryReported = false
    host.missingBinaryRetryAt = 0
    host.binaryMissingNotified = false
    host.binaryMissingNotifyDeferred = false

    // 获取业务主库 SQLite 绝对路径，用于 Worktree 隔离校验 (ADR-0035 & ADR-0038)
    const { databaseService } = await import('../../database/database-service')
    const dbPath = databaseService.getDbPath()
    const expectedVectorsDir = dbPath ? path.join(path.dirname(dbPath), 'vectors') : null
    const userDataDir = host.resolveUserDataDir()
    host.expectedMasterDbPath = dbPath || null
    host.expectedVectorsDir = expectedVectorsDir

    const verifyOpts = {
      timeoutMs: (OmniService as any).PROBE_DEFAULT_TIMEOUT_MS,
      internal: true,
      userDataDir,
      masterDbPath: dbPath || null,
      targetVectorsDir: expectedVectorsDir
    }

    const completeAdoption = async (
      targetPort: number,
      verifiedData: Record<string, any> | undefined,
      headerInstanceId: string | null | undefined,
      opts: {
        isReuseAdoption: boolean
        matchedFromDiscovery: boolean
        discovered: ServiceDiscoveryFileV1 | null
        df: ServiceDiscoveryFile | null
      }
    ): Promise<boolean> => {
      const prevInstanceId =
        host.expectedIdentity?.instanceId ?? host.connectedTarget?.instanceId ?? null
      const adoptedPid =
        typeof verifiedData?.pid === 'number'
          ? verifiedData.pid
          : opts.isReuseAdoption
            ? opts.discovered?.pid
            : host.process?.pid
      const adoptedInstanceId = host.resolveAdoptedInstanceId(
        verifiedData,
        headerInstanceId,
        targetPort,
        opts.discovered?.instanceId
      )
      const isSameExternalInstance =
        opts.isReuseAdoption && Boolean(prevInstanceId && prevInstanceId === adoptedInstanceId)
      const version =
        typeof verifiedData?.version === 'string' && verifiedData.version
          ? verifiedData.version
          : null
      host.applyAdoptedInstanceIdentity({
        port: targetPort,
        pid: adoptedPid,
        instanceId: adoptedInstanceId,
        version
      })

      // 仅当发现文件缺失且通过验证采纳外部未写盘实例时回填发现文件
      if (
        !opts.matchedFromDiscovery &&
        opts.df &&
        !opts.discovered &&
        adoptedPid &&
        adoptedInstanceId
      ) {
        void opts.df
          .publish({
            instanceId: adoptedInstanceId,
            revision: typeof verifiedData?.revision === 'number' ? verifiedData.revision : 1,
            host: '127.0.0.1',
            port: targetPort,
            pid: adoptedPid,
            startedAt: new Date().toISOString(),
            userDataDir: userDataDir || undefined,
            capabilities: [],
            masterDbPath: dbPath || undefined,
            targetVectorsDir: expectedVectorsDir || undefined
          })
          .catch(() => {})
      }
      logger.info(
        LogCategory.SYSTEM,
        `[OmniService] 成功匹配并复用当前 Worktree 专属 Omni 服务 (Port: ${targetPort}, ${host.baseUrl})，接入 SSE 状态流`
      )
      host.restartAttempts = 0
      host.spawnedBinarySignature = host.binarySignature(exePath)
      if (!isSameExternalInstance) {
        host.lastSpawnedAt = Date.now()
      }
      host.pendingUpdateSignature = null
      host.pendingUpdateSince = 0
      host.startDevBinaryWatch()
      host.syncConfigFromDesktop().catch(() => {})
      // 复用已运行实例三步串行启动链（Ticket 06）：① .txn.json 恢复 ➔ ② reloadAssets ➔ ③ 非阻断状态核验
      try {
        const { modularResourceService } = await import('../modular-resource-service')
        const rootDir = modularResourceService?.getPluginsRootDir?.() || ''
        if (rootDir) {
          const { recoverSharedVisualVocabTxns } = await import('../file-download-service')
          recoverSharedVisualVocabTxns(PluginPathResolver.getSharedDirForRoot(rootDir))
        }
      } catch {}
      await host.reloadAssets().catch(() => false)
      const reuseVerify = await host.verifyMountManifestStatus().catch(() => null)
      if (reuseVerify && !reuseVerify.ok) {
        host.lastMountValidationError = reuseVerify.error || '挂载清单核验处于降级态'
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] 复用实例挂载核验降级（非阻断）: ${host.lastMountValidationError}`
        )
      }
      host.kickEventStreamReconnect({
        expectedTarget: {
          baseUrl: host.baseUrl,
          pid: adoptedPid,
          instanceId: adoptedInstanceId
        },
        resetFailures: true
      })
      if (opts.isReuseAdoption && !isSameExternalInstance) {
        const nextGen = ++host.currentGeneration
        host.emitInstanceChanged(nextGen)
      }
      if (verifiedData?.visualVocab) {
        host.handleStartupVisualVocabStatus({ statusData: verifiedData })
      }
      host.notifyReady()
      return true
    }

    // 优先读取 userData/run/omni-config.json 零扫描复用（通过 PID 存活 + 同源校验）
    let matchedPort: number | null = null
    let matchedData: Record<string, any> | undefined
    let matchedHeaderInstanceId: string | null | undefined
    let matchedFromDiscovery = false
    const df = host.getDiscoveryFile()
    const discovered = df?.read({ verifyPid: true }) ?? null
    if (discovered) {
      const dfOrigin = verifyOmniSameOrigin(
        {
          port: discovered.port,
          pid: discovered.pid,
          userDataDir: discovered.userDataDir,
          masterDbPath: discovered.masterDbPath,
          targetVectorsDir: discovered.targetVectorsDir
        },
        {
          userDataDir,
          masterDbPath: dbPath || null,
          targetVectorsDir: expectedVectorsDir
        }
      )
      if (dfOrigin.ok) {
        const verified = await host.verifyOmniInstance(discovered.port, discovered.pid, verifyOpts)
        if (verified.ok) {
          matchedPort = discovered.port
          matchedData = verified.data
          matchedHeaderInstanceId = verified.headerInstanceId
          matchedFromDiscovery = true
        }
      } else {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] 发现文件同源校验未通过，忽略并跳过复用: ${dfOrigin.reason}`
        )
      }
    }

    // 仅当发现文件未命中时，对 38200..=38219 执行并发单发 3000ms（0 重试）探测（彻底弃用同步端口快照）
    const scanResultByPort = new Map<number, VerifyInstanceResult>()
    if (matchedPort === null) {
      const ports = Array.from({ length: APP_PORTS.MAX_ATTEMPTS }, (_, idx) => host.basePort + idx)
      const settled = await Promise.allSettled(
        ports.map(async p => ({
          port: p,
          result: await host.verifyOmniInstance(p, undefined, verifyOpts)
        }))
      )
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          scanResultByPort.set(item.value.port, item.value.result)
          if (matchedPort === null && item.value.result.ok) {
            matchedPort = item.value.port
            matchedData = item.value.result.data
            matchedHeaderInstanceId = item.value.result.headerInstanceId
          }
        }
      }
    }

    if (matchedPort !== null) {
      return completeAdoption(matchedPort, matchedData, matchedHeaderInstanceId, {
        isReuseAdoption: !host.hasLiveManagedProcess(),
        matchedFromDiscovery,
        discovered,
        df
      })
    }

    // —— Anti-Fratricide / PreserveAlive 严格决策闸 ——
    // 严禁 `??` 混选 PID：托管态仅取 host.process.pid，复用态仅取 host.expectedIdentity.pid
    const hasLiveChild = host.hasLiveManagedProcess()
    const probePid = hasLiveChild ? host.process?.pid : host.expectedIdentity?.pid
    const pidAlive = typeof probePid === 'number' && probePid > 0 ? isPidAlive(probePid) : false
    const withinStartupGrace = host.isWithinStartupGrace()
    const targetPort = hasLiveChild
      ? host.actualPort
      : (host.expectedIdentity?.port ?? host.actualPort)
    const prevScan = scanResultByPort.get(targetPort)
    const verifyTimedOut = prevScan?.timedOut === true
    const portRefused = prevScan?.portRefused === true
    const explicitNonTimeoutFailure = prevScan?.explicitNonTimeoutFailure === true

    if (hasLiveChild || pidAlive) {
      const allowForceKill = shouldForceKillBeforeRespawn({
        hasLiveChild,
        pidAlive,
        verifyTimedOut,
        portRefused,
        withinStartupGrace
      })

      if (!allowForceKill) {
        // 1) 启动宽限期内：改为有界轮询等待至宽限期结束
        let reprobed: VerifyInstanceResult | null = null
        if (withinStartupGrace) {
          const graceDeadline = host.lastSpawnedAt + (OmniService as any).STARTUP_GRACE_MS
          while (Date.now() < graceDeadline && !host.isIntentionalStopping) {
            if (hasLiveChild && !host.hasLiveManagedProcess()) {
              break
            }
            const attempt = await host.verifyOmniInstance(targetPort, probePid, verifyOpts)
            if (attempt.ok) {
              reprobed = attempt
              break
            }
            await new Promise(r => setTimeout(r, 300))
          }
        } else if (!explicitNonTimeoutFailure) {
          // 2) 非宽限期且未明确非超时失败：单发复探一次
          reprobed = await host.verifyOmniInstance(targetPort, probePid, verifyOpts)
        }

        if (reprobed?.ok) {
          return completeAdoption(targetPort, reprobed.data, reprobed.headerInstanceId, {
            isReuseAdoption: !hasLiveChild,
            matchedFromDiscovery: false,
            discovered,
            df
          })
        }

        // 3) 核验仍失败：严格区分存活托管子进程（PreserveFailClosed + 60s 恢复终态）与外部陈旧 PID
        if (hasLiveChild && pidAlive) {
          host.recordManagedUnhealthyFailure(false)
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] PreserveFailClosed: 托管子进程仍存活 (PID=${probePid}, port=${targetPort}) 但状态核验未通，禁止双开 spawn`
          )
          return false
        }

        // 外部陈旧 PID 无法同源核验：视为陈旧缓存跳过并走新端口 spawn（绝不 taskkill，亦绝不永久拒服）
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] 外部复用缓存 PID=${probePid} 无法通过同源核验，清除陈旧身份并在新端口拉起托管实例`
        )
        host.expectedIdentity = null
        host.connectedTarget = null
        host.cachedVersion = null
        host.lastVerifiedAtMs = 0
      } else if (host.process && !host.process.killed) {
        // GuardedKill：若子进程物理上已失活或已退出（如原生崩溃尚未投递 close），
        // 严禁调用 forceKillProcessTree 误置 intentionalKill = true 掩盖真实 OOM/DML 崩溃；
        // 仅对确认存活且无退出码的子进程执行强杀，已死子进程仅等待 close 管道排空归因。
        const killCtx = host.currentLaunchCtx
        const processAlreadyDead =
          !pidAlive || host.process.exitCode !== null || host.process.signalCode !== null
        if (!processAlreadyDead) {
          host.forceKillProcessTree(host.process, 'doStart_guarded_kill')
        }
        await host.awaitLaunchContextClose(killCtx)
      }
    }

    if (host.isIntentionalStopping) {
      return false
    }

    // 寻找可用端口作为建议基准（Rust 侧 bind-first 仍支持 38200..=38219 原子滑动）
    const port = await findAvailablePort(host.basePort, APP_PORTS.MAX_ATTEMPTS)
    host.actualPort = port
    host.baseUrl = `http://127.0.0.1:${port}`
    host.cachedVersion = null
    host.connectedTarget = null
    host.lastVerifiedAtMs = 0

    logger.info(
      LogCategory.SYSTEM,
      `[OmniService] 正在拉起 firefly-omni 守护进程 (Port: ${port}): ${exePath}`
    )
    const isDevMode = isLocalDevRuntime()
    const binDir = path.dirname(exePath)
    const staticResourcesRoot = ResourceLocator.getBaseResourceDir()
    const deployedOnnxDir = path.join(staticResourcesRoot, 'bin', 'omni')
    const runtimeDllDir = fs.existsSync(deployedOnnxDir) ? deployedOnnxDir : binDir
    const existingPath = process.env.PATH || ''
    const injectedPath = [runtimeDllDir, binDir, existingPath].filter(Boolean).join(path.delimiter)

    const isWin = process.platform === 'win32'
    const existingLibPath = process.env.LD_LIBRARY_PATH || ''
    const injectedLibPath = [runtimeDllDir, binDir, existingLibPath]
      .filter(Boolean)
      .join(path.delimiter)

    // 绑定操作系统单实例文件咨询锁与安全令牌 (Spec §8)
    const runDir = dbPath
      ? path.join(path.dirname(dbPath), 'run')
      : path.join(process.cwd(), '.run')
    host.instanceLock = new OmniInstanceLock(runDir)
    if (!host.instanceLock.acquire()) {
      logger.warn(LogCategory.SYSTEM, '[OmniService] 操作系统单实例文件锁检测到同用户实例已运行')
    }
    host.tokenManager = new OmniTokenManager(runDir)
    const tokenPayload = host.tokenManager.createToken(port, `omni-boot-${Date.now()}`)

    // 净化子进程环境变量：彻底收口 18 个散落环境变量与旧 CLI 参数，改由 omni-bootstrap.json 统一下发
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: injectedPath,
      ...(isWin ? {} : { LD_LIBRARY_PATH: injectedLibPath }),
      FIREFLY_OMNI_TOKEN: tokenPayload.token,
      RUST_LOG:
        process.env.RUST_LOG ||
        (isDevMode ? 'info,omni_vision=info,omni_server=info,omni_text=info' : 'warn')
    }
    for (const purgeKey of CHILD_MODEL_ENV_KEYS_TO_PURGE) {
      delete env[purgeKey]
    }
    for (const obsoleteKey of [
      'FIREFLY_ACTIVE_MODEL_MOUNTS_FILE',
      'FIREFLY_STRICT_ACTIVE_PLUGINS',
      'FIREFLY_SHARED_DIR',
      'OMNI_PPOCR_MODEL_PATH',
      'OMNI_PORT',
      'OMNI_DEV_MODE',
      'OMNI_DB_PATH',
      'OMNI_VECTORS_PATH',
      'OMNI_GEO_DATA_PATH',
      'FIREFLY_ONNX_DIR',
      'FIREFLY_RUN_DIR',
      'FIREFLY_USER_DATA_DIR',
      'OMNI_WATCH_STDIN',
      'OMNI_DISABLE_DML',
      'OMNI_TTS_EAGER_WARMUP'
    ]) {
      delete env[obsoleteKey]
    }

    // 生成本次启动专属的唯一单轨挂载清单（域 A 与域 B 严格分界）
    let pluginsRoot = ''
    let sharedDir = ''
    let mountManifestPath: string | null = null
    let expectedMountResourceIds: string[] = []
    const mountsRecord: Record<string, Record<string, unknown>> = {}

    try {
      const { modularResourceService } = await import('../modular-resource-service')
      pluginsRoot = modularResourceService?.getPluginsRootDir?.() || ''
      const rootUnavailable = modularResourceService?.isRootUnavailable?.() === true

      if (pluginsRoot) {
        env.FIREFLY_MODULES_ROOT = pluginsRoot
        sharedDir = PluginPathResolver.getSharedDirForRoot(pluginsRoot)
        // 确保物理目录存在，防止全新启动（或重置用户目录后）Rust 端的 canonicalize 报 os error 3
        try {
          if (!fs.existsSync(sharedDir)) {
            fs.mkdirSync(sharedDir, { recursive: true })
          }
        } catch (mkdirErr) {
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] 自动创建 sharedDir 失败 (${sharedDir}):`,
            mkdirErr
          )
        }
        env.FIREFLY_SHARED_DIR = sharedDir
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] 🧩 统一插件根目录 (FIREFLY_MODULES_ROOT): ${pluginsRoot}`
        )
      }

      if (!rootUnavailable && modularResourceService) {
        const resourceIdToModuleInfo = new Map<
          string,
          { moduleId: string; capabilitySlot: string }
        >()
        for (const mod of modularResourceService.listModules?.() || []) {
          if (mod.install_state !== 'active') continue
          for (const res of mod.resources || []) {
            resourceIdToModuleInfo.set(res.resource_id, {
              moduleId: mod.id,
              capabilitySlot: mod.capability_slot || 'general'
            })
          }
        }

        const mountable = modularResourceService.getMountableResourcesSnapshot?.() || []
        for (const item of mountable) {
          const meta =
            item.catalogMeta ||
            BUILTIN_PLUGIN_CATALOG_META[item.resourceId as BuiltinSharedResourceId]
          if (!meta || !item.physicalDir || !fs.existsSync(item.physicalDir)) {
            if (item.physicalDir && !fs.existsSync(item.physicalDir)) {
              logger.warn(
                LogCategory.SYSTEM,
                `[OmniService] 跳过物理目录不存在的共享资源挂载: ${item.resourceId} (${item.physicalDir})`
              )
            }
            continue
          }

          // 语言场景互斥（chinese-clip vs mobile-clip）：
          // 中文环境优先且仅激活 chinese-clip；海外/非中文环境优先激活 mobile-clip
          const currentLang = host.getConfigValue('DEFAULT_LANGUAGE') || 'zh-CN'
          const isZh = currentLang.toLowerCase().startsWith('zh')
          if (isZh && item.resourceId === 'mobile-clip') {
            const hasChineseClip = mountable.some(m => m.resourceId === 'chinese-clip')
            if (hasChineseClip) {
              logger.debug(
                LogCategory.SYSTEM,
                '[OmniService] 中文语言环境下，chinese-clip 优先，跳过 mobile-clip 互斥挂载'
              )
              continue
            }
          } else if (!isZh && item.resourceId === 'chinese-clip') {
            const hasMobileClip = mountable.some(m => m.resourceId === 'mobile-clip')
            if (hasMobileClip) {
              logger.debug(
                LogCategory.SYSTEM,
                '[OmniService] 非中文语言环境下，mobile-clip 优先，跳过 chinese-clip 互斥挂载'
              )
              continue
            }
          }

          let envValue =
            meta.envVarType === 'file' && meta.envFileRelativePath
              ? path.join(item.physicalDir, meta.envFileRelativePath)
              : item.physicalDir

          // 不可变挂载指针契约 (Ticket 07 & Spec §3.2.1):
          // 优先从 current.json 反解真实物理文件路径
          const activePaths = resolveActiveModelPaths(item.physicalDir)
          if (activePaths?.activeFile) {
            envValue = path.join(item.physicalDir, activePaths.activeFile)
          } else if (activePaths?.activeFiles) {
            const allowInjectClipPaths = isZh
              ? item.resourceId === 'chinese-clip' ||
                !mountable.some(m => m.resourceId === 'chinese-clip')
              : item.resourceId === 'mobile-clip' ||
                !mountable.some(m => m.resourceId === 'mobile-clip')

            if (allowInjectClipPaths) {
              if (activePaths.activeFiles.visual) {
                env.VISUAL_MODEL_PATH = path.join(item.physicalDir, activePaths.activeFiles.visual)
              }
              if (activePaths.activeFiles.text) {
                env.TEXT_MODEL_PATH = path.join(item.physicalDir, activePaths.activeFiles.text)
              }
            }
          }

          if (meta.envVarType === 'file' && !fs.existsSync(envValue)) {
            logger.warn(
              LogCategory.SYSTEM,
              `[OmniService] 跳过缺失目标文件的共享资源挂载: ${item.resourceId} (${envValue})`
            )
            continue
          }

          // 仅向白名单生效资源注入对应 Env（禁止回退 extraResources / ~/.cache）
          env[meta.targetEnvVar] = envValue

          if (meta.optionalFileEnvVar) {
            const optPath = path.join(item.physicalDir, meta.optionalFileEnvVar.relativePath)
            if (fs.existsSync(optPath)) {
              env[meta.optionalFileEnvVar.envVar] = optPath
            }
          }

          const modInfo = resourceIdToModuleInfo.get(item.resourceId) || {
            moduleId: '',
            capabilitySlot: 'general'
          }
          const diskReady = !meta.visualVocabMeta ? readReadyMarkerSync(item.physicalDir) : null
          let effectiveVisualVocabMeta = meta.visualVocabMeta
          if (
            !effectiveVisualVocabMeta &&
            diskReady?.visualVocab?.matrixSha256 &&
            diskReady?.visualVocab?.metaSha256
          ) {
            const diskMetaPath = path.join(item.physicalDir, 'vocab_v.meta.json')
            if (fs.existsSync(diskMetaPath)) {
              try {
                const parsedMeta = JSON.parse(fs.readFileSync(diskMetaPath, 'utf-8')) as Record<
                  string,
                  any
                >
                const digest =
                  typeof parsedMeta.encoder_digest === 'string'
                    ? parsedMeta.encoder_digest.trim()
                    : ''
                const entryCount = Array.isArray(parsedMeta.entries)
                  ? parsedMeta.entries.length
                  : typeof parsedMeta.entry_count === 'number'
                    ? parsedMeta.entry_count
                    : 0
                if (digest.length >= 16 && entryCount > 0) {
                  effectiveVisualVocabMeta = {
                    matrixFileName: 'vocab_v.f16',
                    metaFileName: 'vocab_v.meta.json',
                    version: diskReady.visualVocab.pluginVersion || parsedMeta.version || '2.0.0',
                    schemaVersion: 2 as const,
                    bakeRevision:
                      diskReady.visualVocab.bakeRevision ?? parsedMeta.bake_revision ?? 1,
                    encoderDigestPrefix: digest.slice(0, 16),
                    matrixSha256: diskReady.visualVocab.matrixSha256,
                    metaSha256: diskReady.visualVocab.metaSha256,
                    entryCount,
                    embedDim: 512 as const
                  }
                }
              } catch {
                // 忽略畸形 vocab_v.meta.json，交由后续运行时对账处理
              }
            }
          }
          mountsRecord[item.resourceId] = {
            resourceId: item.resourceId,
            moduleId: modInfo.moduleId,
            capabilitySlot: modInfo.capabilitySlot,
            dir: item.physicalDir,
            envVar: meta.targetEnvVar,
            envValue,
            requiredFileGroups: meta.requiredFileGroups.map(g => [...g]),
            minPrimaryFileBytes: meta.minPrimaryFileBytes,
            ...(meta.tower ? { tower: meta.tower } : {}),
            ...(typeof meta.dim === 'number' ? { dim: meta.dim } : {}),
            ...(typeof meta.encoderId === 'number' ? { encoderId: meta.encoderId } : {}),
            ...(meta.vocabMeta ? { vocabMeta: { ...meta.vocabMeta } } : {}),
            ...(effectiveVisualVocabMeta
              ? { visualVocabMeta: { ...effectiveVisualVocabMeta } }
              : {})
          }
          expectedMountResourceIds.push(item.resourceId)
        }
      } else if (rootUnavailable) {
        logger.warn(
          LogCategory.SYSTEM,
          '[OmniService] 检测到插件根目录不可用，写入空挂载清单仅拉起域 A 基础能力'
        )
      }
    } catch (snapErr) {
      logger.warn(
        LogCategory.SYSTEM,
        '[OmniService] 读取插件挂载快照失败，使用空挂载清单拉起 Omni:',
        snapErr
      )
    }

    if (sharedDir) {
      const { recoverSharedVisualVocabTxns } = await import('../file-download-service')
      recoverSharedVisualVocabTxns(sharedDir)
    }

    try {
      fs.mkdirSync(runDir, { recursive: true })
      const manifestFileName = `active-mounts-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`
      const manifestAbsPath = path.join(runDir, manifestFileName)
      const tmpManifestPath = `${manifestAbsPath}.tmp`
      const manifestPayload = {
        version: 1,
        generatedAt: Date.now(),
        pid: process.pid,
        sharedDir,
        strict: true,
        mounts: mountsRecord
      }
      fs.writeFileSync(tmpManifestPath, JSON.stringify(manifestPayload, null, 2), 'utf-8')
      fs.renameSync(tmpManifestPath, manifestAbsPath)

      mountManifestPath = manifestAbsPath
      host.currentMountManifestPath = manifestAbsPath
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] 📦 生成单轨挂载清单 (${expectedMountResourceIds.length} 项): ${expectedMountResourceIds.join(', ') || 'none'}`
      )
    } catch (manifestWriteErr) {
      logger.error(
        LogCategory.SYSTEM,
        '[OmniService] 写入单轨挂载清单失败，强制启用 strict 保护模式:',
        manifestWriteErr
      )
    }

    const expectedMountsSnapshot = {
      manifestPath: mountManifestPath,
      sharedDir: sharedDir || null,
      expectedResourceIds: [...expectedMountResourceIds],
      strict: true
    }
    host.lastExpectedMounts = expectedMountsSnapshot

    // 提取当前激活的多模态嵌入画像档位与 MRL 维度
    let embeddingProfile: 'classic_light' | 'gemma_unified' = 'classic_light'
    let mrlDimension = 512
    try {
      const { ConfigOrchestrator } = await import('../../../config/config-orchestrator')
      const configOrch = ConfigOrchestrator?.getInstance?.()
      if (configOrch) {
        embeddingProfile =
          configOrch.getValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') ||
          'classic_light'
        mrlDimension = configOrch.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512
      }
    } catch {}

    // DirectML 原生崩溃守卫
    host.resolveDmlCrashMarker(dbPath)
    const dmlMarkerRaw = host.dmlCrashMarkerPath
      ? host.readTextFileSafe(host.dmlCrashMarkerPath)
      : null
    const shouldDisableDml = Boolean(
      host.forceCpuForNextStarts || shouldForceCpuFromMarker(dmlMarkerRaw, Date.now())
    )
    if (shouldDisableDml) {
      logger.warn(
        LogCategory.SYSTEM,
        '[OmniService] 检测到 DirectML 原生崩溃历史，本次在 bootstrap 中置位 disableDirectMl=true'
      )
    }

    // 写入唯一跨进程启动引导信封 runDir/omni-bootstrap.json 并通过 `--bootstrap <file>` 启动
    fs.mkdirSync(runDir, { recursive: true })
    const bootstrapPath = path.join(runDir, 'omni-bootstrap.json')
    const tmpBootstrapPath = `${bootstrapPath}.tmp`
    const resolvedVectorsDir = dbPath
      ? expectedVectorsDir || path.join(path.dirname(dbPath), 'vectors')
      : null
    const bootstrapConfig = {
      schemaVersion: 1,
      listenAddr: `127.0.0.1:${port}`,
      authTokenFile: null,
      staticResourcesRoot,
      storage: {
        dbPath: dbPath || null,
        vectorsDir: resolvedVectorsDir,
        runDir,
        userDataDir: userDataDir || null
      },
      runtime: {
        embeddingProfile,
        mrlDimension,
        disableDirectMl: shouldDisableDml,
        watchStdin: true,
        devMode: isDevMode,
        eagerTtsWarmup: false
      },
      pluginMountsFile: mountManifestPath
    }
    fs.writeFileSync(tmpBootstrapPath, JSON.stringify(bootstrapConfig, null, 2), 'utf-8')
    fs.renameSync(tmpBootstrapPath, bootstrapPath)
    const spawnArgs = ['serve', '--bootstrap', bootstrapPath]
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] ✉️ 已原子写入引导配置并启用单接缝启动 (--bootstrap): ${bootstrapPath} (staticResourcesRoot=${staticResourcesRoot})`
    )

    // 托管 spawn 前预留严格递增代际号并冻结独立 LaunchContext（启动期崩溃仍精准归因当前代）
    const launchGeneration = ++host.currentGeneration
    const spawnedWithDml = !shouldDisableDml

    // J-06 / B5：spawn 前必须等待 reaperDone 门闸落地，并复检退出态
    const { gate, isStartupGatesInitialized } = await import('../../../main/startup-gates')
    if (!isTestEnvironment() || isStartupGatesInitialized()) {
      await gate('reaperDone')
    }
    const { processReaper: omniReaperCheck } = await import('../../../main/process-reaper')
    if (omniReaperCheck.isQuittingState() || (host as any).isStopping) {
      logger.info(LogCategory.SYSTEM, '[OmniService] 进程正在退出，取消拉起 firefly-omni')
      return false
    }

    const child = spawn(exePath, spawnArgs, {
      cwd: binDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const launchCtx = host.createLaunchContext(launchGeneration, child, spawnedWithDml)
    host.currentLaunchCtx = launchCtx

    // 立即记录当前拉起的二进制签名与拉起时间戳（启动 15s 冷静期保护，防启动中途被 checkBinaryUpdated 误杀）
    host.lastSpawnedAt = Date.now()
    host.spawnedBinarySignature = host.binarySignature(exePath)
    host.pendingUpdateSignature = null
    host.pendingUpdateSince = 0

    // 登记进全局精准进程回收器
    try {
      const { processReaper } = require('../../../main/process-reaper')
      processReaper.registerChild(child.pid, 'firefly-omni')
    } catch {}

    const isCzkawkaDump = (str: string): boolean => {
      return (
        str.includes('DEBUG PRINT COMMON') ||
        str.includes('DEBUG PRINT MESSAGES') ||
        str.includes('Included paths(before optimization)') ||
        str.includes('Included files(optimized)') ||
        str.includes('Directories { included_directories')
      )
    }

    // 剥离子进程输出中的 ANSI 转义序列（CSI，如 \x1b[2m26:42\x1b[0m \x1b[32m INFO\x1b[0m）。
    // 引擎在强开 ANSI 或原生库（onnxruntime / sherpa C-API）直接着色输出时，这些控制
    // 字符会随日志透传到渲染进程控制台与 app.log，表现为时间戳/级别前缀乱码。
    const stripAnsi = (buf: Buffer): string =>
      buf.toString().replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

    // 受管子进程 stdout `<1ms` FIREFLY_READY 快路径信号 Promise
    let resolveReadyFrame: ((frame: FireflyReadyFrame) => void) | null = null
    let readyFrameReceived = false
    const readyFramePromise = new Promise<FireflyReadyFrame>(resolve => {
      resolveReadyFrame = resolve
    })
    let stdoutLineBuf = ''

    child.stdout?.on('data', data => {
      const rawChunk = stripAnsi(data)
      // 行缓冲解析 FIREFLY_READY:{"port":...,"pid":...,"instanceId":"..."} 快路径
      stdoutLineBuf += rawChunk
      const splitLines = stdoutLineBuf.split(/\r?\n/)
      stdoutLineBuf = splitLines.pop() ?? ''
      for (const line of splitLines) {
        const readyFrame = parseFireflyReadyLine(line)
        if (readyFrame && host.process === child && !host.isIntentionalStopping) {
          host.actualPort = readyFrame.port
          host.baseUrl = `http://127.0.0.1:${readyFrame.port}`
          host.expectedIdentity = {
            pid: readyFrame.pid,
            instanceId: readyFrame.instanceId,
            port: readyFrame.port
          }
          logger.info(
            LogCategory.SYSTEM,
            `[OmniService] ⚡ 捕获 stdout FIREFLY_READY 快路径 (port=${readyFrame.port}, pid=${readyFrame.pid}, instanceId=${readyFrame.instanceId})`
          )
          host.kickEventStreamReconnect({
            expectedTarget: {
              baseUrl: host.baseUrl,
              pid: readyFrame.pid,
              instanceId: readyFrame.instanceId
            },
            resetFailures: true
          })
          if (!readyFrameReceived) {
            readyFrameReceived = true
            resolveReadyFrame?.(readyFrame)
          }
        }
      }

      const str = rawChunk.trim()
      if (str && !isCzkawkaDump(str)) {
        // 若子进程输出为 INFO 级别或包含多模态关键业务日志，以 info 输出至控制台；其余以 debug 输出
        const isInfoMsg =
          str.includes('INFO') ||
          str.includes('[普遍语法造句') ||
          str.includes('[双锚点融合') ||
          str.includes('[OmniServer]') ||
          str.includes('[prune_and_rank_tags]') ||
          str.includes('[落选') ||
          str.includes('[胜出') ||
          str.includes('[MossTtsPerf]')
        if (isInfoMsg) {
          logger.debug(LogCategory.SYSTEM, `[Omni] ${str}`)
        } else {
          logger.debug(LogCategory.SYSTEM, `[Omni] ${str}`)
        }
      }
    })

    child.stderr?.on('data', data => {
      const rawText = stripAnsi(data)
      host.appendLaunchStderr(launchCtx, rawText)
      const str = rawText.trim()
      if (str && !isCzkawkaDump(str)) {
        logger.warn(LogCategory.SYSTEM, `[Omni:err] ${str}`)
        if (str.includes('KeyEpochMismatch')) {
          logger.error(
            LogCategory.SYSTEM,
            `[OmniService] ❌ 检测到组件密钥代次不匹配 (KeyEpochMismatch): ${str}`
          )
          host.handleKeyEpochMismatch(str)
        }
      }
    })

    child.on('error', err => {
      try {
        const { handleExecutableSecurityBlock } = require('../antivirus-guard')
        if (handleExecutableSecurityBlock(exePath, err)) {
          return
        }
      } catch {}
      logger.error(LogCategory.SYSTEM, '[OmniService] 子进程启动失败:', err)
    })

    child.on('exit', (code, signal) => {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 子进程退出 (gen=${launchCtx.generation}, pid=${launchCtx.pid}, code=${code}, signal=${signal})`
      )
      try {
        const { processReaper } = require('../../../main/process-reaper')
        processReaper.unregisterChild(child.pid)
      } catch {}
    })

    // 统一延后到 child.on('close')（stderr 管道彻底排空后）做最终四分类崩溃归因与生命周期回调
    child.on('close', async (code, signal) => {
      const stderrTail = host.getLaunchStderrTail(launchCtx)
      const category = classifyOmniCrash({
        managedChild: true,
        dmlEnabled: launchCtx.spawnedWithDml,
        wasIntentionalKill: launchCtx.intentionalKill || host.isIntentionalStopping,
        exitCode: code,
        signal,
        stderrTail
      })

      if (category === 'dml_native_crash') {
        host.persistDmlCrash(host.dmlCrashMarkerPath, typeof code === 'number' ? code : 0)
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] 检测到 DirectML 原生崩溃 (gen=${launchCtx.generation}, code=${typeof code === 'number' ? `0x${(code >>> 0).toString(16)}` : code}, signal=${signal})，已按滑动窗口写入保护标记`
        )
      } else if (category === 'rust_oom') {
        logger.error(
          LogCategory.SYSTEM,
          `[OmniService] ❌ 检测到 Omni 内存耗尽崩溃 (rust_oom, gen=${launchCtx.generation}, code=${code})，绝不误封 DirectML 硬件加速`
        )
      } else if (category === 'intentional_kill') {
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] 受控终止子进程已关闭 (gen=${launchCtx.generation}, code=${code}, signal=${signal})`
        )
      } else {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] 子进程关闭 (category=${category}, gen=${launchCtx.generation}, dml=${launchCtx.spawnedWithDml}, code=${code}, signal=${signal})，不写入 DirectML 封禁标记`
        )
      }

      launchCtx.closed = true
      launchCtx.resolveClose()

      host.unlinkManifestSafe(expectedMountsSnapshot.manifestPath)
      if (
        expectedMountsSnapshot.manifestPath &&
        host.currentMountManifestPath === expectedMountsSnapshot.manifestPath
      ) {
        host.currentMountManifestPath = null
      }

      // 单调代际归属守卫：过期代延迟 close 仅落归因日志，绝不污染新实例、绝不发回调
      const isCurrentGen = launchCtx.generation === host.currentGeneration && host.process === child
      if (!isCurrentGen) {
        return
      }

      host.process = null
      host.expectedIdentity = null
      host.cachedVersion = null
      host.connectedTarget = null
      host.lastVerifiedAtMs = 0
      host.unhealthySince = null
      host.lastFailureAt = null
      if (host.currentLaunchCtx === launchCtx) {
        host.currentLaunchCtx = null
      }

      const nextGen = ++host.currentGeneration
      host.emitLifecycleInactive(nextGen)

      // 主动推送"未运行"状态至渲染进程（基础AI引擎 Footer 展示）
      host.pushStatus().catch(() => {})
      if (host.isIntentionalStopping || launchCtx.intentionalKill) {
        return
      }
      // 子进程异常退出后，仅当同源验证通过才允许外部服务接管，并完整采纳新实例身份与重建 SSE
      const verifiedExternal = await host.verifyOmniInstance(host.actualPort, undefined, verifyOpts)
      if (
        host.currentGeneration !== nextGen ||
        host.isIntentionalStopping ||
        host.process !== null ||
        host.isStarting
      ) {
        return
      }
      if (verifiedExternal.ok) {
        const adoptedPid =
          typeof verifiedExternal.data?.pid === 'number' ? verifiedExternal.data.pid : undefined
        const adoptedInstanceId = host.resolveAdoptedInstanceId(
          verifiedExternal.data,
          verifiedExternal.headerInstanceId,
          host.actualPort
        )
        const version =
          typeof verifiedExternal.data?.version === 'string' && verifiedExternal.data.version
            ? verifiedExternal.data.version
            : null
        host.applyAdoptedInstanceIdentity({
          port: host.actualPort,
          pid: adoptedPid,
          instanceId: adoptedInstanceId,
          version
        })
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] ${host.actualPort} 端口已有同源外部服务接管，已完成身份采纳与 SSE 重建`
        )
        host.restartAttempts = 0
        host.syncConfigFromDesktop().catch(() => {})
        host.kickEventStreamReconnect({
          expectedTarget: {
            baseUrl: host.baseUrl,
            pid: adoptedPid,
            instanceId: adoptedInstanceId
          },
          resetFailures: true
        })
        const externalGen = ++host.currentGeneration
        host.emitInstanceChanged(externalGen)
        if (verifiedExternal.data?.visualVocab) {
          host.handleStartupVisualVocabStatus({ statusData: verifiedExternal.data })
        }
        host.notifyReady()
        host.pushStatus().catch(() => {})
        return
      }
      host.scheduleRestart()
    })

    host.process = child

    // 等待服务就绪（优先由 stdout FIREFLY_READY 快路径 <1ms 唤醒，兜底最多 400 次 * 200ms = 80s 兼容旧二进制）
    for (let i = 0; i < 400; i++) {
      // 关键防御：若子进程在探活期间提前退出或被终止，立即中止等待，拒绝僵尸死等 80s 阻塞系统
      if (
        child.exitCode !== null ||
        child.killed ||
        host.process !== child ||
        host.isIntentionalStopping
      ) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] firefly-omni 子进程在就绪前退出或中止 (exitCode=${child.exitCode}, killed=${child.killed}, stopping=${host.isIntentionalStopping})`
        )
        return false
      }

      if (!readyFrameReceived) {
        await Promise.race([readyFramePromise, new Promise(r => setTimeout(r, 200))])
      } else if (i > 0) {
        await new Promise(r => setTimeout(r, 200))
      }
      if (await host.checkHealth()) {
        const verifyRes = await host.verifyMountManifestStatus(expectedMountsSnapshot)
        if (!verifyRes.ok) {
          host.lastMountValidationError = verifyRes.error || '挂载清单双向核验未通过'
          // Ticket 06 启动链三态非阻断约束：visualVocab / mount 状态为 stale / missing / corrupt
          // 或瞬时探测异常时，记录降级警告并放行纯文本服务激活，严禁调用 stop() 误杀引擎进程。
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] 挂载清单/词表核验处于降级态（非阻断，放行纯文本服务继续运行）: ${host.lastMountValidationError}`
          )
        } else {
          host.handleStartupVisualVocabStatus(verifyRes)
        }
        const statusData = verifyRes.statusData
        const resolvedId = host.resolveAdoptedInstanceId(
          statusData,
          undefined,
          host.actualPort,
          host.expectedIdentity?.instanceId
        )
        host.expectedIdentity = {
          pid: typeof statusData?.pid === 'number' ? statusData.pid : child.pid,
          instanceId: resolvedId,
          port: host.actualPort
        }
        if (typeof statusData?.version === 'string' && statusData.version) {
          host.cachedVersion = statusData.version
        }
        host.connectedTarget = {
          baseUrl: host.baseUrl,
          pid: host.expectedIdentity.pid,
          instanceId: resolvedId
        }
        host.lastVerifiedAtMs = Date.now()
        host.unhealthySince = null
        host.lastFailureAt = null

        logger.info(
          LogCategory.SYSTEM,
          `[OmniService] firefly-omni 服务就绪并在 ${host.baseUrl} 正常监听 (gen=${launchGeneration})`
        )
        host.restartAttempts = 0
        // 探活就绪后，记录二进制签名，并开启开发态热更新监听
        host.spawnedBinarySignature = host.binarySignature(exePath)
        host.lastSpawnedAt = Date.now()
        host.pendingUpdateSignature = null
        host.pendingUpdateSince = 0
        host.startDevBinaryWatch()
        // 探活就绪后，立即同步一次当前配置（ENABLE_IMAGE_OCR, OCR_MODEL_SIZE 等）
        host.syncConfigFromDesktop().catch(() => {})
        // 确保单循环 SSE 状态流已建立，实时推送状态至渲染进程
        host.ensureEventStream()
        host.emitInstanceChanged(launchGeneration)
        host.notifyReady()
        return true
      }
    }

    logger.error(
      LogCategory.SYSTEM,
      `[OmniService] firefly-omni 启动探活超时 (80s)，终止当前未就绪子进程`
    )
    await host.stop()
    // 启动失败（探活超时），推送"未运行"状态
    host.pushStatus().catch(() => {})
    return false
  } catch (err) {
    logger.error(LogCategory.SYSTEM, '[OmniService] 启动服务发生异常:', err)
    return false
  } finally {
    host.isStarting = false
  }
}
