// @doc-anchor: docs/specs/user-membership-and-multi-device-management-spec.md#44-已登录设备离线冷启动与-30-天软提示
// @doc-anchor: docs/specs/user-based-invitation-and-mandatory-email-binding-spec.md
import os from 'os'
import crypto from 'crypto'
import { WORKSPACE_CONSTANTS } from '@firefly/server'
import { logger, LogCategory, getSharedSchemaName } from '@firefly/shared'
import { SystemIdentityService } from './system-identity-service'
import { RemoteConfigService } from './remote-config-service'
import { createSupabaseClient } from './supabase-client-factory'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { SupabaseClient } from '@supabase/supabase-js'
import { getMainWindow } from '../../main/window'

export interface DeviceBindStatus {
  success: boolean
  bound: boolean
  slot_index?: number
  account_tier?: string
  device_tier?: string
  status?: 'active' | 'unclaimed' | 'unbound'
  device_consumed_invitation?: boolean
  error?: string
}

export interface UnseatedSessionStatus {
  unseated: boolean
  seated?: boolean
  sessionToken?: string
  error?: string
}

export interface DeviceBindCodeResult {
  success: boolean
  code?: string
  pollSecret?: string
  imageDataUrl?: string
  expiresAt?: string
  deviceLabel?: string
  platform?: string
  machineIdTail?: string
  error?: string
}

export interface PollBindResultResponse {
  success: boolean
  status?: 'pending' | 'bound' | 'need_evict' | 'requires_email_binding' | 'expired' | 'error'
  bind_session_token?: string
  session_expires_at?: string
  device_token?: string
  session_id?: string
  seated?: boolean
  user?: {
    id: string
    ref_code?: string
    email_canonical?: string
  }
  error?: string
  message?: string
}

export interface SeatedDeviceItem {
  id: string
  machine_id_tail: string
  slot_index: number
  device_label: string
  platform: string
  is_locked: boolean
  zombie_exempt?: boolean
  bound_at: string
  last_seen_at?: string
  is_current_machine: boolean
}

export interface ListSeatedDevicesResponse {
  success: boolean
  devices?: SeatedDeviceItem[]
  slot_limit?: number
  active_count?: number
  monthly_unbind_limit?: number
  monthly_unbind_remaining?: number
  error?: string
  message?: string
}

export interface SeatDeviceResponse {
  success: boolean
  seated?: boolean
  takeover?: boolean
  need_evict?: boolean
  slot_index?: number
  monthly_unbind_limit?: number
  monthly_unbind_remaining?: number
  error?: string
  message?: string
}

export interface SendEmailOtpResponse {
  success: boolean
  cooldown_seconds?: number
  expires_in_seconds?: number
  error?: string
  message?: string
}

export interface CompleteEmailBindingResponse {
  success: boolean
  status?: string
  seated?: boolean
  need_evict?: boolean
  contact_channel?: 'email' | 'wechat_oa'
  device_token?: string
  user?: {
    id: string
    ref_code?: string
    email_canonical?: string
    contact_channel?: 'email' | 'wechat_oa'
  }
  invitation_result?: {
    success: boolean
    code?: string
    message?: string
  }
  error?: string
  message?: string
}

export class DeviceBindService {
  private static instance: DeviceBindService | null = null

  private constructor() {}

  public static getInstance(): DeviceBindService {
    if (!DeviceBindService.instance) {
      DeviceBindService.instance = new DeviceBindService()
    }
    return DeviceBindService.instance
  }

  private getClient(): SupabaseClient {
    const sharedClient = RemoteConfigService.getInstance().getSupabaseClient()
    if (sharedClient) {
      return sharedClient
    }
    const identityService = SystemIdentityService.getInstance()
    return createSupabaseClient(
      WORKSPACE_CONSTANTS.SUPABASE_URL,
      WORKSPACE_CONSTANTS.SUPABASE_ANON_KEY,
      identityService.getMachineId(),
      identityService.getSignature()
    )
  }

