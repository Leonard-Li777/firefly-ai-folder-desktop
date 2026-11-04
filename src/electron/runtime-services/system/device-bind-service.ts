import os from 'os'
import { WORKSPACE_CONSTANTS } from '@firefly/server'
import { logger, LogCategory, getSharedSchemaName } from '@firefly/shared'
import { SystemIdentityService } from './system-identity-service'
import { createSupabaseClient } from './supabase-client-factory'
import { SupabaseClient } from '@supabase/supabase-js'

export interface DeviceBindStatus {
  success: boolean
  bound: boolean
  slot_index?: number
  account_tier?: string
  device_tier?: string
  error?: string
}

export interface DeviceBindCodeResult {
  success: boolean
  code?: string
  imageDataUrl?: string
  expiresAt?: string
  deviceLabel?: string
  platform?: string
  machineIdTail?: string
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
        device_tier: data?.device_tier
      }
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 异常:', err)
      return { success: false, bound: false, error: err?.message || 'unknown' }
    }
  }

  /**
   * 生成设备绑定短码并拉取微信官方带参小程序码图片
   * 严格遵循设备绑定规范：
   * 1. 调用 rpc_create_device_bind_code 原子生成 8 位绑定短码 code（落库 device_bind_codes）；
   * 2. 调用 wxpay-qrcode (type: 'bind', code) 获取落地页为 pages/bind/index 的专用小程序码；
   * 杜绝将支付充值 token 误作为绑定二维码。
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
            p_device_label: deviceLabel
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

      // 2. 将设备绑定短码提交给 Edge Function wxpay-qrcode (type='bind')，获取微信官方真实小程序码 (落地 pages/bind/index)
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
}
