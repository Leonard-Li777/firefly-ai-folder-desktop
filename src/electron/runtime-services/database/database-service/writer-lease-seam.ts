/**
 * W4/J-13 主进程入库 ↔ utilityProcess 写进程 租约握手缝（纯 Node 模块，零 electron 依赖）
 *
 * 背景：`query-proxy.ts`（database-service 层）在 J-13 每批 `.immediate()` 短事务前必须与
 * 写进程握手让锁，但直接 import `AnalysisDbWriterProcess` 会把 electron/utilityProcess 依赖
 * 拖进 database-service 模块图（与 `display-locale-seam.ts` 同一边界问题）。本缝沿用其裁决：
 * - 主进程：`AnalysisQueueService` 构造时注册真实握手实现（写进程实例 + 开关读取）；
 * - 未注册（写进程默认关闭 / 纯单测）：走本地直通，不握手——这是合法路径而非静默降级。
 *
 * 契约：握手失败（50ms ACK 超时）由宿主内部 logger.warn 并尽力而为继续，写锁等待 p99 兜底；
 * 本缝严禁静默吞异常，注册方必须保证 sendYieldAndWaitAck 自身留痕。
 *
 * @doc-anchor: docs/issues/desktop-database-write-performance/00-database-write-performance-plan.md#51-写路径收口与双写互斥协议begin-immediate--yield_for_uiresume
 */

/** 写进程租约握手实现（由 AnalysisQueueService 注册） */
export interface WriterLeaseHandshake {
  /** 写进程开关打开且子进程 isReady() 时才需要握手（否则 outbox 空塞命令批批白等） */
  isWriterProcessActive: () => boolean
  /** 事务外 await，返回是否收到 YIELD_ACK；超时由实现内部 logger.warn 留痕 */
  sendYieldAndWaitAck: (leaseId: string, timeoutMs: number) => Promise<boolean>
  /** finally 必发，释放同一 leaseId 租约 */
  resumeLease: (leaseId: string) => void
  /** 写入主连接 `.immediate()` 获取写锁等待耗时（ms），供 p99/Max 验收 */
  observeWriteLockWaitMs: (ms: number) => void
}

let handshake: WriterLeaseHandshake | null = null

/** 注册握手实现（幂等覆盖：后注册者生效，便于写进程重启后刷新实例引用） */
export function setWriterLeaseHandshake(next: WriterLeaseHandshake | null): void {
  handshake = next
}

/** 读取当前握手实现；未注册返回 null（调用方按本地直通处理） */
export function getWriterLeaseHandshake(): WriterLeaseHandshake | null {
  return handshake
}

/** 仅供单测复位 */
export function resetWriterLeaseHandshakeForTest(): void {
  handshake = null
}
