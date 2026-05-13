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
import { databaseService } from '../database/database-service'
import { LicenseService } from './license-service'

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
   * 检查是否为企业版授权（禁止同步）
   */
  private async isEnterpriseLicense(): Promise<boolean> {
    const license = await LicenseService.getInstance().checkLicenseStatus();
    return license.type === 'ENTERPRISE_OFFLINE';
  }

  /**
   * 执行配置同步
   * @param force 是否强制同步，忽略 isSynced 标记
   * @returns 返回更新过的配置键列表
   */
  async syncConfig(force = false): Promise<string[]> {
    // 企业版禁止远程配置同步
    if (await this.isEnterpriseLicense()) {
      logger.info(
        LogCategory.SUPABASE,
        'RemoteConfig: Detected enterprise license, skipping sync'
      )
      return []
    }

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

        // 标准查询：我们依赖 supabase-client-factory 中的 Cache-Control 头来穿透缓存
        const { data: freshData, error: fetchError } = await this.supabase
          .from(tableName)
          .select('key, value')
          .not('key', 'is', null);
          
        if (fetchError) throw fetchError;
        const dataToUse = freshData;

        const updatedKeys: string[] = []
        const localDb = databaseService.db

        if (dataToUse && dataToUse.length > 0) {
          const updates: any = {}

          dataToUse.forEach(row => {
            const key = row.key.toUpperCase()
            const currentValue = this.configOrchestrator.getValue(key as any)
            let finalValue = row.value

            // A. 同步到本地 SQLite (system_config 表) - 增加本地持久化能力
            if (localDb) {
              try {
                localDb.prepare(`
                  INSERT INTO system_config (key, value, updated_at)
                  VALUES (?, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = CURRENT_TIMESTAMP
                `).run(row.key, JSON.stringify(finalValue))
              } catch (dbError) {
                logger.error(LogCategory.DATABASE_SERVICE, `RemoteConfig: 持久化配置项 ${key} 到本地数据库失败:`, dbError)
              }
            }

            // B. 处理内存/配置文件同步
            // 特殊处理模型配置和云端服务商配置的合并逻辑，防止本地下载状态或API密钥丢失
            if (key === 'LOCAL_MODEL_CONFIGS' || key === 'LOCAL_MODEL_CONFIGS_OLLAMA') {
              finalValue = this.mergeModelConfigs(currentValue, row.value)
            } else if (key === 'CLOUD_MODEL_CONFIGS') {
              finalValue = this.mergeCloudConfigs(currentValue, row.value)
            }

            // 对比并准备更新
            if (key === 'LATEST_NEWS') {
              const currentStr = JSON.stringify(currentValue);
              const remoteStr = JSON.stringify(finalValue);
              logger.info(LogCategory.SUPABASE, `RemoteConfig: [DEBUG] Comparing LATEST_NEWS`, {
                currentLen: currentStr.length,
                remoteLen: remoteStr.length,
                isEqual: isEqual(currentValue, finalValue),
                currentPrefix: currentStr.substring(0, 50),
                remotePrefix: remoteStr.substring(0, 50)
              })
              if (currentStr !== remoteStr && isEqual(currentValue, finalValue)) {
                 logger.warn(LogCategory.SUPABASE, 'RemoteConfig: [CRITICAL] stringify different but isEqual same!');
              }
            }

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
   * 合并模型配置
   * 确保以 id 作为唯一值进行 merge，云端参数变化完全覆盖本地
   * 不再需要保护本地运行状态 (modelPath, downloadProgress 等)，因为现在由 ModelDownloadManager 动态计算
   */
  private mergeModelConfigs(local: any, remote: any): any {
    if (!remote || !remote.models || !Array.isArray(remote.models)) return local
    if (!local || !local.models || !Array.isArray(local.models)) return remote

    const localModels = local.models as any[]
    const remoteModels = remote.models as any[]

    const localMap = new Map<string, any>(localModels.map((m: any) => [m.id, m]))
    const finalModels: any[] = []

    // 1. 处理云端模型：云端元数据完全覆盖本地
    remoteModels.forEach((rm: any) => {
      const lm = localMap.get(rm.id)
      if (lm) {
        // 合并：云端属性完全覆盖本地
        finalModels.push({
          ...lm, // 保留本地可能有但云端缺失的补充属性
          ...rm  // 云端属性覆盖本地
        })
        localMap.delete(rm.id)
      } else {
        // 云端新增的模型
        finalModels.push(rm)
      }
    })

    // 2. 保留本地独有的模型（虽然通过 UI 无法添加，但防御性保留）
    localMap.forEach((lm: any) => finalModels.push(lm))

    return {
      ...remote,
      models: finalModels
    }
  }

  /**
   * 合并云端服务商配置
   * 确保以 id/provider 作为唯一值进行 merge
   * 云端的元数据（name, models等）覆盖本地，但保留本地的 API 密钥和自定义设置
   */
  private mergeCloudConfigs(local: any, remote: any): any {
    if (!remote || !Array.isArray(remote)) return local
    if (!local || !Array.isArray(local)) return remote

    const localConfigs = local as any[]
    const remoteConfigs = remote as any[]

    const localMap = new Map<string, any>(localConfigs.map((c: any) => [c.id || c.provider, c]))
    const finalConfigs: any[] = []

    // 1. 处理云端配置：云端元数据覆盖本地
    remoteConfigs.forEach((rc: any) => {
      const id = rc.id || rc.provider
      const lc = localMap.get(id)
      if (lc) {
        // 合并：云端元数据覆盖本地，但保留本地敏感信息和用户设置
        finalConfigs.push({
          ...lc, // 保留本地 apiKey, baseUrl 等
          ...rc  // 云端 name, models 等元数据覆盖
        })
        localMap.delete(id)
      } else {
        // 云端新增的服务商
        finalConfigs.push(rc)
      }
    })

    // 2. 保留本地独有的配置
    localMap.forEach((lc: any) => finalConfigs.push(lc))

    return finalConfigs
  }
}

export const remoteConfigService = RemoteConfigService.getInstance()