import { app, BrowserWindow, ipcMain } from 'electron'
import {
  LogCategory,
  logger,
  type GlobalPluginRuntimeState,
  type WorkspaceRuntimeContext,
  type WorkspaceRuntimeContextSnapshot as SharedRuntimeContextSnapshot
} from '@firefly/shared'
import type { HardwareInfo } from '@firefly/types'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { databaseService } from '../database/database-service'
import { libreOfficeDetector } from './libreoffice-detector'
import type { LibreOfficeDetectionResult } from './libreoffice-detector'
import { modularResourceService } from './modular-resource-service'
import { llmGatewayService } from '../llm/llm-gateway-service'
import { userTierService } from '../user-tier/user-tier-service'
import { subscribeRuntimeContextChange } from './workspace-runtime-context-bus'
import {
  countRecoverableByCategory,
  listRecoverableFilesPrecise,
  clearRecoverableFiles,
  dismissRecoveryBanner,
  isRecoveryBannerSilenced,
  enqueueRecovery,
  type RecoveryQueueResult
} from './workspace-recovery-queue-service'

export const WORKSPACE_RUNTIME_CONTEXT_CHANNEL = 'workspace-runtime-context-updated'
export const WORKSPACE_RUNTIME_CONTEXT_SNAPSHOT_CHANNEL = 'workspace-runtime-context:get-snapshot'
export const WORKSPACE_INCREMENTAL_RECOVERY_CHANNEL = 'trigger-workspace-incremental-recovery'
export const WORKSPACE_RECOVERY_QUEUE_CHANNEL = 'get-workspace-recovery-queue'
export const WORKSPACE_RECOVERY_CLEAR_CHANNEL = 'clear-workspace-recovery-items'
export const WORKSPACE_RECOVERY_DISMISS_CHANNEL = 'dismiss-workspace-recovery-banner'
export const WORKSPACE_RECOVERY_ENQUEUE_CHANNEL = 'enqueue-workspace-recovery-items'

/**
 * 主进程权威运行时上下文信封：
 * - `contextEpoch` + `snapshot` 严格对齐 `@firefly/shared` `WorkspaceRuntimeContextSnapshot`；
 * - 可选 `recoverableCount` / `recoverableNonVideoCount` / `recoverablePendingVideoCount`
 *   在按 `workspaceId` 查询快照时由主进程基于真实 DB 计算回传。
 */
export interface WorkspaceRuntimeContextSnapshotEnvelope extends SharedRuntimeContextSnapshot {
  workspaceId?: number | null
  /** 兼容字段：待补文件总数（非视频 + 待续跑长视频） */
  recoverableCount?: number
  /** 待补非视频缺口文件数（OCR/封面/缩略图/内容/向量/ASR） */
  recoverableNonVideoCount?: number
  /** 待续跑长视频切片文件数 */
  recoverablePendingVideoCount?: number
}

const FOCUS_RECHECK_INTERVAL_MS = 30_000
const MERGE_WINDOW_MS = 100

/**
 * 模块视图 → 全局插件运行态映射。
 * 【枚举同源铁律】`install_state` 必须严格对齐 `ModuleInstallState` 权威枚举
 * （modular-resource-dao.ts / GENESIS_V1_SCHEMA CHECK 约束）：
 * 'not_installed' | 'downloading' | 'installed_inactive' | 'active' | 'error'。
 * 历史缺陷：此处曾误判不存在的 'installed' 值与不存在的 is_active 列，
 * 导致 install_state='active'（插件中心正常启用）被误映射为 'not_installed'，
 * 三态 UI 出现「插件中心已启用、能力页显示尚未安装」的状态不同步。
 */
function mapModuleToGlobalState(mod: {
  install_state?: string
  validation_status?: string
}): GlobalPluginRuntimeState {
  if (mod.install_state === 'downloading') return 'downloading'
  if (mod.install_state === 'error' || mod.validation_status === 'pending_repair') return 'error'
  if (mod.install_state === 'active') return 'active'
  if (mod.install_state === 'installed_inactive') return 'installed_inactive'
  return 'not_installed'
}

/**
 * 主进程运行时上下文服务（SLICE-04）：
 * - 统一聚合四大单例真实状态生成 `@firefly/shared` `WorkspaceRuntimeContext`
 * - 全局单调递增 `contextEpoch`（冷启动 0，不落库），100ms 合并窗口防风暴
 * - 自注册 IPC (`get-snapshot` / `trigger-workspace-incremental-recovery`) 与 `browser-window-focus`
 */
