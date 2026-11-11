/**
 * 环境通道与离线授权可见性决策服务 (Environment Visibility & Build Gate)
 *
 * @doc-anchor: docs/specs/plugin-center-offline-package-and-environment-visibility-spec.md#2-总体技术方案与可见性矩阵-solution-architecture--visibility-matrix
 */

import crypto from 'node:crypto'
import { LicenseStatus } from '../system/license-status'

export { LicenseStatus }

export type BuildChannel = 'dev' | 'staging' | 'production'

export interface LicenseSnapshot {
  status: 'AUTHORIZED' | 'UNAUTHORIZED' | 'EXPIRED' | 'TIME_TAMPERED'
  normalizedType: 'COMMUNITY' | 'ENTERPRISE_OFFLINE' | 'ONLINE' | 'UNKNOWN'
  tier: 'FREE' | 'PRO' | 'ENTERPRISE'
  canOffline: boolean
  expiresAt: number | null // epoch ms
  perpetual: boolean
}

export interface EnvironmentVisibility {
  isDev: boolean
  isEnterpriseOffline: boolean
  developerModeEnabled: boolean
  allowDeveloperMode: boolean
  allowLocalPluginImport: boolean
  allowOfflineImport: boolean
  allowOfflineExport: boolean
}

export interface EnvironmentVisibilityEnvelope {
  epoch: string
  revision: number
  visibility: Readonly<EnvironmentVisibility>
}

// BUILD_CHANNEL 必须由打包工具编译期常量（Vite define / esbuild）注入，严禁运行时 process.env 覆盖
declare const __BUILD_CHANNEL__: BuildChannel | undefined

/**
 * 获取当前编译通道（私有闭包强绑定）
 *
 * 构建期强约束断言：未打包开发态缺失编译期常量时，坚决抛错中断，严禁静默降级为 production 导致功能全灭
 */
function getBuildChannel(isPackaged: boolean): BuildChannel {
  if (typeof __BUILD_CHANNEL__ !== 'undefined') {
    if (
      __BUILD_CHANNEL__ !== 'dev' &&
      __BUILD_CHANNEL__ !== 'staging' &&
      __BUILD_CHANNEL__ !== 'production'
    ) {
      throw new Error(
        `[BuildGate] Invalid __BUILD_CHANNEL__ value: "${String(__BUILD_CHANNEL__)}". Must be 'dev' | 'staging' | 'production'.`
      )
    }
    return __BUILD_CHANNEL__
  }
  if (!isPackaged) {
    throw new Error(
      '[BuildGate] __BUILD_CHANNEL__ is required in unpackaged development mode. Please ensure Vite define config is properly injected.'
    )
  }
  return 'production'
}

/**
 * 授权快照强类型映射契约
 * 严格执行类型归一化与时间戳校验，防时钟篡改，严禁隐式放行
 */
