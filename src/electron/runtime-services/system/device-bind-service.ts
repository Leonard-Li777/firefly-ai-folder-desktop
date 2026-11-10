import os from 'os'
import crypto from 'crypto'
import { WORKSPACE_CONSTANTS } from '@firefly/server'
import { logger, LogCategory, getSharedSchemaName } from '@firefly/shared'
import { SystemIdentityService } from './system-identity-service'
import { createSupabaseClient } from './supabase-client-factory'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { SupabaseClient } from '@supabase/supabase-js'

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
  status?: 'pending' | 'bound' | 'need_evict' | 'requires_email_binding' | 'expired'
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
}

export interface SeatedDeviceItem {
  id: string
  machine_id_tail: string
  slot_index: number
  device_label: string
  platform: string
  is_locked: boolean
  bound_at: string
  last_seen_at?: string
  is_current_machine: boolean
}

export interface SeatDeviceResponse {
  success: boolean
  seated?: boolean
  takeover?: boolean
  need_evict?: boolean
  slot_index?: number
  error?: string
  message?: string
}

export interface SendEmailOtpResponse {
  success: boolean
  cooldown_seconds?: number
  expires_in_seconds?: number
  error?: string
}

export interface CompleteEmailBindingResponse {
  success: boolean
  status?: string
  device_token?: string
  user?: {
    id: string
    ref_code?: string
    email_canonical?: string
  }
  invitation_result?: {
    success: boolean
    code?: string
    message?: string
  }
  error?: string
}

export class DeviceBindService {
  private static instance: DeviceBindService | null = null
  private supabaseClient: SupabaseClient | null = null

  private constructor() {}

  public static getInstance(): DeviceBindService {
    if (!DeviceBindService.instance) {
      DeviceBindService.instance = new DeviceBindService()
    }
    return DeviceBindService.instance
  }

  private getClient(): SupabaseClient {
    if (!this.supabaseClient) {
      const machineId = SystemIdentityService.getInstance().getMachineId()
      this.supabaseClient = createSupabaseClient(
        WORKSPACE_CONSTANTS.SUPABASE_URL,
        WORKSPACE_CONSTANTS.SUPABASE_ANON_KEY,
        machineId
      )
    }
    return this.supabaseClient
  }

