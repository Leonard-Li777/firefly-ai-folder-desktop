/**
 * E2E 出站网络白名单与总账审计 (Ticket 02 Spec §5.3 / §6.3)
 *
 * 物理红线：
 * 1. 绝对拦截对公网与非回环局域网的一切访问；
 * 2. 仅对 127.0.0.1、::1、localhost、devtools:// 以及 CDP 通道放行；
 * 3. 拦截时必须调用 callback({ cancel: true }) 安全取消，绝对严禁直接 throw；
 * 4. 维护 egressLedger，teardown 时断言违规出站请求为 0。
 */

import type { Session } from 'electron'
import { verifyE2EToken, DesktopE2EError } from './e2e-gate'

export interface EgressAttempt {
  timestamp: number
  url: string
  method: string
  resourceType: string
  blocked: boolean
}

export class EgressGuardService {
  private static egressLedger: EgressAttempt[] = []
  private static installedSessions = new WeakSet<Session>()

  /**
   * 判断目标 URL 是否属于合法回环与测试通道
   */
  static isAllowedUrl(rawUrl: string): boolean {
    if (!rawUrl) return false

    try {
      // 允许 devtools / chrome 内部协议
      if (
        rawUrl.startsWith('devtools://') ||
        rawUrl.startsWith('chrome-extension://') ||
        rawUrl.startsWith('data:') ||
        rawUrl.startsWith('file:') ||
        rawUrl.startsWith('ff-preview:')
      ) {
        return true
      }

      const parsed = new URL(rawUrl)
      const hostname = parsed.hostname.toLowerCase()

      // 允许本地数值回环与 localhost
      if (
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === 'localhost' ||
        hostname === '[::1]'
      ) {
        return true
      }

      return false
    } catch {
      // 无法解析的 URL 默认为非法出站
      return false
    }
  }

  /**
   * 在 Electron 会话中安装出站拦截钩子（支持多 Session / Partition 独立守卫）
   *
   * @param session Electron Session（如 session.defaultSession 或 app.on('session-created') 实例）
   */
  static install(session: Session): void {
    if (!session || this.installedSessions.has(session)) return
    this.installedSessions.add(session)

    session.webRequest.onBeforeRequest((details, callback) => {
      const isAllowed = this.isAllowedUrl(details.url)

      this.egressLedger.push({
        timestamp: Date.now(),
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        blocked: !isAllowed
      })

      if (isAllowed) {
        callback({ cancel: false })
      } else {
        console.warn(`🚨 [EgressGuard] 拦截到非法外部出站请求: ${details.method} ${details.url}`)
        // Spec §5.3 铁律：记录总账后调用 cancel: true 取消，绝对严禁在回调内 throw！
        callback({ cancel: true })
      }
    })
  }

  /**
   * 获取出站总账（受 Token 鉴权保护）
   */
  static getLedger(token: string): EgressAttempt[] {
    if (!verifyE2EToken(token)) {
      throw new DesktopE2EError(3, '[E2E 致命错误] 出站守卫鉴权失败：非法会话令牌')
    }
    return [...this.egressLedger]
  }

  /**
   * 断言无非法出站请求，若有则抛出 exitCode=1 的断言失败
   */
  static assertCleanEgressOrThrow(token: string): void {
    const ledger = this.getLedger(token)
    const blockedAttempts = ledger.filter(a => a.blocked)

    if (blockedAttempts.length > 0) {
      const summary = blockedAttempts.map(a => `${a.method} ${a.url}`).join(', ')
      throw new DesktopE2EError(
        1,
        `[E_EGRESS_VIOLATION] 检测到 ${blockedAttempts.length} 次非法外部出站请求: ${summary}`
      )
    }
  }

  /**
   * 重置总账（测试隔离）
   */
  static _resetForTesting(): void {
    this.egressLedger = []
    this.installedSessions = new WeakSet<Session>()
  }
}
