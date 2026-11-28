/**
 * OmniService 二进制探针缓存、热更新监听与 CLI 契约预检逻辑
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

export function omniProberStartDevBinaryWatch(
  host: any,
  intervalMs: number = (OmniService as any).DEV_BINARY_WATCH_INTERVAL_MS
): void {
  const isDev = isLocalDevRuntime()
  if (host.devBinaryWatchTimer || !isDev) {
    return
  }
  host.devBinaryWatchTimer = setInterval(() => {
    void host.checkBinaryUpdated()
  }, intervalMs)
  host.devBinaryWatchTimer.unref?.()
  logger.debug(
    LogCategory.SYSTEM,
    `[OmniService] 已开启 Omni 引擎二进制热更新监听（每 ${intervalMs}ms 比对部署产物）`
  )
}

/** 停止开发态二进制热更新监听 */
export function omniProberStopDevBinaryWatch(host: any): void {
  if (host.devBinaryWatchTimer) {
    clearInterval(host.devBinaryWatchTimer)
    host.devBinaryWatchTimer = null
  }
}

/**
 * 比对当前二进制签名与本服务拉起时的签名；变化且稳定后自动重启 Omni 引擎。
 */
export async function omniProberCheckBinaryUpdated(host: any): Promise<void> {
  if (host.isStarting) {
    return
  }
  // 启动冷静期（15秒）：若子进程存在且刚启动不久，给其足够的稳定初始化时间
  if (host.process && host.lastSpawnedAt > 0 && Date.now() - host.lastSpawnedAt < 15_000) {
    return
  }
  const exePath = host.resolveOmniExecutable()
  if (!exePath) {
    return
  }
  const signature = host.binarySignature(exePath)
  if (!signature) {
    host.pendingUpdateSignature = null
    host.pendingUpdateSince = 0
    return
  }

  // 关键防御：若尚未记录过已拉起的二进制签名，直接以当前二进制签名作为基准，绝不能误判为产物更新去触发 restart()
  if (!host.spawnedBinarySignature) {
    host.spawnedBinarySignature = signature
    host.pendingUpdateSignature = null
    host.pendingUpdateSince = 0
    return
  }

  if (signature === host.spawnedBinarySignature) {
    host.pendingUpdateSignature = null
    host.pendingUpdateSince = 0
    return
  }

  // 首次检测到签名变更：进入待定状态，防抖保护
  if (host.pendingUpdateSignature !== signature) {
    host.pendingUpdateSignature = signature
    host.pendingUpdateSince = Date.now()
    return
  }

  // 连续两次检测到相同新签名，且持续稳定至少 3 秒（确保外部编译与文件复制彻底落盘）
  if (Date.now() - host.pendingUpdateSince < 3_000) {
    return
  }

  const previous = host.spawnedBinarySignature
  host.spawnedBinarySignature = signature
  host.pendingUpdateSignature = null
  host.pendingUpdateSince = 0

  logger.info(
    LogCategory.SYSTEM,
    `[OmniService] 🔄 检测到 Omni 引擎二进制产物更新（${previous ?? '初始'} → ${signature}），正在重新拉起...`
  )
  host.restartAttempts = 0
  await host.restart()
}

