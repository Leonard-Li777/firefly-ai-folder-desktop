import { app, BrowserWindow, ipcMain } from 'electron'
import { LogCategory, logger } from '@firefly/shared'
import { libreOfficeDetector } from './libreoffice-detector'
import type { LibreOfficeDetectionResult } from './libreoffice-detector'
import { modularResourceService } from './modular-resource-service'
import { llmGatewayService } from '../llm/llm-gateway-service'
import { userTierService } from '../user-tier/user-tier-service'
import { subscribeRuntimeContextChange } from './workspace-runtime-context-bus'

export const WORKSPACE_RUNTIME_CONTEXT_CHANNEL = 'workspace-runtime-context-updated'
export const WORKSPACE_RUNTIME_CONTEXT_SNAPSHOT_CHANNEL = 'workspace-runtime-context:get-snapshot'

/** 主进程唯一权威快照：渲染侧只消费它并调用纯函数解析 effectiveConfig，绝不自研环境探测。 */
export interface WorkspaceRuntimeContextSnapshot {
  libreOfficeInstalled: boolean
  embeddingProfile: string
  generativeEngineMode: string
  asrModuleActive: boolean
  userTier: string
  reason: string
}

export interface WorkspaceRuntimeContextSnapshotEnvelope {
  contextEpoch: number
  snapshot: WorkspaceRuntimeContextSnapshot
}

const FOCUS_RECHECK_INTERVAL_MS = 30_000
const MERGE_WINDOW_MS = 100

/**
 * 主进程运行时上下文服务（SLICE-04）：
 * - 全局单调递增 `contextEpoch`（冷启动 0，不落库）
 * - 100ms 合并窗口内多个环境事件只递增一次并广播，渲染侧仅接收 epoch 更大的快照
 * - 自注册 IPC 与 `browser-window-focus`，零触碰 Group B 独占的 settings-ipc-handler / main.ts
 */
export class WorkspaceRuntimeContextService {
  private static instance: WorkspaceRuntimeContextService | null = null
  private contextEpoch = 0
  private initialized = false
  private mergeTimer: NodeJS.Timeout | null = null
  private pendingReasons: string[] = []
  private lastFocusRecheckAt = 0
  private libreOfficeInstalled = false
  private snapshot: WorkspaceRuntimeContextSnapshot = {
    libreOfficeInstalled: false,
    embeddingProfile: 'classic_light',
    generativeEngineMode: 'local',
    asrModuleActive: false,
    userTier: '',
    reason: 'cold_start'
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

  getSnapshotEnvelope(): WorkspaceRuntimeContextSnapshotEnvelope {
    return { contextEpoch: this.contextEpoch, snapshot: { ...this.snapshot } }
  }

  /** 冷启动握手：注册 IPC 与窗口焦点事件，并订阅四大单例的变更通知。 */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    ipcMain.handle(WORKSPACE_RUNTIME_CONTEXT_SNAPSHOT_CHANNEL, async () => {
      await this.refresh()
      return this.getSnapshotEnvelope()
    })

    app.on('browser-window-focus', () => {
      const now = Date.now()
      if (now - this.lastFocusRecheckAt < FOCUS_RECHECK_INTERVAL_MS) return
      this.lastFocusRecheckAt = now
      void this.recheckLibreOffice(true)
    })

    subscribeRuntimeContextChange((reason) => {
      this.notifyChanged(reason)
    })

    void this.refresh()
  }

  /** 四大单例状态变更写出口调用：100ms 合并后递增 epoch 并广播。 */
  notifyChanged(reason: string): void {
    this.pendingReasons.push(reason)
    if (this.mergeTimer) return
    this.mergeTimer = setTimeout(() => {
      this.mergeTimer = null
      const reasons = Array.from(new Set(this.pendingReasons))
      this.pendingReasons = []
      this.contextEpoch += 1
      void this.refresh(reasons.join(','))
      this.broadcast()
    }, MERGE_WINDOW_MS)
  }

  /** LibreOffice 手动复检入口（UI 可调用）：仅 installed 变化时触发 notifyChanged。 */
  async recheckLibreOffice(forceRefresh = true): Promise<boolean> {
    try {
      const result: LibreOfficeDetectionResult = await libreOfficeDetector.detectLibreOffice(forceRefresh)
      const installed = Boolean((result as { installed?: boolean }).installed)
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

  /** 重新读取四大单例的可观测状态；任何失败显式上报，绝不静默吞异常。 */
  async refresh(reason = this.snapshot.reason): Promise<void> {
    let generativeEngineMode = 'local'
    let asrModuleActive = false
    let userTier = ''
    try {
      const llmSnapshot = (llmGatewayService as unknown as { getSnapshot?: () => Record<string, unknown> }).getSnapshot?.()
      if (llmSnapshot) {
        generativeEngineMode = String(
          llmSnapshot.mode ?? llmSnapshot.desiredMode ?? llmSnapshot.aiServiceMode ?? 'local'
        )
      }
      const modularSnapshot = (
        modularResourceService as unknown as { getSnapshot?: () => Record<string, unknown> }
      ).getSnapshot?.()
      if (modularSnapshot) {
        asrModuleActive = JSON.stringify(modularSnapshot).includes('asr_sensevoice_onnx')
      }
      const tierSnapshot = (
        userTierService as unknown as { getSnapshot?: () => Record<string, unknown> }
      ).getSnapshot?.()
      if (tierSnapshot) userTier = String(tierSnapshot.tier ?? '')
    } catch (error) {
      logger.warn(LogCategory.SYSTEM, '[WorkspaceRuntimeContext] 单例快照读取失败:', error)
    }

    this.snapshot = {
      libreOfficeInstalled: this.libreOfficeInstalled,
      embeddingProfile: String(
        (llmGatewayService as unknown as { getEmbeddingProfile?: () => string }).getEmbeddingProfile?.() ??
          this.snapshot.embeddingProfile
      ),
      generativeEngineMode,
      asrModuleActive,
      userTier,
      reason
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

// 自闭合初始化：仅在主进程生效，零触碰 Group B 独占的 settings-ipc-handler / main.ts。
if (process.type === 'browser') {
  workspaceRuntimeContextService.initialize()
}