export class WorkspaceRuntimeContextService {
  private static instance: WorkspaceRuntimeContextService | null = null
  private contextEpoch = 0
  private initialized = false
  private mergeTimer: NodeJS.Timeout | null = null
  private pendingReasons: string[] = []
  private lastFocusRecheckAt = 0
  private libreOfficeInstalled = false
  private libreOfficeCheckedOnce = false
  private snapshot: WorkspaceRuntimeContext = {
    isGenerativeAiEnabled: true,
    globalEmbeddingProfile: 'classic_light',
    globalPluginStates: {},
    libreOfficeInstalled: false,
    userTier: 'free',
    tierReady: false,
    videoInferenceBackend: 'unknown',
    hardwareInfo: null
  }

  static getInstance(): WorkspaceRuntimeContextService {
    if (!WorkspaceRuntimeContextService.instance) {
      WorkspaceRuntimeContextService.instance = new WorkspaceRuntimeContextService()
    }
    return WorkspaceRuntimeContextService.instance
  }

  /** 测试接缝：仅用于隔离单测，不参与生产逻辑。 */
  static resetForTest(): void {
    WorkspaceRuntimeContextService.instance = null
  }

  getContextEpoch(): number {
    return this.contextEpoch
  }

  getRuntimeContext(): WorkspaceRuntimeContext {
    return {
      ...this.snapshot,
      globalPluginStates: { ...this.snapshot.globalPluginStates }
    }
  }

  getSnapshotEnvelope(workspaceId?: number | null): WorkspaceRuntimeContextSnapshotEnvelope {
    let recoverableCount: number | undefined
    let recoverableNonVideoCount: number | undefined
    let recoverablePendingVideoCount: number | undefined
    if (workspaceId != null && databaseService.db) {
      const counts = countRecoverableByCategory(databaseService.db, workspaceId)
      // 横幅 24h 静默：关闭后 24h 内即使有新文件进入待补也不再计为可提醒，
      // 三类计数一律归零，使前端横幅不显示；设置页清单仍可见（不受静默影响）。
      if (isRecoveryBannerSilenced(databaseService.db, workspaceId)) {
        recoverableCount = 0
        recoverableNonVideoCount = 0
        recoverablePendingVideoCount = 0
      } else {
        recoverableCount = counts.totalCount
        recoverableNonVideoCount = counts.nonVideoCount
        recoverablePendingVideoCount = counts.pendingVideoCount
      }
    }
    return {
      contextEpoch: this.contextEpoch,
      workspaceId: workspaceId ?? null,
      snapshot: this.getRuntimeContext(),
      recoverableCount,
      recoverableNonVideoCount,
      recoverablePendingVideoCount
    }
  }

  /** 冷启动握手：注册 IPC 与窗口焦点事件，并订阅四大单例的变更通知。 */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    ipcMain.handle(
      WORKSPACE_RUNTIME_CONTEXT_SNAPSHOT_CHANNEL,
      async (_event, workspaceId?: number | null) => {
        await this.refresh()
        return this.getSnapshotEnvelope(workspaceId)
      }
    )

    ipcMain.handle(
      WORKSPACE_INCREMENTAL_RECOVERY_CHANNEL,
      async (
        _event,
        workspaceId: number
      ): Promise<{ success: boolean; queued?: number; error?: string }> => {
        try {
          if (!databaseService.db || !Number.isFinite(workspaceId)) {
            return { success: false, error: 'INVALID_WORKSPACE_OR_DB' }
          }
          const queued = await this.triggerIncrementalRecovery(workspaceId)
          return { success: true, queued }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn(
            LogCategory.SYSTEM,
            `[WorkspaceRuntimeContext] 触发工作区 ${workspaceId} 增量补齐失败:`,
            error
          )
          return { success: false, error: message }
        }
      }
    )

    app.on('browser-window-focus', () => {
      const now = Date.now()
      if (now - this.lastFocusRecheckAt < FOCUS_RECHECK_INTERVAL_MS) return
      this.lastFocusRecheckAt = now
      void this.recheckLibreOffice(true)
    })

    this.registerRecoveryChannels()

    subscribeRuntimeContextChange(reason => {
      this.notifyChanged(reason)
    })