  /**
   * 统一从 FunctionsHttpError.context 中解析 Edge Function 返回的 JSON 载荷
   */
  private async extractFunctionErrorPayload(error: any): Promise<Record<string, any> | null> {
    try {
      const ctx = error?.context
      if (ctx && typeof ctx.json === 'function') {
        const parsed = await ctx.json()
        if (parsed && typeof parsed === 'object') {
          return parsed
        }
      }
    } catch (parseErr) {
      logger.warn(
        LogCategory.SYSTEM,
        '[DeviceBindService] 解析 Edge Function 错误响应体失败:',
        parseErr
      )
    }
    return null
  }

  /**
   * 判断是否属于网络层断网或连通性失败异常 (防底层英文黑话外泄)
   */
  private isNetworkError(error: any): boolean {
    if (!error) return false
    const name = String(error?.name || '')
    const msg = String(error?.message || '')
    return (
      name === 'FunctionsFetchError' ||
      name === 'FetchError' ||
      msg.includes('Failed to send a request') ||
      msg.includes('fetch failed') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('network')
    )
  }

  /**
   * 将底层异常转译为用户大白话提示 (符合 AGENTS.md §2.16 大白话禁术语红线)
   */
  private resolveFriendlyErrorMessage(
    error: any,
    payloadMessage?: string,
    defaultFallback = '操作失败，请重试'
  ): string {
    if (this.isNetworkError(error)) {
      return '网络连接失败，请检查网络设置后再试'
    }
    const msg = payloadMessage || error?.message
    if (!msg) return defaultFallback
    if (this.isNetworkError({ message: msg })) {
      return '网络连接失败，请检查网络设置后再试'
    }
    return msg
  }

