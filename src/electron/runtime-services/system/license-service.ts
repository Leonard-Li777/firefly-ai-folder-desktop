import { t } from '@app/languages'
import {
  LogCategory,
  logger,
  verifyLicense,
  encodeMachineIdToRef,
  SUPPORTED_LICENSE_VERSION,
  encodeMachineIdToBase64,
  isTestEnvironment
} from '@firefly/shared'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { SystemIdentityService } from './system-identity-service'
import { app, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { nativeFetch } from '../../utils/native-network'
import { regionDetectionService } from './region-detection-service'
import { KMLogic, HMAC_SALT } from '@firefly/server'
import type { UserTierData } from '@firefly/types'

export enum LicenseStatus {
  AUTHORIZED = 'AUTHORIZED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  EXPIRED = 'EXPIRED',
  TIME_TAMPERED = 'TIME_TAMPERED',
  PENDING_ONLINE = 'PENDING_ONLINE'
}

/**
 * Grace 期：3 天（72 小时）
 * 如果 LAST_SERVER_CONNECT_TIME 超过此时间，且 LAST_RUN_TIME 在此时间内，
 * 则判定服务器不可达，覆盖连通性检查结果
 */
const IS_DEV = process.env.NODE_ENV === 'development'
const GRACE_PERIOD_MS = IS_DEV ? 3 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000

export class LicenseService {
  private static instance: LicenseService
  private licenseFilePath: string
  private publicKey: string
  private isOnlineAuthorized = false // 内存中的在线授权状态
  private cachedResult: {
    status: LicenseStatus
    expiry?: string
    error?: string
    type?: string
  } | null = null // 缓存的授权状态
  private hmacKey: Buffer | null = null // HMAC 密钥，启动时派生一次
  private lastForceCheckTime = 0 // 上次强制检查的时间戳

  private constructor() {
    this.licenseFilePath = path.join(app.getPath('userData'), 'license.dat')
    // 公钥通过环境变量注入，或者在打包时定义
    const envKey = process.env.LICENSE_PUBLIC_KEY || ''
    this.publicKey = envKey.replace(/\\n/g, '\n')
  }

  /**
   * 派生 HMAC 密钥（启动时调用一次，缓存在内存中）
   */
  private deriveHmacKey(): Buffer {
    if (this.hmacKey) {
      return this.hmacKey
    }
    const machineId = SystemIdentityService.getInstance().getMachineId()
    this.hmacKey = crypto.createHmac('sha256', HMAC_SALT).update(machineId).digest()
    return this.hmacKey
  }

  /**
   * 验证时间戳 HMAC 签名
   * @returns true 表示签名有效或时间戳为默认值，false 表示被篡改
   */
  verifyTimeHmac(key: 'LAST_RUN_TIME' | 'LAST_SERVER_CONNECT_TIME'): boolean {
    const config = ConfigOrchestrator.getInstance()
    const value = config.getValue<number>(key) || 0
    const storedHmac = config.getValue<string>(`${key}_HMAC`)

    // 默认值（0）无需验证
    if (value === 0 && !storedHmac) {
      return true
    }

    // 无签名但有值，或有值但无签名，视为篡改
    if ((!storedHmac && value > 0) || (storedHmac && value === 0)) {
      logger.warn(LogCategory.SYSTEM, `[License] ${key} HMAC 状态异常，可能存在篡改`)
      return false
    }

    const hmacKey = this.deriveHmacKey()
    const expectedHmac = crypto.createHmac('sha256', hmacKey).update(value.toString()).digest('hex')

    if (storedHmac !== expectedHmac) {
      logger.warn(LogCategory.SYSTEM, `[License] ${key} HMAC 验证失败，可能存在篡改`)
      return false
    }

    return true
  }

  /**
   * 更新时间戳及其 HMAC 签名
   */
  private updateTimeWithHmac(
    key: 'LAST_RUN_TIME' | 'LAST_SERVER_CONNECT_TIME',
    value: number
  ): void {
    const config = ConfigOrchestrator.getInstance()
    const hmacKey = this.deriveHmacKey()
    const hmac = crypto.createHmac('sha256', hmacKey).update(value.toString()).digest('hex')

    const updates: Record<string, unknown> = {}
    updates[key] = value
    updates[`${key}_HMAC`] = hmac
    config.updateValues(updates)
  }

  /**
   * Grace 检查：服务器长期不可达检测
   * 如果 LAST_SERVER_CONNECT_TIME 超过 3 天，且 LAST_RUN_TIME 在 3 天内，
   * 则判定为离线，覆盖连通性检查结果
   * @returns true 表示通过（服务器可达或不在 grace 期内），false 表示触发 grace
   */
  checkServerConnectivityGrace(): boolean {
    const config = ConfigOrchestrator.getInstance()
    const currentTime = Date.now()

    // 验证 LAST_SERVER_CONNECT_TIME 的 HMAC
    if (!this.verifyTimeHmac('LAST_SERVER_CONNECT_TIME')) {
      // 篡改检测，重置为 0
      logger.warn(LogCategory.SYSTEM, '[License] LAST_SERVER_CONNECT_TIME 被篡改，重置为 0')
      this.updateTimeWithHmac('LAST_SERVER_CONNECT_TIME', 0)
    }

    // 验证 LAST_RUN_TIME 的 HMAC
    if (!this.verifyTimeHmac('LAST_RUN_TIME')) {
      // 篡改检测，重置为当前时间
      logger.warn(LogCategory.SYSTEM, '[License] LAST_RUN_TIME 被篡改，重置为当前时间')
      this.updateTimeWithHmac('LAST_RUN_TIME', currentTime)
    }

    const lastServerConnect = config.getValue<number>('LAST_SERVER_CONNECT_TIME') || 0
    const lastRun = config.getValue<number>('LAST_RUN_TIME') || 0
    console.log({
      lastServerConnect,
      lastRun,
      GRACE: currentTime - lastServerConnect,
      GRACE_PERIOD_MS
    })
    // 首次安装：LAST_SERVER_CONNECT_TIME 为 0，视为从未连接
    // 如果 LAST_SERVER_CONNECT_TIME 超过 3 天
    if (currentTime - lastServerConnect > GRACE_PERIOD_MS) {
      // 且 LAST_RUN_TIME 在 3 天内（说明应用在运行但未连接服务器）
      if (lastRun > 0 && currentTime - lastRun < GRACE_PERIOD_MS) {
        logger.warn(
          LogCategory.SYSTEM,
          '[License] Grace 检查触发：服务器超过 3 天不可达，但应用在运行'
        )
        return false
      }
    }

    return true
  }

  static getInstance(): LicenseService {
    if (!LicenseService.instance) {
      LicenseService.instance = new LicenseService()
    }
    return LicenseService.instance
  }

  /**
   * 获取本机标识码（邀请码）
   */
  async getInvitationCode(): Promise<string> {
    const machineId = SystemIdentityService.getInstance().getMachineId()
    return encodeMachineIdToRef(machineId)
  }

  /**
   * 获取本机标识码（44位 Base64 编码，无损可逆，供离线管理员签发授权）
   */
  async getIdentCode(): Promise<string> {
    const machineId = SystemIdentityService.getInstance().getMachineId()
    return encodeMachineIdToBase64(machineId)
  }

  /**
   * @deprecated 请使用 getIdentCode
   */
  async getBase64Code(): Promise<string> {
    return this.getIdentCode()
  }

  /**
   * 检查授权状态 (核心逻辑)
   */
  async checkLicenseStatus(
    force = false
  ): Promise<{ status: LicenseStatus; expiry?: string; error?: string; type?: string }> {
    // force 节流：5 秒内不重复强制检查，避免启动阶段短时间多次调用
    if (force && this.cachedResult) {
      const now = Date.now()
      if (now - this.lastForceCheckTime < 5000) {
        return this.cachedResult
      }
      this.lastForceCheckTime = now
    }

    if (!force && this.cachedResult) {
      return this.cachedResult
    }

    const machineId = SystemIdentityService.getInstance().getMachineId()
    const invitationCode = encodeMachineIdToRef(machineId)

    logger.info(LogCategory.SYSTEM, '[License] 开始授权状态校验...', {
      machineId,
      requestCode: invitationCode,
      licensePath: this.licenseFilePath,
      isOnlineAuthorized: this.isOnlineAuthorized,
      force
    })

    const runCheck = async (): Promise<{
      status: LicenseStatus
      expiry?: string
      error?: string
      type?: string
    }> => {
      if (isTestEnvironment()) {
        return { status: LicenseStatus.AUTHORIZED }
      }

      // 1. 优先检查离线授权文件 (最可靠，离线可用，企业版用户首选)
      const offlineResult = await this.checkOfflineLicense()
      if (offlineResult.status === LicenseStatus.AUTHORIZED) {
        logger.info(LogCategory.SYSTEM, `[License] 离线授权校验成功`)
        return offlineResult
      }

      // 记录离线授权是否过期，以便后续回退或兜底
      const isOfflineExpired = offlineResult.status === LicenseStatus.EXPIRED
      if (isOfflineExpired) {
        logger.warn(LogCategory.SYSTEM, `[License] 离线授权已过期，尝试回退到在线授权验证`)
      }

      // 2. 在线网络授权校验 (个人版/联网用户兜底)
      logger.info(LogCategory.SYSTEM, '[License] 开始校验在线授权真实网络连通性...')
      const isActuallyOnline = await this.checkRealConnectivity()

      if (isActuallyOnline) {
        logger.info(LogCategory.SYSTEM, '[License] 在线连通性校验通过，授予在线授权')
        if (!this.isOnlineAuthorized) {
          this.isOnlineAuthorized = true
        }
        // 更新服务器连通时间戳，确保 Grace 检测使用最新值
        this.updateTimeWithHmac('LAST_SERVER_CONNECT_TIME', Date.now())
        return { status: LicenseStatus.AUTHORIZED, type: 'ONLINE' }
      } else {
        logger.warn(LogCategory.SYSTEM, '[License] 在线连通性校验未通过，可能处于断网环境')
      }

      // 2.5 Grace 检查：服务器长期不可达检测
      // 如果 Supabase 不可达，检查是否触发 grace（3 天内有运行记录但未连接服务器）
      const gracePassed = this.checkServerConnectivityGrace()
      if (!gracePassed) {
        logger.warn(LogCategory.SYSTEM, '[License] Grace 检查未通过，服务器长期不可达')
        // 继续后续检查，最终会返回 UNAUTHORIZED
      }

      // 3. 检查时间回拨
      try {
        this.checkTimeIntegrity()
      } catch (e) {
        logger.warn(
          LogCategory.SYSTEM,
          '[License] 时间完整性校验失败:',
          e instanceof Error ? e.message : String(e)
        )
        return {
          status: LicenseStatus.TIME_TAMPERED,
          error: e instanceof Error ? e.message : '检测到系统时间异常'
        }
      }

      // 5. 最终兜底：如果之前离线授权过期了，即便没有在线授权，也应该返回 EXPIRED 而不是 UNAUTHORIZED
      if (isOfflineExpired) {
        return offlineResult
      }

      logger.info(LogCategory.SYSTEM, '[License] 未找到有效授权')
      return { status: LicenseStatus.UNAUTHORIZED }
    }

    const result = await runCheck()
    this.cachedResult = result
    return result
  }

  /**
   * 检查互联网真实连通性 (避免假阳性)
   */
  private async checkRealConnectivity(): Promise<boolean> {
    // 优化：优先使用 RegionDetectionService 的结果，避免重复探测
    const regionResult = regionDetectionService.getLastResult()
    if (regionResult) {
      const isActuallyOnline = regionResult.google || regionResult.baidu
      logger.debug(
        LogCategory.SYSTEM,
        `[License] 使用 RegionDetectionService 的探测结果: ${isActuallyOnline}`
      )
      if (isActuallyOnline) return true
    }

    const isOnline = net.isOnline()
    logger.info(LogCategory.SYSTEM, `[License] 开始检查网络连通性, net.isOnline(): ${isOnline}`)

    const orchestrator = ConfigOrchestrator.getInstance()
    const mirror = orchestrator.getValue<'cn' | 'global'>('DOWNLOAD_MIRROR') || 'cn'

    const checkUrl = async (url: string, timeoutMs: number) => {
      const start = Date.now()
      try {
        logger.debug(LogCategory.SYSTEM, `[License] 正在尝试连接: ${url} (超时: ${timeoutMs}ms)`)
        // 使用 Electron 原生 net 模块，与 Chrome 使用相同的网络栈
        const res = await nativeFetch(url, {
          method: 'HEAD',
          timeout: timeoutMs
        })
        logger.debug(
          LogCategory.SYSTEM,
          `[License] 连接成功: ${url}, 耗时: ${Date.now() - start}ms, 状态码: ${res.status}`
        )
        return res.status >= 200 && res.status < 400
      } catch (e) {
        logger.warn(
          LogCategory.SYSTEM,
          `[License] 连接失败: ${url}, 耗时: ${Date.now() - start}ms, 错误: ${e instanceof Error ? e.message : String(e)}`
        )
        return false
      }
    }

    // 1. 优先检查 Supabase 连通性 (这是本应用能正常工作的关键路径)
    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
    if (supabaseUrl) {
      const isSupabaseOk = await checkUrl(supabaseUrl, 5000)
      if (isSupabaseOk) {
        // Supabase 可达，更新 LAST_SERVER_CONNECT_TIME
        this.updateTimeWithHmac('LAST_SERVER_CONNECT_TIME', Date.now())
        return true
      }
    }

    // 2. 备选逻辑：如果主服务器宕机，通过地域对应的 HA 地址确认"用户确已联网"
    // 国际化支持：国内检查百度，国外检查 Google
    const fallbackUrl = mirror === 'global' ? 'https://www.google.com' : 'https://www.baidu.com'
    logger.info(LogCategory.SYSTEM, `[License] 主服务器连接失败，尝试备选地址: ${fallbackUrl}`)

    const isFallbackOk = await checkUrl(fallbackUrl, 5000)

    // 最终判定：如果 net.isOnline 为 false 但请求成功了，也认为是在线的
    if (isFallbackOk) return true

    // 如果所有请求都失败了，再看 net.isOnline 是否为 true。
    // 但通常如果请求全挂了，即便 net.isOnline 为 true 也没用。
    return false
  }

  /**
   * 检查本地离线授权文件 (兼容读取配置文件和物理文件)
   */
  private async checkOfflineLicense(): Promise<{
    status: LicenseStatus
    expiry?: string
    error?: string
    type?: string
  }> {
    const config = ConfigOrchestrator.getInstance()
    let licenseStr = config.getValue<string>('OFFLINE_LICENSE')

    if (!licenseStr && fs.existsSync(this.licenseFilePath)) {
      logger.info(
        LogCategory.SYSTEM,
        '[License] 配置中未找到授权，尝试读取本地授权文件:',
        this.licenseFilePath
      )
      licenseStr = fs.readFileSync(this.licenseFilePath, 'utf8')
      // 同步到配置中
      if (licenseStr) {
        await config.updateValue('OFFLINE_LICENSE', licenseStr, { source: 'runtime' })
      }
    }

    if (!licenseStr) {
      return { status: LicenseStatus.UNAUTHORIZED }
    }

    if (!this.publicKey) {
      return { status: LicenseStatus.UNAUTHORIZED, error: '系统配置错误' }
    }

    const machineId = SystemIdentityService.getInstance().getMachineId()
    const invitationCode = encodeMachineIdToRef(machineId)
    const identCode = encodeMachineIdToBase64(machineId)

    try {
      const result = await verifyLicense(licenseStr, this.publicKey)
      if (!result.valid || !result.data) {
        return { status: LicenseStatus.UNAUTHORIZED, error: result.error }
      }

      const { ids } = result.data

      // 校验设备码（支持原始 hex 设备码、Base62 邀请码、Base64 标识码三种格式）
      if (!ids.includes(machineId) && !ids.includes(invitationCode) && !ids.includes(identCode)) {
        return { status: LicenseStatus.UNAUTHORIZED, error: '授权码与当前机器不匹配' }
      }

      const data = result.data as any
      let expiry: string | undefined

      if (data.userTierData) {
        // EnterpriseLicenseData：从内嵌 userTierData 读取过期时间
        expiry = data.userTierData.subscription?.expires_at
      } else {
        // 旧版 LicenseData：读取顶级 expiry
        expiry = data.expiry
      }

      // 校验有效期
      if (expiry) {
        const expiryDate = new Date(expiry)
        if (expiryDate.getTime() < Date.now()) {
          return { status: LicenseStatus.EXPIRED, expiry }
        }
      }

      // 归一化企业版 type：旧格式 'ENTERPRISE_OFFLINE' → 'ENTERPRISE'
      const normalizedType = data.type === 'ENTERPRISE_OFFLINE' ? 'ENTERPRISE' : data.type
      return { status: LicenseStatus.AUTHORIZED, expiry, type: normalizedType }
    } catch (e) {
      return { status: LicenseStatus.UNAUTHORIZED, error: '校验失败' }
    }
  }

  /**
   * 将授权码中内嵌的 userTierData 写入本地缓存
   * 适用于 EnterpriseLicenseData 格式
   */
  private async writeEmbeddedUserTierData(
    userTierData: UserTierData,
    licenseCode: string,
    machineId: string
  ): Promise<void> {
    const config = ConfigOrchestrator.getInstance()

    // 写入 CACHE_KEY_DATA（密钥派生，必须保留供后续解密 USER_TIER_CACHE_DATA 使用）
    const rawKM = KMLogic.deriveKMFromLicense(licenseCode, machineId)
    const encryptedKMHex = KMLogic.encryptKM(rawKM, machineId)
    await config.updateValue('CACHE_KEY_DATA', encryptedKMHex, { source: 'runtime' })

    // 委托 UserTierService 完成密钥重派生、过期检测、computed_limits 重算与持久化
    const { userTierService } = await import('../user-tier/user-tier-service')
    await userTierService.restoreFromLicenseData(userTierData, machineId)
  }

  /**
   * 检测当前离线授权码是否包含内嵌 userTierData，
   * 若有则写入本地缓存（用于启动时离线恢复权益）
   */
  async restoreFromOfflineLicenseIfNeeded(): Promise<boolean> {
    const config = ConfigOrchestrator.getInstance()
    let licenseStr = config.getValue<string>('OFFLINE_LICENSE')

    if (!licenseStr && fs.existsSync(this.licenseFilePath)) {
      licenseStr = fs.readFileSync(this.licenseFilePath, 'utf8')
    }

    if (!licenseStr) return false
    if (!this.publicKey) return false

    const machineId = SystemIdentityService.getInstance().getMachineId()

    try {
      const result = await verifyLicense(licenseStr, this.publicKey)
      if (!result.valid || !result.data) return false

      const data = result.data as any
      if (!data.userTierData) return false

      await this.writeEmbeddedUserTierData(data.userTierData as UserTierData, licenseStr, machineId)
      return true
    } catch {
      return false
    }
  }

  /**
   * 激活离线授权码
   */
  async activate(licenseCode: string): Promise<{ success: boolean; error?: string }> {
    const config = ConfigOrchestrator.getInstance()
    const machineId = SystemIdentityService.getInstance().getMachineId()
    const invitationCode = encodeMachineIdToRef(machineId)
    const identCode = encodeMachineIdToBase64(machineId)

    if (!this.publicKey) {
      return { success: false, error: t('系统未配置公钥') }
    }

    const result = await verifyLicense(licenseCode, this.publicKey)
    if (!result.valid || !result.data) {
      return { success: false, error: result.error || '授权码无效' }
    }

    if (
      !result.data.ids.includes(machineId) &&
      !result.data.ids.includes(invitationCode) &&
      !result.data.ids.includes(identCode)
    ) {
      return { success: false, error: t('该授权码不适用于当前机器') }
    }

    // 检查是否为 EnterpriseLicenseData（内嵌 userTierData）
    const isEnterpriseFormat = 'userTierData' in result.data
    if (isEnterpriseFormat) {
      // 新版企业授权码：直接使用内嵌的数据
      const enterpriseData = result.data as any
      const userTierData = enterpriseData.userTierData as UserTierData
      const expiresAt = userTierData.subscription?.expires_at

      if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
        return { success: false, error: t('该授权码已过期') }
      }
    } else {
      // 旧版授权码：使用 expiry 字段
      const expiryDate = new Date((result.data as any).expiry)
      if (expiryDate.getTime() < Date.now()) {
        return { success: false, error: t('该授权码已过期') }
      }
    }

    // 持久化到文件和配置
    try {
      fs.writeFileSync(this.licenseFilePath, licenseCode, 'utf8')
      await config.updateValue('OFFLINE_LICENSE', licenseCode, { source: 'runtime' })

      if (isEnterpriseFormat) {
        const enterpriseData = result.data as any
        await this.writeEmbeddedUserTierData(
          enterpriseData.userTierData as UserTierData,
          licenseCode,
          machineId
        )
      } else {
        // 旧版授权码：派生 KM 写入 CACHE_KEY_DATA
        const rawKM = KMLogic.deriveKMFromLicense(licenseCode, machineId)
        const encryptedKMHex = KMLogic.encryptKM(rawKM, machineId)
        await config.updateValue('CACHE_KEY_DATA', encryptedKMHex, { source: 'runtime' })
      }

      this.cachedResult = null // 激活成功后清除缓存

      // 重置 userTierService 密钥缓存并重新同步以更新等级
      const { userTierService } = await import('../user-tier/user-tier-service')
      // @ts-ignore
      userTierService.encryptionKey = null
      // @ts-ignore
      userTierService.hmacKey = null

      // 触发本地等级计算更新与通知
      userTierService.syncLocalCacheAndNotify(machineId).catch(err => {
        logger.error(LogCategory.SYSTEM, '[License] 激活后同步用户等级失败:', err)
      })

      return { success: true }
    } catch (e) {
      return { success: false, error: t('写入授权失败') }
    }
  }

  /**
   * 时间完整性检查
   */
  checkTimeIntegrity(): void {
    const config = ConfigOrchestrator.getInstance()
    const currentTime = Date.now()

    // 验证 LAST_RUN_TIME 的 HMAC
    if (!this.verifyTimeHmac('LAST_RUN_TIME')) {
      logger.warn(LogCategory.SYSTEM, '[License] LAST_RUN_TIME HMAC 验证失败，重置为当前时间')
      this.updateTimeWithHmac('LAST_RUN_TIME', currentTime)
      return // 重置后继续，不阻断
    }

    const lastRun = config.getValue<number>('LAST_RUN_TIME') || 0

    if (lastRun > 0 && currentTime < lastRun - 5 * 60 * 1000) {
      // 允许 5 分钟误差
      throw new Error('检测到系统时间异常，请校准时间后再运行。')
    }

    // 更新最后运行时间及其 HMAC
    this.updateTimeWithHmac('LAST_RUN_TIME', currentTime)
  }

  /**
   * 初始化 Grace 时间戳
   * 首次安装时设置 LAST_SERVER_CONNECT_TIME 为当前时间（3 天窗口期）
   */
  initializeGraceTimestamps(): void {
    const config = ConfigOrchestrator.getInstance()
    const lastServerConnect = config.getValue<number>('LAST_SERVER_CONNECT_TIME') || 0

    // 首次安装：LAST_SERVER_CONNECT_TIME 为 0，设置为当前时间
    if (lastServerConnect === 0) {
      logger.info(
        LogCategory.SYSTEM,
        '[License] 首次安装，初始化 LAST_SERVER_CONNECT_TIME 为当前时间'
      )
      this.updateTimeWithHmac('LAST_SERVER_CONNECT_TIME', Date.now())
    }

    // 验证 LAST_RUN_TIME 的 HMAC
    if (!this.verifyTimeHmac('LAST_RUN_TIME')) {
      logger.warn(LogCategory.SYSTEM, '[License] LAST_RUN_TIME HMAC 验证失败，重置为当前时间')
      this.updateTimeWithHmac('LAST_RUN_TIME', Date.now())
    }

    // 验证 LAST_SERVER_CONNECT_TIME 的 HMAC
    if (!this.verifyTimeHmac('LAST_SERVER_CONNECT_TIME')) {
      logger.warn(
        LogCategory.SYSTEM,
        '[License] LAST_SERVER_CONNECT_TIME HMAC 验证失败，重置为当前时间'
      )
      this.updateTimeWithHmac('LAST_SERVER_CONNECT_TIME', Date.now())
    }
  }

  /**
   * 检查在线授权状态
   */
  setOnlineAuthorized(authorized: boolean): void {
    this.isOnlineAuthorized = authorized
    this.cachedResult = null // 在线状态变更时清除缓存
    logger.info(LogCategory.SYSTEM, `[License] 设置在线授权状态为: ${authorized}`)
  }

  private timeMonitorTimer: NodeJS.Timeout | null = null

  /**
   * 启动定时更新运行时间
   */
  startTimeMonitor(): void {
    if (this.timeMonitorTimer) {
      clearInterval(this.timeMonitorTimer)
    }
    this.timeMonitorTimer = setInterval(
      () => {
        try {
          this.updateTimeWithHmac('LAST_RUN_TIME', Date.now())
        } catch (e) {
          logger.error(LogCategory.SYSTEM, '更新最后运行时间失败', e)
        }
      },
      10 * 60 * 1000
    ) // 每10分钟
  }

  /**
   * 停止定时更新运行时间
   */
  stopTimeMonitor(): void {
    if (this.timeMonitorTimer) {
      clearInterval(this.timeMonitorTimer)
      this.timeMonitorTimer = null
    }
  }
}
