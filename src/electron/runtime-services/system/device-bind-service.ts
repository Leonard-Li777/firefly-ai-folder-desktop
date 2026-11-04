import os from 'os'
import { WORKSPACE_CONSTANTS } from '@firefly/server'
import { logger, LogCategory, getSharedSchemaName, encodeMachineIdToBase64 } from '@firefly/shared'
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
   * 生成设备绑定短码并拉取微信官方带参小程序码图片 (同源对齐 marketing-home)
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
      const identCode = encodeMachineIdToBase64(machineId)

      let token = ''
      let code = ''
      let expiresAt = ''
      let imageDataUrl = ''

      // 1. 同源对齐 marketing-home：调用 Edge Function wxpay-entry (action: 'mint') 获取短凭据 token 与 8 位短码
      try {
        const { data: mintData, error: mintErr } = await client.functions.invoke('wxpay-entry', {
          body: { action: 'mint', identCode }
        })

        if (!mintErr && mintData?.token) {
          token = mintData.token
          code = mintData.code || ''
          expiresAt = mintData.expiresAt || ''
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            '[DeviceBindService] wxpay-entry mint 失败:',
            mintErr || mintData
          )
        }
      } catch (mintEx) {
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 调用 wxpay-entry mint 异常:', mintEx)
      }

      // 2. 若获取到 token，调用 wxpay-qrcode 获取微信官方真实小程序码 (与官网价格页完全同源)
      if (token) {
        try {
          const { data: qrData, error: qrErr } = await client.functions.invoke('wxpay-qrcode', {
            body: { token }
          })
          if (!qrErr && qrData?.imageDataUrl) {
            imageDataUrl = qrData.imageDataUrl
          } else {
            logger.warn(
              LogCategory.SYSTEM,
              '[DeviceBindService] wxpay-qrcode 换码失败:',
              qrErr || qrData
            )
          }
        } catch (qrEx) {
          logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 调用 wxpay-qrcode 异常:', qrEx)
        }
      }

      // 3. 兜底方案：若 wxpay-entry 异常，尝试通过云端 RPC rpc_create_device_bind_code 作为备用生成口令
      if (!code) {
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
          }
        } catch (rpcEx) {
          logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 备用 RPC 生成短码失败:', rpcEx)
        }
      }

      if (!code) {
        return { success: false, error: '生成微信登录二维码失败，请检查网络连接' }
      }

      return {
        success: true,
        code,
        imageDataUrl,
        expiresAt: expiresAt || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
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