  /**
   * 安全持久化设备凭据 (Windows 平台通过 safeStorage 自动加密，直写 ConfigOrchestrator 单一事实源)
   */
  public async setDeviceToken(token: string): Promise<void> {
    try {
      await ConfigOrchestrator.getInstance().updateValue('DEVICE_AUTH_TOKEN', token)
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] 持久化 DEVICE_AUTH_TOKEN 异常:', err)
      throw err
    }
  }

  public getDeviceToken(): string | null {
    try {
      const token = ConfigOrchestrator.getInstance().getValue('DEVICE_AUTH_TOKEN') as string
      return token && token.trim().length > 0 ? token : null
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 读取 DEVICE_AUTH_TOKEN 异常:', err)
      return null
    }
  }

  public async clearDeviceToken(): Promise<void> {
    try {
      await ConfigOrchestrator.getInstance().updateValue('DEVICE_AUTH_TOKEN', '')
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 清理 DEVICE_AUTH_TOKEN 异常:', err)
    }
  }

  /**
   * 安全持久化绑定会话凭据 (供阶段二邮箱绑定使用)
   */
  public async setBindSessionToken(token: string): Promise<void> {
    try {
      await ConfigOrchestrator.getInstance().updateValue('BIND_SESSION_TOKEN', token)
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] 持久化 BIND_SESSION_TOKEN 异常:', err)
      throw err
    }
  }

  public getBindSessionToken(): string | null {
    try {
      const token = ConfigOrchestrator.getInstance().getValue('BIND_SESSION_TOKEN') as string
      return token && token.trim().length > 0 ? token : null
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 读取 BIND_SESSION_TOKEN 异常:', err)
      return null
    }
  }

  /**
   * 清理绑定会话凭据
   */
  public async clearBindSessionToken(): Promise<void> {
    try {
      await ConfigOrchestrator.getInstance().updateValue('BIND_SESSION_TOKEN', '')
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 清理 BIND_SESSION_TOKEN 异常:', err)
    }
  }

  /**
   * 重置绑定状态回退至阶段一微信扫码（清理本地失效的 BIND_SESSION_TOKEN）
   */
  public async resetToQr(): Promise<void> {
    await this.clearBindSessionToken()
  }

  /**
   * 检查本地是否存在有效且尚未消费的 BIND_SESSION_TOKEN
   */
  public hasActiveBindSession(): boolean {
    const token = this.getBindSessionToken()
    return !!token && token.trim().length > 0
  }

  /**
   * 检查本地已存储的 DEVICE_AUTH_TOKEN 是否对应一个尚未入席（seated=false）的活跃会话，
   * 若会话已过期或被吊销则同步清空无效凭据，确保软件重启后能准确恢复换绑弹窗。
   */
  public async getUnseatedSession(): Promise<UnseatedSessionStatus> {
    const token = this.getDeviceToken()
    if (!token) {
      return { unseated: false }
    }

    try {
      const client = this.getClient()
      const { data, error } = await client.functions.invoke('seat-device', {
        headers: {
          authorization: `Bearer ${token}`
        },
        body: {
          action: 'status'
        }
      })

      if (error) {
        const errPayload = await this.extractFunctionErrorPayload(error)
        const errCode = errPayload?.error
        if (
          errCode === 'SESSION_EXPIRED' ||
          errCode === 'UNAUTHORIZED' ||
          errCode === 'DEVICE_UNBOUND'
        ) {
          await this.clearDeviceToken()
          return { unseated: false, error: errCode }
        }
        logger.warn(
          LogCategory.SYSTEM,
          '[DeviceBindService] getUnseatedSession 调用失败:',
          errPayload || error.message
        )
        return { unseated: false, error: errCode || error.message }
      }

      if (data?.success) {
        return {
          unseated: !data.seated,
          seated: !!data.seated,
          sessionToken: !data.seated ? token : undefined
        }
      }

      return { unseated: false, error: data?.error }
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, '[DeviceBindService] getUnseatedSession 异常:', err)
      return { unseated: false, error: err?.message || 'unknown' }
    }
  }

  /**
   * 查询当前设备在云端的绑定状态 (Resolve-on-Read)
   */
  public async getDeviceBindStatus(): Promise<DeviceBindStatus> {
    try {
      const machineId = SystemIdentityService.getInstance().getMachineId()
      if (!machineId) {
        return { success: false, bound: false, error: 'machine_id_missing' }
      }

      const client = this.getClient()
      const schema = getSharedSchemaName()
      const { data, error } = await (client as any)
        .schema(schema)
        .rpc('rpc_get_device_bind_status', {
          p_machine_id: machineId
        })

      if (error) {
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 查询设备绑定状态失败:', error)
        return { success: false, bound: false, error: error.message }
      }

      return {
        success: true,
        bound: !!data?.bound,
        slot_index: data?.slot_index,
        account_tier: data?.account_tier,
        device_tier: data?.device_tier,
        status: data?.status,
        device_consumed_invitation: !!data?.device_consumed_invitation
      }
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 异常:', err)
      return { success: false, bound: false, error: err?.message || 'unknown' }
    }
  }

  /**
   * 生成设备绑定短码并拉取微信官方带参小程序码图片
   * 遵循高安全轮询契约：
   * 1. 客户端生成 32 字节高熵随机 poll_secret；
   * 2. 计算 SHA256 散列后传入 rpc_create_device_bind_code (p_poll_secret_hash)；
   * 3. 短码与小程序码配套下发，轮询时必须持有原始 poll_secret。
   */
  public async createDeviceBindCode(forceRefresh = false): Promise<DeviceBindCodeResult> {
    try {
      const machineId = SystemIdentityService.getInstance().getMachineId()
      if (!machineId) {
        return { success: false, error: 'machine_id_missing' }
      }

      const client = this.getClient()
      const platform =
        process.platform === 'darwin'
          ? 'darwin'
          : process.platform === 'win32'
            ? 'windows'
            : 'linux'
      const deviceLabel = os.hostname()

      // 客户端生成 32 字节高熵随机十六进制 poll_secret
      const pollSecret = crypto.randomBytes(32).toString('hex')
      const pollSecretHash = crypto.createHash('sha256').update(pollSecret).digest('hex')

      let code = ''
      let expiresAt = ''
      let imageDataUrl = ''

      // 1. 调用云端原子 RPC rpc_create_device_bind_code 生成 8 位设备绑定码
      try {
        const schema = getSharedSchemaName()
        const { data: rpcData, error: rpcErr } = await (client as any)
          .schema(schema)
          .rpc('rpc_create_device_bind_code', {
            p_machine_id: machineId,
            p_platform: platform,
            p_device_label: deviceLabel,
            p_poll_secret_hash: pollSecretHash,
            p_force_refresh: !!forceRefresh
          })

        if (!rpcErr && rpcData?.success && rpcData?.code) {
          code = rpcData.code
          const expiresInSec = Number(rpcData.expires_in_seconds) || 300
          expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString()
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            '[DeviceBindService] rpc_create_device_bind_code 失败:',
            rpcErr || rpcData
          )
        }
      } catch (rpcEx) {
        logger.warn(
          LogCategory.SYSTEM,
          '[DeviceBindService] 调用 rpc_create_device_bind_code 异常:',
          rpcEx
        )
      }

      if (!code) {
        return { success: false, error: '生成微信登录码失败，请检查网络连接' }
      }

      // 2. 将设备绑定短码提交给 Edge Function wxpay-qrcode (type='bind')，获取微信官方真实小程序码
      let qrErrorMsg = ''
      try {
        const { data: qrData, error: qrErr } = await client.functions.invoke('wxpay-qrcode', {
          body: { type: 'bind', code }
        })
        if (!qrErr && qrData?.imageDataUrl && qrData.imageDataUrl.startsWith('data:image/')) {
          imageDataUrl = qrData.imageDataUrl
        } else {
          const errPayload = qrErr ? await this.extractFunctionErrorPayload(qrErr) : null
          qrErrorMsg =
            errPayload?.message ||
            errPayload?.error ||
            qrData?.message ||
            qrData?.error ||
            qrErr?.message ||
            '微信二维码生成失败，请稍后重试'
          logger.warn(
            LogCategory.SYSTEM,
            '[DeviceBindService] wxpay-qrcode bind 换码失败:',
            errPayload || qrErr || qrData
          )
        }
      } catch (qrEx: any) {
        qrErrorMsg = qrEx?.message || '获取微信二维码网络异常，请稍后重试'
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 调用 wxpay-qrcode bind 异常:', qrEx)
      }

      if (!imageDataUrl) {
        return { success: false, error: qrErrorMsg || '微信二维码生成失败，请点击刷新重试' }
      }

      return {
        success: true,
        code,
        pollSecret,
        imageDataUrl,
        expiresAt: expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        deviceLabel,
        platform,
        machineIdTail: machineId.slice(-4)
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] 创建绑定码异常:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  }

  /**
   * 轮询设备绑定状态 (对接创世基线四态 rpc_get_device_bind_status)
   */
  public async pollBindResult(code: string, pollSecret: string): Promise<PollBindResultResponse> {
    try {
      const client = this.getClient()
      const schema = getSharedSchemaName()
      const { data, error } = await (client as any)
        .schema(schema)
        .rpc('rpc_get_device_bind_status', {
          p_code: code,
          p_poll_secret: pollSecret
        })

      if (error) {
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 轮询设备绑定结果异常:', error)
        return { success: false, error: error.message }
      }

      if (data?.error === 'CODE_EXPIRED') {
        return { success: false, status: 'expired', error: 'CODE_EXPIRED' }
      }

      if (data?.error === 'CLAIM_PENDING') {
        return {
          success: false,
          status: 'error',
          error: 'CLAIM_PENDING',
          message: '当前二维码正在其他手机端确认，请稍等片刻或刷新重试'
        }
      }

      if (!data?.success && data?.error) {
        return { success: false, error: data.error }
      }

      // 分支 A: pending 待手机扫码确认
      if (data?.status === 'pending') {
        return { success: true, status: 'pending' }
      }

      // 分支 B: requires_email_binding (阶段二国内版邮箱强制阻断绑定)
      if (data?.status === 'requires_email_binding') {
        if (data.bind_session_token) {
          await this.setBindSessionToken(data.bind_session_token)
        }
        return {
          success: true,
          status: 'requires_email_binding',
          bind_session_token: data.bind_session_token,
          user: data.user
        }
      }

      // 分支 C: claimed / consumed (手机端已确认且已完成邮箱验证)
      if (data?.status === 'claimed' || data?.status === 'consumed') {
        const sessionToken = data.session_token
        const sessionId = data.session_id
        if (sessionToken) {
          await this.setDeviceToken(sessionToken)
        }

        // 若已就席入座 (seated === true)
        if (data.seated) {
          return {
            success: true,
            status: 'bound',
            device_token: sessionToken,
            session_id: sessionId,
            seated: true,
            user: data.user
          }
        }

        // 若未就席 (seated === false)，后台尝试自动分配席位入座
        if (sessionToken) {
          const seatRes = await this.seatThisDevice(sessionToken, null)
          if (seatRes.success && seatRes.seated) {
            return {
              success: true,
              status: 'bound',
              device_token: sessionToken,
              session_id: sessionId,
              seated: true,
              user: data.user
            }
          }

          // 遇满 6 台席位拦截 (NEED_EVICT)
          if (seatRes.need_evict) {
            return {
              success: true,
              status: 'need_evict',
              device_token: sessionToken,
              session_id: sessionId,
              seated: false,
              user: data.user
            }
          }

          // 入席失败时严禁伪报 bound，如实向上层透传错误状态与原因
          return {
            success: false,
            status: 'error',
            device_token: sessionToken,
            session_id: sessionId,
            seated: false,
            user: data.user,
            error: seatRes.error || 'SEAT_FAILED',
            message: seatRes.message || '设备入席失败，请重试'
          }
        }

        return {
          success: false,
          status: 'error',
          session_id: sessionId,
          seated: false,
          user: data.user,
          error: 'MISSING_SESSION_TOKEN',
          message: '未获取到有效设备会话凭据，请刷新二维码重试'
        }
      }

      return {
        success: true,
        status: data?.status || 'pending',
        device_token: data?.session_token,
        session_id: data?.session_id,
        user: data?.user
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] pollBindResult 异常:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  }

  /**
   * 桌面端席位分配或换绑 (通过 Edge Function seat-device 网关)
   */
  public async seatThisDevice(
    sessionToken?: string,
    evictDeviceId?: string | null
  ): Promise<SeatDeviceResponse> {
    try {
      const token = sessionToken || this.getDeviceToken()
      if (!token) {
        return { success: false, error: 'NO_SESSION_TOKEN', message: '缺少有效会话凭据' }
      }

      const client = this.getClient()
      const { data, error } = await client.functions.invoke('seat-device', {
        headers: {
          authorization: `Bearer ${token}`
        },
        body: {
          evictDeviceId: evictDeviceId || null
        }
      })

      if (error) {
        const errPayload = await this.extractFunctionErrorPayload(error)
        logger.warn(
          LogCategory.SYSTEM,
          '[DeviceBindService] seat-device 网关调用失败:',
          errPayload || error
        )
        const friendlyMessage = this.resolveFriendlyErrorMessage(error, errPayload?.message)
        return {
          success: false,
          error:
            errPayload?.error || (this.isNetworkError(error) ? 'NETWORK_ERROR' : error.message),
          need_evict: !!(errPayload?.need_evict || errPayload?.error === 'NEED_EVICT'),
          monthly_unbind_limit: errPayload?.monthly_unbind_limit,
          monthly_unbind_remaining: errPayload?.monthly_unbind_remaining,
          message: friendlyMessage
        }
      }

      if (!data?.success) {
        return {
          success: false,
          error: data?.error || 'SEAT_FAILED',
          need_evict: !!(data?.need_evict || data?.error === 'NEED_EVICT'),
          monthly_unbind_limit: data?.monthly_unbind_limit,
          monthly_unbind_remaining: data?.monthly_unbind_remaining,
          message: data?.message
        }
      }

      // 仅当成功入座 (seated === true) 时，原子写入永久 DEVICE_AUTH_TOKEN 并清理临时 BIND_SESSION_TOKEN
      if (data.seated && sessionToken) {
        await this.setDeviceToken(sessionToken)
        await this.clearBindSessionToken()
      }

      return {
        success: true,
        seated: !!data.seated,
        takeover: !!data.takeover,
        slot_index: data.slot_index,
        monthly_unbind_limit: data.monthly_unbind_limit,
        monthly_unbind_remaining: data.monthly_unbind_remaining,
        message: data.message
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] seatThisDevice 异常:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  }

  /**
   * 拉取当前账号已绑定的 6 席位设备列表
   */
  public async listSeatedDevices(sessionToken?: string): Promise<ListSeatedDevicesResponse> {
    try {
      const token = sessionToken || this.getDeviceToken()
      if (!token) {
        return { success: false, error: 'NO_SESSION_TOKEN' }
      }

      const client = this.getClient()
      const { data, error } = await client.functions.invoke('seat-device', {
        headers: {
          authorization: `Bearer ${token}`
        },
        body: {
          action: 'list'
        }
      })

      if (error) {
        const errPayload = await this.extractFunctionErrorPayload(error)
        logger.warn(
          LogCategory.SYSTEM,
          '[DeviceBindService] listSeatedDevices 失败:',
          errPayload || error
        )
        const friendlyMessage = this.resolveFriendlyErrorMessage(error, errPayload?.message)
        return {
          success: false,
          error:
            errPayload?.error || (this.isNetworkError(error) ? 'NETWORK_ERROR' : error.message),
          message: friendlyMessage
        }
      }

      if (!data?.success) {
        return { success: false, error: data?.error || 'LIST_DEVICES_FAILED' }
      }

      return {
        success: true,
        devices: data.devices || [],
        slot_limit: data.slot_limit,
        active_count: data.active_count,
        monthly_unbind_limit: data.monthly_unbind_limit,
        monthly_unbind_remaining: data.monthly_unbind_remaining
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] listSeatedDevices 异常:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  }

  /**
   * 发送邮箱验证码 (通过 Edge Function send-email-otp)
   */
  public async sendEmailOtp(email: string): Promise<SendEmailOtpResponse> {
    try {
      const bindSessionToken = this.getBindSessionToken()
      if (!bindSessionToken) {
        return { success: false, error: 'BIND_SESSION_EXPIRED' }
      }

      const client = this.getClient()
      const { data, error } = await client.functions.invoke('send-email-otp', {
        headers: {
          'bind-session-token': bindSessionToken
        },
        body: {
          email: email.trim().toLowerCase()
        }
      })

      if (error) {
        const errPayload = await this.extractFunctionErrorPayload(error)
        logger.warn(
          LogCategory.SYSTEM,
          '[DeviceBindService] send-email-otp 调用失败:',
          errPayload || error
        )
        const errCode = errPayload?.error
        if (
          errCode === 'SESSION_EXPIRED' ||
          errCode === 'UNAUTHORIZED' ||
          errCode === 'BIND_SESSION_EXPIRED'
        ) {
          await this.clearBindSessionToken()
        }
        return {
          success: false,
          error: errCode || (this.isNetworkError(error) ? 'NETWORK_ERROR' : error.message),
          message: errPayload?.message
        }
      }

      if (!data?.success) {
        if (
          data?.error === 'SESSION_EXPIRED' ||
          data?.error === 'UNAUTHORIZED' ||
          data?.error === 'BIND_SESSION_EXPIRED'
        ) {
          await this.clearBindSessionToken()
        }
        return {
          success: false,
          error: data?.error || 'SEND_OTP_FAILED',
          message: data?.message,
          cooldown_seconds: data?.cooldown_seconds
        }
      }

      return {
        success: true,
        cooldown_seconds: data.cooldown_seconds,
        expires_in_seconds: data.expires_in_seconds
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] sendEmailOtp 异常:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  }

  /**
   * 阶段二联系方式确认后的统一激活落盘与设备入席流程
   * 供「邮箱验证码」与「关注公众号口令」两条等价分支共享
   */
  private async finalizeStage2BindingRpc(
    rpcName: string,
    rpcArgs: Record<string, any>
  ): Promise<CompleteEmailBindingResponse> {
    try {
      const client = this.getClient()
      const schema = getSharedSchemaName()
      const { data, error } = await (client as any).schema(schema).rpc(rpcName, rpcArgs)

      if (error) {
        logger.warn(LogCategory.SYSTEM, `[DeviceBindService] ${rpcName} 失败:`, error)
        return {
          success: false,
          error: this.isNetworkError(error) ? 'NETWORK_ERROR' : error.message,
          message: this.resolveFriendlyErrorMessage(error)
        }
      }

      if (!data?.success) {
        if (data?.error === 'SESSION_EXPIRED' || data?.error === 'BIND_SESSION_EXPIRED') {
          await this.clearBindSessionToken()
        }
        return {
          success: false,
          error: data?.error || 'BINDING_FAILED',
          message: data?.message
        }
      }

      const sessionToken = data?.device_token || data?.session_token
      // 契约守卫：仅当 data?.status === 'active' && data?.device_token && (data?.seated === true || data?.need_evict === false) 时才写入 DEVICE_AUTH_TOKEN
      if (
        data?.status === 'active' &&
        sessionToken &&
        (data?.seated === true || data?.need_evict === false)
      ) {
        await this.setDeviceToken(sessionToken)
        await this.clearBindSessionToken()
      }

      const invitationResult =
        data?.invitation_result ??
        (data?.invitation_status && data.invitation_status !== 'none'
          ? {
              success: data.invitation_status === 'success',
              message: data.invitation_error || undefined
            }
          : undefined)

      if (data?.seated) {
        return {
          success: true,
          status: data.status || 'active',
          seated: true,
          contact_channel: data.contact_channel,
          device_token: sessionToken,
          user: data.user,
          invitation_result: invitationResult
        }
      }

      if (sessionToken) {
        const seatRes = await this.seatThisDevice(sessionToken, null)
        if (seatRes.success && seatRes.seated) {
          return {
            success: true,
            status: 'active',
            seated: true,
            contact_channel: data.contact_channel,
            device_token: sessionToken,
            user: data.user,
            invitation_result: invitationResult
          }
        }

        if (seatRes.need_evict) {
          return {
            success: true,
            status: 'need_evict',
            need_evict: true,
            seated: false,
            contact_channel: data.contact_channel,
            device_token: sessionToken,
            user: data.user,
            invitation_result: invitationResult
          }
        }

        return {
          success: false,
          status: 'error',
          seated: false,
          contact_channel: data.contact_channel,
          device_token: sessionToken,
          user: data.user,
          invitation_result: invitationResult,
          error: seatRes.error || 'SEAT_FAILED',
          message: seatRes.message || '当前电脑登录席位激活失败，请重试'
        }
      }

      return {
        success: false,
        error: 'MISSING_SESSION_TOKEN',
        message: '未获取到有效设备会话凭据，请重新扫码重试'
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, `[DeviceBindService] ${rpcName} 异常:`, err)
      return {
        success: false,
        error: this.isNetworkError(err) ? 'NETWORK_ERROR' : err?.message || 'unknown',
        message: this.resolveFriendlyErrorMessage(err)
      }
    }
  }

  /**
   * 完成邮箱验证与好友邀请兑换原子结算
   */
  public async completeEmailBinding(
    email: string,
    code: string,
    invitationCode?: string
  ): Promise<CompleteEmailBindingResponse> {
    const bindSessionToken = this.getBindSessionToken()
    if (!bindSessionToken) {
      return { success: false, error: 'BIND_SESSION_EXPIRED' }
    }

    return this.finalizeStage2BindingRpc('rpc_complete_email_binding_and_invitation', {
      p_bind_session_token: bindSessionToken,
      p_email: email.trim().toLowerCase(),
      p_code: code.trim(),
      p_invitation_code: invitationCode ? invitationCode.trim() : null
    })
  }

  /**
   * 完成关注公众号口令确认与好友邀请兑换原子结算（二选一轻量路径）
   */
  public async completeOaContactBinding(
    invitationCode?: string
  ): Promise<CompleteEmailBindingResponse> {
    const bindSessionToken = this.getBindSessionToken()
    if (!bindSessionToken) {
      return { success: false, error: 'BIND_SESSION_EXPIRED' }
    }

    return this.finalizeStage2BindingRpc('rpc_complete_oa_contact_binding', {
      p_bind_session_token: bindSessionToken,
      p_invitation_code: invitationCode ? invitationCode.trim() : null
    })
  }

  /**
   * 清理当前设备的持久化凭据 (供会话过期或退出登录时使用)
   */
  public async clearAllTokens(): Promise<void> {
    await Promise.all([this.clearDeviceToken(), this.clearBindSessionToken()])
  }

  /**
   * 主动解绑设备 (本机或指定设备)
   */
  public async unbindDevice(payload?: {
    deviceId?: string
    machineId?: string
  }): Promise<{ success: boolean; error?: string; message?: string }> {
    try {
      const token = this.getDeviceToken()
      if (!token) {
        return { success: false, error: 'NO_SESSION_TOKEN', message: '未获取到当前登录会话' }
      }

      const client = this.getClient()
      const { data, error } = await client.functions.invoke('seat-device', {
        headers: {
          authorization: `Bearer ${token}`
        },
        body: {
          action: 'unbind',
          deviceId: payload?.deviceId,
          machineId: payload?.machineId
        }
      })

      if (error) {
        const errPayload = await this.extractFunctionErrorPayload(error)
        logger.warn(
          LogCategory.SYSTEM,
          '[DeviceBindService] unbindDevice 失败:',
          errPayload || error
        )
        const friendlyMessage = this.resolveFriendlyErrorMessage(
          error,
          errPayload?.message,
          '解绑失败，请重试'
        )
        return {
          success: false,
          error:
            errPayload?.error || (this.isNetworkError(error) ? 'NETWORK_ERROR' : error.message),
          message: friendlyMessage
        }
      }

      if (!data?.success) {
        return {
          success: false,
          error: data?.error || 'UNBIND_FAILED',
          message: data?.message || '解绑失败'
        }
      }

      // 如果解绑的是本机（未传 deviceId/machineId 或 machineId 等于本机 machine_id）
      const currentMachineId = SystemIdentityService.getInstance().getMachineId()
      const isSelf =
        (!payload?.deviceId && !payload?.machineId) || payload?.machineId === currentMachineId

      if (isSelf) {
        await this.clearAllTokens()
        const mainWindow = getMainWindow()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('userTier/deviceUnbound')
        }
      }

      return {
        success: true,
        message: data?.message || '设备解绑成功'
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] unbindDevice 异常:', err)
      const friendlyMessage = this.resolveFriendlyErrorMessage(err, undefined, '解绑失败，请重试')
      return {
        success: false,
        error: this.isNetworkError(err) ? 'NETWORK_ERROR' : err?.message || 'unknown',
        message: friendlyMessage
      }
    }
  }
}