    void this.refresh('cold_start')
  }

  /** 注册待补恢复三通道：清单 / 清除 / 横幅关闭（触发补全复用既有增量恢复通道） */
  private registerRecoveryChannels(): void {
    ipcMain.handle(
      WORKSPACE_RECOVERY_QUEUE_CHANNEL,
      async (_event, workspaceId: number): Promise<RecoveryQueueResult> =>
        listRecoverableFilesPrecise(workspaceId)
    )

    ipcMain.handle(
      WORKSPACE_RECOVERY_CLEAR_CHANNEL,
      async (
        _event,
        workspaceId: number,
        workspaceFileIds: number[]
      ): Promise<{ success: boolean; cleared?: number; error?: string }> =>
        clearRecoverableFiles(workspaceId, workspaceFileIds)
    )

    ipcMain.handle(
      WORKSPACE_RECOVERY_DISMISS_CHANNEL,
      async (_event, workspaceId: number): Promise<{ success: boolean; error?: string }> =>
        dismissRecoveryBanner(workspaceId)
    )

    ipcMain.handle(
      WORKSPACE_RECOVERY_ENQUEUE_CHANNEL,
      async (
        _event,
        workspaceId: number,
        workspaceFileIds?: number[]
      ): Promise<{ success: boolean; queued?: number; error?: string }> =>
        enqueueRecovery(workspaceId, workspaceFileIds)
    )

    // 长视频空闲单切片补全 5 通道（Spec §3.5）
    ipcMain.handle(
      'video-backfill:list-workspace',
      async (_event, payload: { workspaceId: number }) => {
        const { analysisQueueService } = await import('../analysis-queue-service')
        return analysisQueueService.listWorkspacePendingBackfillVideos(payload?.workspaceId)
      }
    )

    ipcMain.handle('video-backfill:start', async (_event, payload?: { workspaceId?: number }) => {
      const { analysisQueueService } = await import('../analysis-queue-service')
      if (payload?.workspaceId != null) {
        await analysisQueueService.notifyWorkspaceConfigChangedForBackfill(payload.workspaceId)
      }
      const started = analysisQueueService.startVideoBackfill('manual_start')
      return { started }
    })

    ipcMain.handle('video-backfill:pause', async () => {
      const { analysisQueueService } = await import('../analysis-queue-service')
      await analysisQueueService.pauseVideoBackfill()
      return { paused: true }
    })

    ipcMain.handle(
      'video-backfill:prioritize',
      async (_event, payload: { workspaceId: number; fileFingerprint: string }) => {
        const { analysisQueueService } = await import('../analysis-queue-service')
        const ok = analysisQueueService.prioritizeVideoBackfill(
          payload.workspaceId,
          payload.fileFingerprint
        )
        return { ok }
      }
    )

    ipcMain.handle(
      'video-backfill:retry-failed',
      async (_event, payload: { workspaceId: number }) => {
        const { analysisQueueService } = await import('../analysis-queue-service')
        const resetCount = await analysisQueueService.retryFailedVideoBackfill(payload.workspaceId)
        return { resetCount }
      }
    )
  }

  /** 触发指定工作区的环境恢复存量缺口增量补齐入队（仅入队缺口文件，不推翻已提取阶段）。 */
  async triggerIncrementalRecovery(workspaceId: number): Promise<number> {
    const db = databaseService.db
    if (!db) return 0
    const pendingVideoRows = db
      .prepare(
        `SELECT wf.path, wf.name, wf.file_size
         FROM workspace_files wf
         WHERE wf.workspace_id = ?
           AND EXISTS (
             SELECT 1 FROM file_video_segments fvs
             WHERE fvs.file_id = wf.file_fingerprint AND fvs.status = 'pending'
           )`
      )
      .all(workspaceId) as Array<{ path: string; name: string; file_size?: number | null }>

    if (pendingVideoRows.length === 0) return 0
    const { analysisQueueService } = await import('../analysis-queue-service')
    await analysisQueueService.addItems(
      pendingVideoRows.map(r => ({
        path: r.path,
        name: r.name,
        size: Number(r.file_size ?? 0),
        type: 'file',
        workspaceId
      }))
    )
    return pendingVideoRows.length
  }

  /** 四大单例状态变更写出口调用：100ms 合并后刷新快照、递增 epoch 并广播。 */
  notifyChanged(reason: string): void {
    this.pendingReasons.push(reason)
    if (this.mergeTimer) return
    this.mergeTimer = setTimeout(() => {
      this.mergeTimer = null
      const reasons = Array.from(new Set(this.pendingReasons))
      this.pendingReasons = []
      this.contextEpoch += 1
      void this.refresh(reasons.join(',')).then(() => {
        this.broadcast()
      })
    }, MERGE_WINDOW_MS)
  }

  /** LibreOffice 手动复检入口（UI 可调用）：仅 installed 变化时触发 notifyChanged。 */
  async recheckLibreOffice(forceRefresh = true): Promise<boolean> {
    try {
      const result: LibreOfficeDetectionResult =
        await libreOfficeDetector.detectLibreOffice(forceRefresh)
      const installed = Boolean(result?.installed)
      this.libreOfficeCheckedOnce = true
      if (installed !== this.libreOfficeInstalled) {
        this.libreOfficeInstalled = installed
        this.notifyChanged('libreoffice_installed_changed')
        return true
      }
      return false
    } catch (error) {
      logger.warn(LogCategory.SYSTEM, '[WorkspaceRuntimeContext] LibreOffice 复检失败:', error)
      return false
    }
  }

  /** 读取四大单例真实可观测状态并生成 `@firefly/shared` 标准 `WorkspaceRuntimeContext`。 */
  async refresh(reason = 'refresh'): Promise<void> {
    let isGenerativeAiEnabled = this.snapshot.isGenerativeAiEnabled
    let globalEmbeddingProfile: 'classic_light' | 'gemma_unified' =
      this.snapshot.globalEmbeddingProfile
    const globalPluginStates: Record<string, GlobalPluginRuntimeState> = {}
    let userTier: string | null = (this.snapshot.userTier as string) ?? 'free'
    let tierReady = Boolean(this.snapshot.tierReady)
    let hardwareInfo: HardwareInfo | null = this.snapshot.hardwareInfo ?? null

    // 1. 生成式 AI 引擎状态（LlmGatewayService.getSnapshot）
    try {
      const llmSnapshot = llmGatewayService.getSnapshot()
      isGenerativeAiEnabled = llmSnapshot.effectiveMode !== 'disabled'
    } catch (error) {
      logger.warn(
        LogCategory.SYSTEM,
        '[WorkspaceRuntimeContext] 读取 LlmGatewayService 快照失败:',
        error
      )
    }

    // 2. 插件中心模块运行态与向量检索底座槽位（ModularResourceService）
    try {
      const modules = modularResourceService.listModules()
      for (const mod of modules) {
        globalPluginStates[mod.id] = mapModuleToGlobalState(mod)
      }
      const activeEmbedding = modularResourceService.getActiveModuleBySlot('base_embedding')
      if (activeEmbedding?.id === 'engine_gemma_unified') {
        globalEmbeddingProfile = 'gemma_unified'
      } else if (activeEmbedding?.id === 'engine_classic_light') {
        globalEmbeddingProfile = 'classic_light'
      } else {
        const cfgProfile = ConfigOrchestrator.getInstance().getValue<string>(
          'EMBEDDING_PROFILE' as any
        )
        globalEmbeddingProfile = cfgProfile === 'gemma_unified' ? 'gemma_unified' : 'classic_light'
      }
    } catch (error) {
      logger.warn(
        LogCategory.SYSTEM,
        '[WorkspaceRuntimeContext] 读取 ModularResourceService 模块态失败:',
        error
      )
    }

    // 3. 会员等级（UserTierService.getCachedData / getProfile）
    try {
      const cached = userTierService.getCachedData()
      if (cached) {
        userTier = cached.tier
        tierReady = true
      } else {
        const profile = await userTierService.getProfile()
        if (profile?.tier) {
          userTier = profile.tier
          tierReady = true
        }
      }
    } catch (error) {
      logger.warn(
        LogCategory.SYSTEM,
        '[WorkspaceRuntimeContext] 读取 UserTierService 会员等级失败:',
        error
      )
    }

    // 4. LibreOffice 检测结果（首次冷启动或事件回调时同步真实缓存）
    try {
      if (!this.libreOfficeCheckedOnce || reason.includes('libreoffice')) {
        const loRes = await libreOfficeDetector.detectLibreOffice(false)
        this.libreOfficeInstalled = Boolean(loRes?.installed)
        this.libreOfficeCheckedOnce = true
      }
    } catch (error) {
      logger.warn(
        LogCategory.SYSTEM,
        '[WorkspaceRuntimeContext] 读取 LibreOffice 检测态失败:',
        error
      )
    }

    // 5. 硬件探测快照（未知时保持 null 触发 unknown fail-open）
    try {
      const hw = ConfigOrchestrator.getInstance().getValue<HardwareInfo | null>(
        'HARDWARE_INFO' as any
      )
      if (hw && typeof hw === 'object') {
        hardwareInfo = hw
      }
    } catch (error) {
      logger.warn(LogCategory.SYSTEM, '[WorkspaceRuntimeContext] 读取硬件信息失败:', error)
    }

    this.snapshot = {
      isGenerativeAiEnabled,
      globalEmbeddingProfile,
      globalPluginStates,
      libreOfficeInstalled: this.libreOfficeInstalled,
      userTier,
      tierReady,
      hardwareInfo
    }
  }

  private broadcast(): void {
    const envelope = this.getSnapshotEnvelope()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(WORKSPACE_RUNTIME_CONTEXT_CHANNEL, envelope)
      } catch (error) {
        logger.warn(LogCategory.SYSTEM, '[WorkspaceRuntimeContext] 广播失败:', error)
      }
    }
  }
}

export const workspaceRuntimeContextService = WorkspaceRuntimeContextService.getInstance()

/** 供 `workspace-analysis-context.ts` 读取当前 epoch（避免循环 import）。 */
export function getWorkspaceRuntimeContextEpoch(): number {
  return workspaceRuntimeContextService.getContextEpoch()
}
