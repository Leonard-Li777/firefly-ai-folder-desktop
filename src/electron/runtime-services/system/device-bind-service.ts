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
   * 生成设备绑定短码并拉取小程序码图片
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

      // 1. 调用云端 RPC 生成 8 位短码
      const schema = getSharedSchemaName()
      const { data, error } = await (client as any)
        .schema(schema)
        .rpc('rpc_create_device_bind_code', {
          p_machine_id: machineId,
          p_platform: platform,
          p_device_label: deviceLabel
        })

      if (error || !data?.success) {
        const errMsg = error?.message || data?.error || 'create_code_failed'
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 生成绑定短码失败:', errMsg)
        return { success: false, error: errMsg }
      }

      const code = data.code as string
      const expiresInSec = Number(data.expires_in_seconds) || 300
      const calculatedExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString()
      let imageDataUrl = ''

      // 2. 调用 Edge Function wxpay-qrcode 获取小程序码 (带优雅 fallback)
      try {
        const { data: qrData, error: qrErr } = await client.functions.invoke('wxpay-qrcode', {
          body: { type: 'bind', code }
        })
        if (!qrErr && qrData?.imageDataUrl) {
          imageDataUrl = qrData.imageDataUrl
        }
      } catch (qrEx) {
        logger.warn(LogCategory.SYSTEM, '[DeviceBindService] 拉取小程序码异常，降级显示短码:', qrEx)
      }

      // 3. 若未获取到小程序码，生成内嵌 SVG 保底 (严格对齐品牌命名规范)
      if (!imageDataUrl) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
          <rect width="100%" height="100%" fill="#f8fafc" rx="16"/>
          <rect x="15" y="15" width="270" height="270" fill="none" stroke="#e2e8f0" stroke-width="2" rx="12"/>
          <text x="150" y="110" font-family="sans-serif" font-size="16" font-weight="bold" fill="#0f172a" text-anchor="middle">微信扫码或输入绑定码</text>
          <text x="150" y="155" font-family="monospace" font-size="24" font-weight="bold" fill="#2563eb" text-anchor="middle">${code}</text>
          <text x="150" y="200" font-family="sans-serif" font-size="12" fill="#64748b" text-anchor="middle">在微信小程序「Firefly AI Folder」输入短码</text>
          <text x="150" y="225" font-family="sans-serif" font-size="12" fill="#94a3b8" text-anchor="middle">即可完成桌面设备授权绑定</text>
        </svg>`
        imageDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
      }

      return {
        success: true,
        code,
        imageDataUrl,
        expiresAt: data.expires_at || calculatedExpiresAt,
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
