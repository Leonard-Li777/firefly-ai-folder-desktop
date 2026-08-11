import path from 'node:path'
import { app } from 'electron'
import type { UnifiedAppConfig } from '@firefly/types/config-types'

import { DEFAULT_UNIFIED_CONFIG } from '@firefly/shared'
import { merge } from 'lodash-es'

function safeGetPath(name: Parameters<typeof app.getPath>[0], fallbackFolder: string): string {
  try {
    return app.getPath(name)
  } catch {
    return path.join(process.cwd(), fallbackFolder)
  }
}

const userDataPath = safeGetPath('userData', '.firefly-user-data')
const tempPath = safeGetPath('temp', '.firefly-temp')
const defaultModelDirectory = path.join(userDataPath, 'models')
const defaultLogDirectory = path.join(userDataPath, 'logs')
const defaultTempDirectory = path.join(tempPath, 'firefly-temp')

export const defaultUnifiedConfig: UnifiedAppConfig = merge(DEFAULT_UNIFIED_CONFIG, {
  app: {
    DOWNLOAD_MIRROR: 'cn' // 默认为官方原版，后面会动态探测
  },
  ui: {
    // MODEL_STORAGE_PATH removed from here, using paths.MODEL_STORAGE_PATH instead
  },
  ai: {
    AI_ENGINE: __AI_ENGINE__
  },
  paths: {
    MODEL_STORAGE_PATH: defaultModelDirectory, // 模型存储路径
    LOG_PATH: defaultLogDirectory, // 日志路径
    TEMP_PATH: defaultTempDirectory // 临时文件路径
  }
})
