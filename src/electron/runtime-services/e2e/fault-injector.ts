/**
 * 主进程确定性故障注入器 (Ticket 02 Spec §4.7)
 *
 * 仅在 FF_E2E_MODE=1 激活，支持对 SQLite、插件崩溃、搜索分相故障、支付延迟等场景的确定性故障注入。
 * 每个测试用例 afterEach 强制断言已武装的故障 fired === true，避免未消费故障引发空转假通过。
 */

import crypto from 'node:crypto'
import { verifyE2EToken, DesktopE2EError } from './e2e-gate'

export type TestFault =
  | {
      kind: 'sqlite-fail-at'
      table: 'files' | 'file_tag_relations' | 'workspace_files' | 'file_contents'
      afterRows: number
      sqlState: 'SQLITE_CONSTRAINT' | 'SQLITE_IOERR'
      times?: number
    }
  | { kind: 'plugin-crash'; pluginId: string; exitCode: number; times?: number }
  | { kind: 'payment-relay-hang'; orderId: string; times?: number }
  | { kind: 'clock-advance'; ms: number }
  | {
      kind: 'search-phase-fail'
      phase: 'lexical' | 'vector'
      errorCode: 'E_SEARCH_INJECTED'
      times?: number
    }
  | { kind: 'search-phase-gate'; phase: 'vector'; delayMs: number; times?: number }

export interface ArmedFault {
  faultId: string
  fault: TestFault
  remainingTimes: number
  fired: boolean
}

export class FaultInjectorService {
  private static armedFaults = new Map<string, ArmedFault>()

  /**
   * 武装一个确定性故障
   */
  static injectFault(fault: TestFault, token: string): { armed: boolean; faultId: string } {
    if (!verifyE2EToken(token)) {
      throw new DesktopE2EError(3, '[E2E 致命错误] 故障注入器鉴权失败：非法会话令牌')
    }

    const faultId = `fault_${crypto.randomUUID().slice(0, 8)}`
    const armed: ArmedFault = {
      faultId,
      fault,
      remainingTimes: 'times' in fault && typeof fault.times === 'number' ? fault.times : 1,
      fired: false
    }

    this.armedFaults.set(faultId, armed)
    return { armed: true, faultId }
  }

  /**
   * 触发并标记指定类型的故障（供生产代码受控切槽调用）
   * @returns 匹配的武装故障（若触发成功且还有配额），否则返回 null
   */
  static triggerIfArmed<K extends TestFault['kind']>(
    kind: K,
    predicate: (f: Extract<TestFault, { kind: K }>) => boolean
  ): Extract<TestFault, { kind: K }> | null {
    for (const armed of this.armedFaults.values()) {
      if (armed.fault.kind === kind && armed.remainingTimes > 0) {
        if (predicate(armed.fault as any)) {
          armed.fired = true
          armed.remainingTimes--
          return armed.fault as any
        }
      }
    }
    return null
  }

  /**
   * 获取所有已武装故障的执行报告
   */
  static getFaultReport(token: string): Array<{ faultId: string; kind: string; fired: boolean }> {
    if (!verifyE2EToken(token)) {
      throw new DesktopE2EError(3, '[E2E 致命错误] 故障注入器鉴权失败：非法会话令牌')
    }

    return Array.from(this.armedFaults.values()).map(a => ({
      faultId: a.faultId,
      kind: a.fault.kind,
      fired: a.fired
    }))
  }

  /**
   * 清理所有已武装故障（测试后置清理）
   */
  static clearFaults(token: string): void {
    if (!verifyE2EToken(token)) {
      throw new DesktopE2EError(3, '[E2E 致命错误] 故障注入器鉴权失败：非法会话令牌')
    }
    this.armedFaults.clear()
  }

  /**
   * 测试隔离重置
   */
  static _resetForTesting(): void {
    this.armedFaults.clear()
  }
}