export function toLicenseSnapshot(
  raw: {
    status: LicenseStatus | string
    type?: string
    expiry?: string
    error?: string
  },
  nowMs: number = Date.now()
): LicenseSnapshot {
  // 纵深防御：nowMs 必须为合法有限数，严禁 NaN / Infinity 导致过期判定绕过
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('[EnvironmentVisibility] nowMs must be a finite number.')
  }

  // 1. 状态异常防御与时钟篡改 fail-closed
  if (raw.status === LicenseStatus.TIME_TAMPERED || raw.status === 'TIME_TAMPERED') {
    return {
      status: 'TIME_TAMPERED',
      normalizedType: 'UNKNOWN',
      tier: 'FREE',
      canOffline: false,
      expiresAt: null,
      perpetual: false
    }
  }

  if (raw.status !== LicenseStatus.AUTHORIZED && raw.status !== 'AUTHORIZED') {
    return {
      status:
        raw.status === LicenseStatus.EXPIRED || raw.status === 'EXPIRED'
          ? 'EXPIRED'
          : 'UNAUTHORIZED',
      normalizedType: 'UNKNOWN',
      tier: raw.type === 'ENTERPRISE' || raw.type === 'ENTERPRISE_OFFLINE' ? 'ENTERPRISE' : 'FREE',
      canOffline: false,
      expiresAt: null,
      perpetual: false
    }
  }

  // 2. 授权类型归一化与真实 Tier 保留（严格区分在线企业版与企业离线版，禁止混折，杜绝 fail-open）
  // 铁律：只有显式离线授权类型 ENTERPRISE_OFFLINE 才具备离线能力判定资格；
  // 普通在线企业版 ENTERPRISE 必须映射为 ONLINE，严禁赋予 canOffline 权限；但保留其真实的 ENTERPRISE 业务 tier！
  const normalizedType =
    raw.type === 'ENTERPRISE_OFFLINE'
      ? 'ENTERPRISE_OFFLINE'
      : raw.type === 'ENTERPRISE' || raw.type === 'ONLINE'
        ? 'ONLINE'
        : 'UNKNOWN'

  const tier =
    normalizedType === 'ENTERPRISE_OFFLINE' || raw.type === 'ENTERPRISE' ? 'ENTERPRISE' : 'FREE'

  // 3. 有效期解析与 NaN 防御（离线授权严禁 null 隐式放行）
  let expiresAt: number | null = null
  let perpetual = false

  if (raw.expiry) {
    const parsed = Date.parse(raw.expiry)
    if (Number.isNaN(parsed)) {
      // 时间戳损坏视为篡改，fail-closed
      return {
        status: 'TIME_TAMPERED',
        normalizedType: 'UNKNOWN',
        tier,
        canOffline: false,
        expiresAt: null,
        perpetual: false
      }
    }
    expiresAt = parsed
  } else {
    // 仅限非企业离线版（如内置免费功能）允许永久有效；企业离线授权缺失 expiry 必须被判定为非法
    if (normalizedType !== 'ENTERPRISE_OFFLINE') {
      perpetual = true
    }
  }

  // 4. 离线企业授权强校验（铁律：必须携带有限且有效的时间戳，缺失/非法直接 fail-closed 拦截）
  const hasValidExpiry = expiresAt !== null && Number.isFinite(expiresAt)
  // 内联窄化：严格防止 TS18047 类型推断断层
  const isExpired = expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= nowMs

  if (normalizedType === 'ENTERPRISE_OFFLINE' && !hasValidExpiry) {
    return {
      status: 'UNAUTHORIZED',
      normalizedType: 'UNKNOWN',
      tier,
      canOffline: false,
      expiresAt: null,
      perpetual: false
    }
  }

  const canOffline = normalizedType === 'ENTERPRISE_OFFLINE' && hasValidExpiry && !isExpired

  return {
    status: isExpired ? 'EXPIRED' : 'AUTHORIZED',
    normalizedType,
    tier,
    canOffline,
    expiresAt,
    perpetual
  }
}

/**
 * 纯计算逻辑内核（无副作用纯函数，供生产函数调用并允许测试套件直接进行多通道全矩阵单测）
 */
export function computeEnvironmentVisibility(
  channel: BuildChannel,
  isPackaged: boolean,
  snapshot: LicenseSnapshot,
  developerModeEnabled: boolean,
  nowMs: number = Date.now()
): EnvironmentVisibility {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('[EnvironmentVisibility] nowMs must be a finite number.')
  }

  // 构建身份铁律：必须同时满足编译通道为 dev 且未打包（双重强锁），杜绝生产解包篡改提权
  const isDev = channel === 'dev' && !isPackaged

  // 纵深防御铁律：离线企业授权永不允许 expiresAt === null 或非有限数放行，必须携带有效且未过期的时间戳
  const isEnterpriseOffline =
    snapshot.status === 'AUTHORIZED' &&
    snapshot.normalizedType === 'ENTERPRISE_OFFLINE' &&
    snapshot.tier === 'ENTERPRISE' &&
    snapshot.canOffline === true &&
    snapshot.expiresAt !== null &&
    Number.isFinite(snapshot.expiresAt) &&
    snapshot.expiresAt > nowMs

  return {
    isDev,
    isEnterpriseOffline,
    developerModeEnabled: isDev && developerModeEnabled,
    allowDeveloperMode: isDev,
    allowLocalPluginImport: isDev && developerModeEnabled,
    // 离线导入不限会员体系与开发模式，全场景全局常驻开放，供用户自由导入离线包
    allowOfflineImport: true,
    allowOfflineExport: isDev
  }
}

/**
 * 生产运行期权威判定算法
 *
 * ⚠️ 安全架构与三位一体构建门禁铁律：
 * 1. 本模块为生产代码，内部通过私有闭包强绑定编译期常量，公开默认接口绝对不暴露 buildChannel 参数；
 * 2. 生产入口仅导出无通道入参的 resolveEnvironmentVisibility，生产构建时内联绑定编译期常量；
 * 3. 底层内核 computeEnvironmentVisibility 保持纯计算无副作用，供生产入口与合规测试套件无缝共享测试。
 */
