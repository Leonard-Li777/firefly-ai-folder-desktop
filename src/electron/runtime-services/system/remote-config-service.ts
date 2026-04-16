import { LogCategory, logger } from '@yonuc/shared'
import { SupabaseClient } from '@supabase/supabase-js'
import { isEqual } from 'lodash-es'
import fixPath from 'fix-path'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in RemoteConfigService:', e);
  }
}

import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { SystemIdentityService } from './system-identity-service'
import { createSupabaseClient } from './supabase-client-factory'

export class RemoteConfigService {
  private static instance: RemoteConfigService | null = null

  private supabase: SupabaseClient | null = null

  private configOrchestrator: ConfigOrchestrator

  private isSynced = false // 增加同步状态标记

  private constructor() {
    this.configOrchestrator = ConfigOrchestrator.getInstance()
    // Delayed initialization to ensure SystemIdentityService is ready
  }

  static getInstance(): RemoteConfigService {
    if (!RemoteConfigService.instance) {
      RemoteConfigService.instance = new RemoteConfigService()
    }

    return RemoteConfigService.instance
  }

  getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase) {
        this.initSupabase();
    }
    return this.supabase;
  }

  private initSupabase() {
    // 优先使用 process.env

    const url =
      process.env.VITE_SUPABASE_URL ||
      process.env.SUPABASE_URL

    const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

    // 强制使用 Anon Key 以符合 RLS 要求
    const key = anonKey

    if (url && key) {
      try {
        const identityService = SystemIdentityService.getInstance()
        const machineId = identityService.getMachineId()
        const signature = identityService.getSignature()

        this.supabase = createSupabaseClient(url, key, machineId, signature)

        logger.info(
          LogCategory.SUPABASE,
          `RemoteConfig: Supabase client initialized (Anon Key) with MachineID: ${machineId}`
        )
      } catch (e) {
        logger.error(LogCategory.SUPABASE, 'RemoteConfig: Failed to initialize Supabase client', e)
      }
    } else {
      logger.warn(
        LogCategory.SUPABASE,
        'RemoteConfig: Supabase credentials not found, remote config sync disabled',
        {
          hasUrl: !!url,
          hasKey: !!key
        }
      )
    }
  }

  /**
   * 执行配置同步
   * @param force 是否强制同步，忽略 isSynced 标记
   * @returns 返回更新过的配置键列表
   */
  async syncConfig(force = false): Promise<string[]> {
    if (!this.supabase) {
      this.initSupabase()
    }

    if (!this.supabase) {
      logger.warn(
        LogCategory.SUPABASE,
        'RemoteConfig: Sync skipped - Supabase client not initialized'
      )
      return []
    }

    if (this.isSynced && !force) {
      logger.debug(LogCategory.SUPABASE, 'RemoteConfig: Configuration already synced this session')
      return []
    }

    const maxRetries = 3
    let lastError: any = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const currentLang = this.configOrchestrator.getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
        const safeLang = currentLang.toLowerCase().replace('-', '_')
        const tableName = `${safeLang}_system_config`

        logger.info(LogCategory.SUPABASE, `RemoteConfig: Fetching configuration (Attempt ${attempt}/${maxRetries}) from ${tableName}...`)

        const { data, error } = await this.supabase
          .from(tableName)
          .select('key, value')

        if (error) throw error

        const updatedKeys: string[] = []
        if (data && data.length > 0) {
          const updates: any = {}

          data.forEach(row => {
            const key = row.key.toUpperCase()
            const currentValue = this.configOrchestrator.getValue(key as any)
            let finalValue = row.value

            // 特殊处理模型配置的合并逻辑，防止本地下载状态丢失
            if (key === 'LOCAL_MODEL_CONFIGS' || key === 'LOCAL_MODEL_CONFIGS_OLLAMA') {
              finalValue = this.mergeModelConfigs(currentValue, row.value)
            }

            // 对比并准备更新
            if (!isEqual(currentValue, finalValue)) {
              logger.info(LogCategory.SUPABASE, `RemoteConfig: Key ${key} has changed or requires merge, preparing update...`)
              updates[key] = finalValue
              updatedKeys.push(key)
            }
          })

          if (Object.keys(updates).length > 0) {
            this.configOrchestrator.updateValues(updates, { source: 'runtime' })
            logger.info(LogCategory.SUPABASE, `RemoteConfig: Applied updates for: ${updatedKeys.join(', ')}`)
          }

          this.isSynced = true
          return updatedKeys
        } else {
          logger.info(LogCategory.SUPABASE, `RemoteConfig: No data found in ${tableName}`)
          this.isSynced = true
          return []
        }
      } catch (error: any) {
        lastError = error
        logger.warn(LogCategory.SUPABASE, `RemoteConfig: Sync attempt ${attempt} failed: ${error.message}`)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
        }
      }
    }

    logger.error(LogCategory.SUPABASE, 'RemoteConfig: All sync attempts failed', lastError)
    return []
  }

  /**
   * 合并模型配置，保护本地运行状态 (路径、下载进度等)
   * 确保以 id 作为唯一值进行 merge，远程参数变化覆盖本地
   */
  private mergeModelConfigs(local: any, remote: any): any {
    if (!remote || !remote.models || !Array.isArray(remote.models)) return local
    if (!local || !local.models || !Array.isArray(local.models)) return remote

    const localModels = local.models as any[]
    const remoteModels = remote.models as any[]

    const localMap = new Map<string, any>(localModels.map((m: any) => [m.id, m]))
    const finalModels: any[] = []

    // 1. 处理远程模型：远程元数据覆盖本地，但保留本地运行状态
    remoteModels.forEach((rm: any) => {
      const lm = localMap.get(rm.id)
      if (lm) {
        // 合并：远程元数据 rm 覆盖本地 lm，但选择性保留本地特有的运行时状态
        finalModels.push({
          ...lm, // 首先保留本地所有属性
          ...rm, // 远程属性覆盖本地（包括参数、元数据变化）
          // 显式保留并优先使用本地运行状态（如果本地已有这些值）
          modelPath: (lm as any).modelPath || (rm as any).modelPath,
          mmprojPath: (lm as any).mmprojPath || (rm as any).mmprojPath,
          downloaded: (lm as any).downloaded || (rm as any).downloaded,
          downloadProgress: (lm as any).downloadProgress ?? (rm as any).downloadProgress,
          // 如果远程没有 size 而本地有，保留本地的
          size: (rm as any).size || (lm as any).size
        })
        localMap.delete(rm.id)
      } else {
        // 云端新增的模型
        finalModels.push(rm)
      }
    })

    // 2. 保留本地独有的模型（例如用户手动添加的模型）
    localMap.forEach((lm: any) => finalModels.push(lm))

    return {
      ...remote,
      models: finalModels
    }
  }
}

export const remoteConfigService = RemoteConfigService.getInstance()