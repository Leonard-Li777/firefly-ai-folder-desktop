/**
 * 引擎状态徽章派生（PRD-0045）
 *
 * 单枚徽章文案优先级（严格互斥）：
 *   引擎异常 > 已启动 > 已连接 > 检测中... / 引擎未部署 / 未连接
 *
 * 着色规则：仅选中态（生效引擎）正常着色；非选中一律置灰，
 * 表示连接/启动与否与当前链路无关。
 */

export type EngineBadgeIcon = 'connected' | 'disconnected' | 'starting' | 'error' | 'started'

export type EngineBadgeStatus =
  | 'error'
  | 'started'
  | 'connected'
  | 'detecting'
  | 'not-deployed'
  | 'disconnected'

export interface LocalBadgeFacts {
  /** 首次加载中且尚无快照 */
  detecting: boolean
  /** AI 服务 ERROR / 引擎异常 */
  failed: boolean
  /** HTTP 探活成功 */
  connected: boolean
  /** 推理服务就绪（raw.status === 'ready'） */
  started: boolean
  /** 引擎二进制已部署 */
  available: boolean
}

export interface CloudBadgeFacts {
  /** 生效=云端时探活/分析抛错 */
  failed: boolean
  /** 轻量请求有回应（粘性） */
  started: boolean
  /** 已成功拉取模型列表且已选定云端模型 */
  connected: boolean
  /** 探针进行中 */
  probing: boolean
}

export interface EngineBadgeInput {
  selected: boolean
  local?: LocalBadgeFacts
  cloud?: CloudBadgeFacts
}

export interface EngineBadgeResult {
  status: EngineBadgeStatus
  icon: EngineBadgeIcon
  /** 选中态色类；非选中由派生结果统一覆盖为置灰 */
  cls: string
  /** 是否置灰（非选中） */
  grayed: boolean
}

const CLS = {
  error: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
  started: 'bg-green-500/10 text-green-700 dark:text-green-500 border-green-500/20',
  connected: 'bg-green-500/10 text-green-700 dark:text-green-500 border-green-500/20',
  detecting: 'bg-muted text-muted-foreground',
  notDeployed: 'bg-muted text-muted-foreground',
  disconnected: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-500 border-yellow-500/20',
  grayed: 'bg-muted text-muted-foreground border-border/40'
} as const

function fromLocal(facts: LocalBadgeFacts): EngineBadgeResult {
  // 引擎异常永远最高（压住已启动/已连接）
  if (facts.failed) {
    return { status: 'error', icon: 'error', cls: CLS.error, grayed: false }
  }
  if (facts.started) {
    return { status: 'started', icon: 'started', cls: CLS.started, grayed: false }
  }
  if (facts.connected) {
    return { status: 'connected', icon: 'connected', cls: CLS.connected, grayed: false }
  }
  if (facts.detecting) {
    return { status: 'detecting', icon: 'starting', cls: CLS.detecting, grayed: false }
  }
  if (!facts.available) {
    return { status: 'not-deployed', icon: 'error', cls: CLS.notDeployed, grayed: false }
  }
  return { status: 'disconnected', icon: 'disconnected', cls: CLS.disconnected, grayed: false }
}

function fromCloud(facts: CloudBadgeFacts): EngineBadgeResult {
  if (facts.failed) {
    return { status: 'error', icon: 'error', cls: CLS.error, grayed: false }
  }
  if (facts.started) {
    return { status: 'started', icon: 'started', cls: CLS.started, grayed: false }
  }
  if (facts.connected) {
    return { status: 'connected', icon: 'connected', cls: CLS.connected, grayed: false }
  }
  if (facts.probing) {
    return { status: 'detecting', icon: 'starting', cls: CLS.detecting, grayed: false }
  }
  return { status: 'disconnected', icon: 'disconnected', cls: CLS.disconnected, grayed: false }
}

/**
 * 派生引擎状态徽章。文案由调用方按 status 用 t(静态字面量) 包裹（t 只收静态字符串）；
 * 非选中态强制置灰色类（文案仍反映真实状态）。
 */
export function deriveEngineBadge(input: EngineBadgeInput): EngineBadgeResult {
  const base = input.cloud
    ? fromCloud(input.cloud)
    : input.local
      ? fromLocal(input.local)
      : {
          status: 'disconnected' as EngineBadgeStatus,
          icon: 'disconnected' as EngineBadgeIcon,
          cls: CLS.disconnected,
          grayed: false
        }
  if (input.selected) return base
  return { ...base, cls: CLS.grayed, grayed: true }
}
