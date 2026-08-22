import { LogCategory, logger } from '@firefly/shared'
import { SupabaseClient } from '@supabase/supabase-js'
import fixPath from 'fix-path'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default
    if (typeof fixPathFunc === 'function') {
      fixPathFunc()
    }
  } catch (e) {
    console.error('Failed to fix PATH in RemoteConfigService:', e)
  }
}

import { SystemIdentityService } from './system-identity-service'
import { createSupabaseClient } from './supabase-client-factory'
import { WORKSPACE_CONSTANTS } from '@firefly/server'

export class RemoteConfigService {
  private static instance: RemoteConfigService | null = null

  private supabase: SupabaseClient | null = null

  private constructor() {
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
      this.initSupabase()
    }
    return this.supabase
  }

  private initSupabase() {
    // 优先使用 process.env

    const url =
      process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || WORKSPACE_CONSTANTS.SUPABASE_URL

    const anonKey =
      process.env.VITE_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      WORKSPACE_CONSTANTS.SUPABASE_ANON_KEY

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
}

export const remoteConfigService = RemoteConfigService.getInstance()
