/**
 * FTS 展示名 locale 读取缝（纯 Node 模块，零 electron / electron-conf 依赖）
 *
 * 背景：fts-projection.ts 原静态 import ConfigOrchestrator（其顶层拉起 electron-conf，
 * electron-conf 模块加载即 `require('electron')`），导致 Stage2 S-B
 * `AnalysisDbWriterProcess`（utilityProcess 子进程入口）无法安全加载 FTS 投影链。
 *
 * 裁决依据 docs/evidence/stage2-s0-port-discovery.md §2 边界表：
 * 「ConfigOrchestrator 运行配置快照 → 经初始化握手 / RPC 消息显式下发」——
 * - 主进程：ConfigOrchestrator 构造时注册真实读取器（行为零变化）；
 * - 子进程：INIT 握手消息携带 displayLocale，入口注册注入读取器（显式注入，非伪兜底）。
 */

import { LogCategory, logger } from '@firefly/shared'

/** 展示 locale 读取器签名（返回如 'zh-CN'） */
export type DisplayLocaleReader = () => string

let displayLocaleReader: DisplayLocaleReader | null = null

/**
 * 注册展示 locale 读取器（幂等覆盖：后注册者生效，供主进程真实配置源与子进程握手注入各自登记）
 */
export function setDisplayLocaleReader(reader: DisplayLocaleReader | null): void {
  displayLocaleReader = reader
}

/**
 * 读取 FTS 展示名解析 locale。
 * 未注册读取器时回退 'zh-CN' 并留痕——受控概念展示名解析在中文环境命中
 * AOT 权威字典，此兜底仅在「无任何配置源」的极端场景生效（如极早期单测），
 * 业务路径上主进程构造 ConfigOrchestrator 时必定注册，子进程 INIT 必定携带。
 */
export function readDisplayLocale(): string {
  if (displayLocaleReader) {
    try {
      return displayLocaleReader()
    } catch (error) {
      logger.warn(
        LogCategory.DATABASE_SERVICE,
        '[DisplayLocaleSeam] 展示 locale 读取器抛异常，回退 zh-CN:',
        error
      )
      return 'zh-CN'
    }
  }
  logger.warn(
    LogCategory.DATABASE_SERVICE,
    '[DisplayLocaleSeam] 未注册展示 locale 读取器，回退 zh-CN（主进程应由 ConfigOrchestrator 注册）'
  )
  return 'zh-CN'
}