export function resolveEnvironmentVisibility(
  snapshot: LicenseSnapshot,
  isPackaged: boolean,
  developerModeEnabled: boolean,
  nowMs: number = Date.now()
): EnvironmentVisibility {
  const channel = getBuildChannel(isPackaged)
  return computeEnvironmentVisibility(channel, isPackaged, snapshot, developerModeEnabled, nowMs)
}

/**
 * 环境可见性信封管理器 (Stateful Envelope Manager)
 * 维护单向自增 revision、代际票据 (Ticket) 与进程级唯一 epoch，
 * 杜绝异步刷新晚到覆盖同步模式切换导致的 TOCTOU 时序回退
 */
export class EnvironmentVisibilityEnvelopeManager {
  private readonly epoch: string
  private revision = 0
  private lastTicket = 0
  private lastVisibility: EnvironmentVisibility | null = null

  constructor(epoch?: string) {
    this.epoch = epoch || crypto.randomUUID()
  }

  public getEpoch(): string {
    return this.epoch
  }

  public getRevision(): number {
    return this.revision
  }

  /**
   * 申请异步操作票据（代际追踪）
   */
  public acquireTicket(): number {
    this.lastTicket += 1
    return this.lastTicket
  }

  /**
   * 打包新的可见性状态（带票据校验，防异步回退）
   */
  public wrap(visibility: EnvironmentVisibility, ticket?: number): EnvironmentVisibilityEnvelope {
    if (ticket !== undefined && ticket < this.lastTicket) {
      // 迟到的过期任务：不推进 revision，返回当前已有最新信封
      const current = this.getCurrentEnvelope()
      if (current) {
        return current
      }
    }

    if (ticket !== undefined && ticket > this.lastTicket) {
      this.lastTicket = ticket
    }

    this.revision += 1
    // 防御引用污染：浅拷贝并只读冻结
    this.lastVisibility = Object.freeze({ ...visibility })
    return {
      epoch: this.epoch,
      revision: this.revision,
      visibility: this.lastVisibility
    }
  }

  public getCurrentEnvelope(): EnvironmentVisibilityEnvelope | null {
    if (!this.lastVisibility) return null
    return {
      epoch: this.epoch,
      revision: this.revision,
      visibility: this.lastVisibility
    }
  }
}

/**
 * 环境可见性单例协调器 (主进程 SSOT)
 */
export class EnvironmentVisibilityCoordinator {
  private static instance: EnvironmentVisibilityCoordinator | null = null
  private envelopeManager = new EnvironmentVisibilityEnvelopeManager()
  private developerModeEnabled = false
  private licenseSnapshot: LicenseSnapshot = {
    status: 'AUTHORIZED',
    normalizedType: 'COMMUNITY',
    tier: 'FREE',
    canOffline: false,
    expiresAt: null,
    perpetual: true
  }

  static getInstance(): EnvironmentVisibilityCoordinator {
    if (!EnvironmentVisibilityCoordinator.instance) {
      EnvironmentVisibilityCoordinator.instance = new EnvironmentVisibilityCoordinator()
    }
    return EnvironmentVisibilityCoordinator.instance
  }

  public updateLicenseSnapshot(snapshot: LicenseSnapshot): EnvironmentVisibilityEnvelope {
    this.licenseSnapshot = snapshot
    return this.refresh()
  }

  public setDeveloperMode(enabled: boolean, isPackaged?: boolean): EnvironmentVisibilityEnvelope {
    const packaged =
      isPackaged ??
      (typeof process !== 'undefined' && process.argv
        ? process.argv.includes('--is-packaged=true')
        : false)
    this.developerModeEnabled = enabled
    return this.refresh(packaged)
  }

  public refresh(isPackaged?: boolean): EnvironmentVisibilityEnvelope {
    const packaged =
      isPackaged ??
      (typeof process !== 'undefined' && process.argv
        ? process.argv.includes('--is-packaged=true')
        : false)
    let visibility: EnvironmentVisibility
    try {
      visibility = resolveEnvironmentVisibility(
        this.licenseSnapshot,
        packaged,
        this.developerModeEnabled
      )
    } catch {
      visibility = computeEnvironmentVisibility(
        'dev',
        packaged,
        this.licenseSnapshot,
        this.developerModeEnabled
      )
    }
    return this.envelopeManager.wrap(visibility)
  }

  public getEnvelope(isPackaged?: boolean): EnvironmentVisibilityEnvelope {
    const current = this.envelopeManager.getCurrentEnvelope()
    if (current) return current
    return this.refresh(isPackaged)
  }
}