export function omniProberBuildOmniExecutableCandidatePaths(host: any): string[] {
  const isWin = process.platform === 'win32'
  const exeName = isWin ? 'firefly-omni.exe' : 'firefly-omni'
  const isDev = isLocalDevRuntime()
  const root = process.cwd()
  const baseResDir = (() => {
    try {
      return ResourceLocator.getBaseResourceDir()
    } catch {
      return ''
    }
  })()
  const omniWorkspaceFromRes = baseResDir ? path.resolve(baseResDir, '..', '..', '..', 'omni') : ''
  const candidates: string[] = []
  const push = (candidate: string | null | undefined): void => {
    if (!candidate) return
    const resolved = path.resolve(candidate)
    if (candidates.includes(resolved)) return
    candidates.push(resolved)
  }

  // 1. 开发态优先级锁定 (Ticket 06): 本地 cargo target/{release,debug} 优先命中，防止被集成目录旧构建遮蔽
  if (isDev) {
    if (omniWorkspaceFromRes) {
      push(path.join(omniWorkspaceFromRes, 'target', 'release', exeName))
      push(path.join(omniWorkspaceFromRes, 'target', 'debug', exeName))
    }
    push(path.join(root, 'apps', 'omni', 'target', 'release', exeName))
    push(path.join(root, 'apps', 'omni', 'target', 'debug', exeName))
    push(path.join(root, '..', 'omni', 'target', 'release', exeName))
    push(path.join(root, '..', 'omni', 'target', 'debug', exeName))
  }

  // 2. 生产打包或部署态：通过 ResourceLocator 解析随包 bin/omni
  push(
    ResourceLocator.resolveBin('omni/firefly-omni') || ResourceLocator.resolveBin('firefly-omni')
  )

  // 3. 多候选路径兜底检索
  push(path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', 'omni', exeName))
  push(path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', exeName))
  push(path.join(root, 'apps', 'omni', 'target', 'release', exeName))
  push(path.join(root, 'apps', 'omni', 'target', 'debug', exeName))
  push(path.join(root, 'build', 'extraResources', 'bin', 'omni', exeName))

  return candidates
}

export function omniProberCollectOmniExecutableCandidates(host: any): string[] {
  if (host.cachedExecutableCandidates !== null) {
    return host.cachedExecutableCandidates
  }
  const existing = host
    .buildOmniExecutableCandidatePaths()
    .filter((candidate: string) => fs.existsSync(candidate))
  host.cachedExecutableCandidates = existing
  return existing
}

export async function omniProberCollectOmniExecutableCandidatesAsync(
  host: any,
  forceRefresh = false
): Promise<string[]> {
  if (!forceRefresh && host.cachedExecutableCandidates !== null) {
    return host.cachedExecutableCandidates
  }
  const candidates = host.buildOmniExecutableCandidatePaths()
  const existing: string[] = []
  for (const candidate of candidates) {
    if (await existsAsync(candidate)) {
      existing.push(candidate)
    }
  }
  host.cachedExecutableCandidates = existing
  return existing
}

/**
 * 契约预检单个候选（按「路径 + mtime:size」缓存结论，二进制被覆盖后自动重探）。
 * 探针自身无法执行时不缓存，避免把瞬时失败固化。
 */
export async function omniProberProbeCandidateServeContract(
  host: any,
  exePath: string
): Promise<{ result: Awaited<ReturnType<typeof probeServeContract>>; cached: boolean }> {
  const signature = (await host.binarySignatureAsync(exePath)) ?? 'nostat'
  const cacheKey = `${exePath}|${signature}`
  const cached = host.serveContractCache.get(cacheKey)
  if (cached) {
    return { result: cached, cached: true }
  }
  const result = await probeServeContract(exePath, {
    timeoutMs: (OmniService as any).BINARY_CONTRACT_PROBE_TIMEOUT_MS
  })
  // 探针无法执行（权限/杀软/受限环境）不具备确定性，不写入缓存，下次重新探测
  if (result.status !== 'probe_failed') {
    host.serveContractCache.set(cacheKey, result)
  }
  return { result, cached: false }
}

/**
 * 选出第一个满足宿主 CLI 契约的二进制候选。
 *
 * 设计要点（2026-11-26 事故）：
 * - 集成目录被旧版 v0.1.8（仅支持 `-a/--addr`）占位时，旧实现会直接拉起 ⇒ clap 退出码 2
 *   ⇒ 盲目重启 10 次后静默放弃。这里改为「预检不通过就顺延到下一个候选」，
 *   既不再拿旧构件试错，也不会让旧构件遮蔽本地新构建；
 * - 全部候选都确定性不兼容 ⇒ 返回诊断文案，由调用方显式报错并冷却，绝不 spawn；
 * - 存在探针失败（无法判定）的候选且无兼容候选 ⇒ 放行首个可执行候选，仅显式记录原因，
 *   避免因杀软/权限导致的探针异常反向废掉本来可用的引擎。
 */
export async function omniProberResolveContractCompatibleExecutable(host: any): Promise<{
  exePath: string | null
  contractMismatch: string | null
}> {
  let candidates = await host.collectOmniExecutableCandidatesAsync()
  // 若缓存中的候选已被删除/替换，回退触发一次强制重探
  if (candidates.length > 0 && !(await existsAsync(candidates[0]))) {
    candidates = await host.collectOmniExecutableCandidatesAsync(true)
  }
  let firstMismatchDetail: string | null = null
  let undeterminedCandidate: string | null = null

  for (const candidate of candidates) {
    const { result, cached } = await host.probeCandidateServeContract(candidate)
    if (result.status === 'compatible') {
      host.incompatibleBinaryReported = false
      host.incompatibleBinaryRetryAt = 0
      host.lastMountValidationError = null
      return { exePath: candidate, contractMismatch: null }
    }
    if (result.status === 'incompatible') {
      if (!firstMismatchDetail) {
        firstMismatchDetail = buildServeContractMismatchDetail({
          exePath: candidate,
          missingOptions: result.missingOptions,
          helpText: result.helpText
        })
      }
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 跳过 CLI 契约不兼容的引擎构件（缺失 ${result.missingOptions.join('、')}）: ${candidate}${cached ? '（缓存结论）' : ''}`
      )
      continue
    }
    // probe_failed：显式上报原因（严禁静默吞没），保留为首个可执行候选
    logger.warn(
      LogCategory.SYSTEM,
      `[OmniService] 引擎构件 CLI 契约探针无法执行，本次先放行由拉起试错: ${candidate}，原因: ${result.probeError}`
    )
    if (!undeterminedCandidate) {
      undeterminedCandidate = candidate
    }
  }

  if (firstMismatchDetail) {
    return { exePath: null, contractMismatch: firstMismatchDetail }
  }
  if (undeterminedCandidate) {
    return { exePath: undeterminedCandidate, contractMismatch: null }
  }
  return { exePath: null, contractMismatch: null }
}

/**
 * 启动并守护 firefly-omni 子进程（支持并发 Promise 合并）
 */

export function omniProberDescribeBinarySearch(host: any): string {
  const isWin = process.platform === 'win32'
  const exeName = isWin ? 'firefly-omni.exe' : 'firefly-omni'
  const lines: string[] = []

  let baseDir = '(未知)'
  try {
    baseDir = ResourceLocator.getBaseResourceDir()
  } catch (err: any) {
    logger.warn(
      LogCategory.SYSTEM,
      `[OmniService] 资源根目录解析失败，无法给出精确的组件路径: ${err?.message || err}`
    )
  }
  lines.push(`资源根目录=${baseDir}`)
  lines.push(`resourcesPath=${(process as any).resourcesPath || '(未知)'}`)
  let appPath = '(未知)'
  try {
    appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : '(不可用)'
  } catch {}
  lines.push(`appPath=${appPath}`)

  if (baseDir === '(未知)') {
    lines.push('资源根目录解析失败，无法枚举 bin 目录（疑似路径解析异常，而非组件缺失）')
  } else {
    try {
      const binDir = path.join(baseDir, 'bin')
      const omniDir = path.join(binDir, 'omni')
      lines.push(`bin目录存在=${fs.existsSync(binDir)}`)
      lines.push(`bin/omni目录存在=${fs.existsSync(omniDir)}`)
      if (fs.existsSync(omniDir)) {
        const siblings = fs.readdirSync(omniDir).slice(0, 20).join(', ')
        lines.push(`bin/omni目录内容=[${siblings || '空'}]`)
      }
    } catch (err: any) {
      lines.push(`目录枚举失败=${err?.message || err}`)
    }
  }

  lines.push(`候选文件=${exeName} 均不存在`)
  lines.push(
    '常见原因：① 杀毒软件把 firefly-omni.exe 隔离/删除；② 安装包不完整或更新中断；③ 安装目录被手动清理。'
  )
  return lines.join(' | ')
}

export function omniProberNotifyBinaryMissing(host: any): void {
  if (host.binaryMissingNotified) return
  try {
    if (typeof app.isReady === 'function' && !app.isReady()) {
      if (!host.binaryMissingNotifyDeferred && typeof app.whenReady === 'function') {
        host.binaryMissingNotifyDeferred = true
        void app
          .whenReady()
          .then(() => host.notifyBinaryMissing())
          .catch(() => {})
      }
      return
    }
  } catch {}

  const isWin = process.platform === 'win32'
  const exeName = isWin ? 'firefly-omni.exe' : 'firefly-omni'

  let baseDir = ''
  try {
    baseDir = ResourceLocator.getBaseResourceDir()
  } catch (err: any) {
    logger.warn(
      LogCategory.SYSTEM,
      `[OmniService] 组件缺失提示：资源根目录解析失败: ${err?.message || err}`
    )
  }
  const omniDir = baseDir ? path.join(baseDir, 'bin', 'omni') : ''
  const exePath = omniDir ? path.join(omniDir, exeName) : exeName

  let dirState: 'exists' | 'missing' | 'unknown' = 'unknown'
  if (omniDir) {
    try {
      dirState = fs.existsSync(omniDir) ? 'exists' : 'missing'
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 组件缺失提示：无法判断组件目录是否存在: ${err?.message || err}`
      )
    }
  }

  const detail = [
    '检索式引擎组件缺失，文件分析能力受限',
    '',
    '缺失的文件：',
    exePath,
    '',
    '建议按以下顺序处理：',
    '1. 打开杀毒软件的「隔离区 / 恢复区」，找到 firefly-omni.exe 并恢复；',
    '2. 将上面的组件目录加入杀毒软件白名单（信任区）；',
    '3. 若文件已无法恢复，请重新安装或修复安装本应用。',
    '',
    '本应用不会自动下载该组件。修复后无需重启，约 1 分钟内会自动恢复。'
  ].join('\n')

  host.binaryMissingNotified = true
  try {
    const shown = dialog?.showMessageBox({
      type: 'warning',
      title: '检索式引擎组件缺失',
      message: '检索式引擎组件缺失，文件分析能力受限',
      detail,
      buttons: ['打开组件目录', '知道了'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    void shown
      ?.then?.((result: any) => {
        if (result?.response !== 0) return
        const target = dirState === 'exists' && omniDir ? omniDir : baseDir
        if (!target) return
        void shell?.openPath?.(target)
      })
      ?.catch?.(() => {
        host.binaryMissingNotified = false
      })
  } catch (err: any) {
    host.binaryMissingNotified = false
  }
}
