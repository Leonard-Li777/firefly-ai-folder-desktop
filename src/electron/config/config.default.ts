import path from 'node:path'
import { app } from 'electron'
import type { UnifiedAppConfig } from '@yonuc/types/config-types'

import { DEFAULT_UNIFIED_CONFIG } from '@yonuc/shared'
import { merge } from 'lodash-es'

function safeGetPath(name: Parameters<typeof app.getPath>[0], fallbackFolder: string): string {
  try {
    return app.getPath(name)
  } catch {
    return path.join(process.cwd(), fallbackFolder)
  }
}

const userDataPath = safeGetPath('userData', '.yonuc-user-data')
const tempPath = safeGetPath('temp', '.yonuc-temp')
const defaultModelDirectory = path.join(userDataPath, 'models')
const defaultLogDirectory = path.join(userDataPath, 'logs')
const defaultTempDirectory = path.join(tempPath, 'yonuc-temp')

export const defaultUnifiedConfig: UnifiedAppConfig = merge(DEFAULT_UNIFIED_CONFIG, {
  ui: {
    // MODEL_STORAGE_PATH removed from here, using paths.MODEL_STORAGE_PATH instead
  },
  paths: {
    MODEL_STORAGE_PATH: defaultModelDirectory, // 模型存储路径
    LOG_PATH: defaultLogDirectory, // 日志路径
    TEMP_PATH: defaultTempDirectory, // 临时文件路径
  },
})
