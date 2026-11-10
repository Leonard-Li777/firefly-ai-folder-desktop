/**
 * 主进程受控探针与事件总线 (Ticket 02 Spec §4.7)
 *
 * 仅在 FF_E2E_MODE=1 激活，受 32 字节高熵随机令牌严格鉴权，
 * 绝不下发给渲染进程、插件子进程或日志。
 */

import { verifyE2EToken, DesktopE2EError } from './e2e-gate'

export interface RuntimeEvent {
  seq: number
  timestamp: number
  category: string
  name: string
  payload?: Record<string, unknown>
}

export interface PendingDeletionProbeItem {
  id: string
  type: string
  registeredAt: string
  reason?: string
}

export interface TestProbeBridgeScopes {
  'embedding-epoch': { epoch: number; activeSlotId: string | null }
  'dir-switch-intent': {
    intents: Array<{
      state: 'prepared' | 'old-moved' | 'new-moved'
      targetDir: string
      trashDir: string
      stagingDir: string
      updatedAt: number
    }>
  }
  'fs-journal': {
    entries: Array<{
      batchId: string
      seq: number
      op: 'rename' | 'move' | 'trash'
      fromPath: string
      toPath: string
      status: string
      attempt: number
    }>
  }
  'tombstone-queue': {
    pendingItems: PendingDeletionProbeItem[]
    pendingDeleteResources: Array<{
      resourceId: string
      targetLocalPath: string
      downloadState: string
    }>
  }
  'entitlement-snapshot': {
    version: number
    tier: string
    firecores: number
    computed_limits: Record<string, unknown>
    entitlements: Array<Record<string, unknown>>
    counters: Record<string, unknown>
    entitlementRev: number
  }
  'search-session': { activeRequestId: number; lastPhase: string }
  'plugin-circuit-breaker': {
    pluginId: string
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
    consecutiveCrashes: number
    currentCooldownMs: number
    halfOpenTaskInFlight: boolean
  }
  'order-status': { orderId: string; status: string }
}

export class ProbeBridgeService {
  private static eventBuffer: RuntimeEvent[] = []
  private static nextSeq = 1
  private static readonly MAX_BUFFER_SIZE = 500

  // 作用域状态查询处理函数映射
  private static scopeHandlers = new Map<
    string,
    (query: Record<string, unknown>) => Promise<Record<string, unknown>>
  >()

  /**
   * 记录运行时事件到内存环形缓冲区
   */
  static recordEvent(category: string, name: string, payload?: Record<string, unknown>): void {
    const event: RuntimeEvent = {
      seq: this.nextSeq++,
      timestamp: Date.now(),
      category,
      name,
      payload
    }

    this.eventBuffer.push(event)
    if (this.eventBuffer.length > this.MAX_BUFFER_SIZE) {
      this.eventBuffer.shift()
    }
  }

  /**
   * 注册指定作用域的状态探针处理函数
   */
  static registerScopeHandler<S extends keyof TestProbeBridgeScopes>(
    scope: S,
    handler: (query: Record<string, unknown>) => Promise<TestProbeBridgeScopes[S]>
  ): void {
    this.scopeHandlers.set(scope, handler as any)
  }

  /**
   * 获取指定序号以后的事件追溯（受 Token 鉴权保护）
   */
  static async getEventTrace(sinceSeq: number, token: string): Promise<RuntimeEvent[]> {
    if (!verifyE2EToken(token)) {
      throw new DesktopE2EError(3, '[E2E 致命错误] 探针鉴权失败：非法会话令牌')
    }
    return this.eventBuffer.filter(e => e.seq > sinceSeq)
  }

  /**
   * 探测指定作用域的内部状态（受 Token 鉴权保护）
   */
  static async getInternalState<S extends keyof TestProbeBridgeScopes>(
    scope: S,
    query: Record<string, unknown>,
    token: string
  ): Promise<TestProbeBridgeScopes[S] & { rev: number }> {
    if (!verifyE2EToken(token)) {
      throw new DesktopE2EError(3, '[E2E 致命错误] 探针鉴权失败：非法会话令牌')
    }

    const handler = this.scopeHandlers.get(scope)
    if (!handler) {
      // 默认空状态返回（包含 rev 序号）
      return { rev: this.nextSeq } as any
    }

    const state = await handler(query)
    return {
      ...state,
      rev: this.nextSeq
    } as any
  }

  /**
   * 清理探针事件缓冲（测试隔离）
   */
  static clearForTesting(): void {
    this.eventBuffer = []
    this.nextSeq = 1
    this.scopeHandlers.clear()
  }
}