  /**
   * 安全持久化设备凭据 (Windows 平台通过 safeStorage 自动加密，内存同步活跃标记)
   */
  public async setDeviceToken(token: string): Promise<void> {
    try {
      ;(globalThis as any)._firefly_active_device_token = token
      await (ConfigOrchestrator.getInstance() as any).updateValue?.('DEVICE_AUTH_TOKEN', token)
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] 持久化 DEVICE_AUTH_TOKEN 异常:', err)
    }
  }

  public getDeviceToken(): string | null {
    try {
      const token = (ConfigOrchestrator.getInstance() as any).getValue?.(
        'DEVICE_AUTH_TOKEN'
      ) as string
      return token || (globalThis as any)._firefly_active_device_token || null
    } catch {
      return (globalThis as any)._firefly_active_device_token || null
    }
  }

  /**
   * 安全持久化绑定会话凭据 (供阶段二邮箱绑定使用)
   */
  public async setBindSessionToken(token: string): Promise<void> {
    try {
      ;(globalThis as any)._firefly_active_bind_session_token = token
      await (ConfigOrchestrator.getInstance() as any).updateValue?.('BIND_SESSION_TOKEN', token)
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] 持久化 BIND_SESSION_TOKEN 异常:', err)
    }
  }

  public getBindSessionToken(): string | null {
    try {
      const token = (ConfigOrchestrator.getInstance() as any).getValue?.(
        'BIND_SESSION_TOKEN'
      ) as string
      return token || (globalThis as any)._firefly_active_bind_session_token || null
    } catch {
      return (globalThis as any)._firefly_active_bind_session_token || null
    }
  }

  /**
   * 清理绑定会话凭据
   */
  public async clearBindSessionToken(): Promise<void> {
    try {
      ;(globalThis as any)._firefly_active_bind_session_token = null
      await (ConfigOrchestrator.getInstance() as any).updateValue?.('BIND_SESSION_TOKEN', '')
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 清理 BIND_SESSION_TOKEN 异常:', err)
    }
  }

  /**
   * 检查本地是否存在有效且尚未消费的 BIND_SESSION_TOKEN
   */
  public hasActiveBindSession(): boolean {
    const token = this.getBindSessionToken()
    return !!token && token.trim().length > 0
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
  public async createDeviceBindCode(): Promise<DeviceBindCodeResult> {
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
            p_poll_secret_hash: pollSecretHash
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
      try {
        const { data: qrData, error: qrErr } = await client.functions.invoke('wxpay-qrcode', {
          body: { type: 'bind', code }
        })
        if (!qrErr && qrData?.imageDataUrl) {
          imageDataUrl = qrData.imageDataUrl
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            '[DeviceBindService] wxpay-qrcode bind 换码失败:',
            qrErr || qrData
          )
        }
      } catch (qrEx) {
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 调用 wxpay-qrcode bind 异常:', qrEx)
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

      if (!data?.success && data?.error) {
        return { success: false, error: data.error }
      }

      // 分支 A: pending 待手机扫码确认
      if (data?.status === 'pending') {
        return { success: true, status: 'pending' }
      }

      // 分支 B: claimed / consumed (手机端已确认)
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
        }

        return {
          success: true,
          status: 'bound',
          device_token: sessionToken,
          session_id: sessionId,
          seated: !!data.seated,
          user: data.user
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
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] seat-device 网关调用失败:', error)
        return { success: false, error: error.message }
      }

      if (!data?.success) {
        return {
          success: false,
          error: data?.error || 'SEAT_FAILED',
          need_evict: !!data?.need_evict,
          message: data?.message
        }
      }

      return {
        success: true,
        seated: !!data.seated,
        takeover: !!data.takeover,
        slot_index: data.slot_index,
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
  public async listSeatedDevices(
    sessionToken?: string
  ): Promise<{ success: boolean; devices?: SeatedDeviceItem[]; error?: string }> {
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
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] listSeatedDevices 失败:', error)
        return { success: false, error: error.message }
      }

      return {
        success: true,
        devices: data?.devices || []
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
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] send-email-otp 调用失败:', error)
        return { success: false, error: error.message }
      }

      if (!data?.success) {
        return {
          success: false,
          error: data?.error || 'SEND_OTP_FAILED',
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
   * 完成邮箱验证与好友邀请兑换原子结算
   */
  public async completeEmailBinding(
    email: string,
    code: string,
    invitationCode?: string
  ): Promise<CompleteEmailBindingResponse> {
    try {
      const bindSessionToken = this.getBindSessionToken()
      if (!bindSessionToken) {
        return { success: false, error: 'BIND_SESSION_EXPIRED' }
      }

      const client = this.getClient()
      const schema = getSharedSchemaName()
      const { data, error } = await (client as any)
        .schema(schema)
        .rpc('rpc_complete_email_binding_and_invitation', {
          p_bind_session_token: bindSessionToken,
          p_email: email.trim().toLowerCase(),
          p_code: code.trim(),
          p_invitation_code: invitationCode ? invitationCode.trim() : null
        })

      if (error) {
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] completeEmailBinding 失败:', error)
        return { success: false, error: error.message }
      }

      if (data?.status === 'active' && data?.device_token) {
        await this.setDeviceToken(data.device_token)
        await this.clearBindSessionToken()
      }

      return {
        success: true,
        status: data?.status,
        device_token: data?.device_token,
        user: data?.user,
        invitation_result: data?.invitation_result
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[DeviceBindService] completeEmailBinding 异常:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  }

  /**
   * 解绑或注销当前设备凭据
   */
  public async unbind(): Promise<void> {
    try {
      ;(globalThis as any)._firefly_active_device_token = null
      ;(globalThis as any)._firefly_active_bind_session_token = null
      await (ConfigOrchestrator.getInstance() as any).updateValue?.('DEVICE_AUTH_TOKEN', '')
      await (ConfigOrchestrator.getInstance() as any).updateValue?.('BIND_SESSION_TOKEN', '')
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[DeviceBindService] unbind 异常:', err)
    }
  }
}
