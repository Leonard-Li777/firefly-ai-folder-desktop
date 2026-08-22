import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock electron
vi.mock('electron', async importOriginal => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    app: {
      ...actual.app,
      getPath: vi.fn().mockReturnValue('/tmp'),
      isPackaged: false,
      getAppPath: vi.fn().mockReturnValue('/tmp')
    },
    BrowserWindow: {
      ...actual.BrowserWindow,
      getAllWindows: vi.fn().mockReturnValue([])
    },
    ipcMain: {
      ...actual.ipcMain,
      handle: vi.fn(),
      on: vi.fn()
    },
    powerMonitor: {
      ...actual.powerMonitor,
      on: vi.fn()
    }
  }
})

import { initDatabaseAndDependentServices } from './initialization'
import { databaseService } from '../runtime-services/database/database-service'
import { ConfigDbManager } from '../runtime-services/config/config-db-manager'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { analysisQueueService } from '../runtime-services/analysis-queue-service'
import { ConfigOrchestrator as AIPackageConfigOrchestrator } from '@firefly/electron-llamaIndex-service'

// Mock 外部服务
vi.mock('../runtime-services/database/database-service', () => ({
  databaseService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    registerPostMigrationCallback: vi.fn(),
    clearPostMigrationCallbacks: vi.fn(),
    db: {} // 模拟 db 存在
  }
}))

vi.mock('../runtime-services/config/config-db-manager', () => {
  const mockConfigDbManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    loadFromJson: vi.fn(),
    syncFromCloud: vi.fn().mockResolvedValue(undefined)
  }
  return {
    ConfigDbManager: {
      getInstance: vi.fn().mockReturnValue(mockConfigDbManager)
    }
  }
})

vi.mock('../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    registerConfigDbManager: vi.fn(),
    getInstance: vi.fn().mockReturnValue({
      getValue: vi.fn(),
      onConfigChange: vi.fn()
    })
  }
}))

vi.mock('../runtime-services/analysis-queue-service', () => ({
  analysisQueueService: {
    reloadDatabase: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('../runtime-services/filesystem/directory-context-service', () => ({
  DirectoryContextService: vi.fn()
}))

vi.mock('./state', () => ({
  globalLlamaIndexService: null,
  setDirectoryContextService: vi.fn(),
  setOrganizeRealDirectoryService: vi.fn(),
  setFileCleanupService: vi.fn(),
  analyzedDirectoryService: { reset: vi.fn() },
  virtualDirectoryService: { reset: vi.fn() }
}))

vi.mock('@firefly/shared', async importOriginal => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn()
    },
    LogCategory: {
      ...actual.LogCategory,
      MAIN: 'MAIN',
      CONFIG: 'CONFIG'
    }
  }
})

describe('initDatabaseAndDependentServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 注入包内 ConfigOrchestrator（unified-model-manager 已迁移到 AI 包，通过该静态入口读取配置）
    AIPackageConfigOrchestrator.setInstance({
      getValue: vi.fn(),
      onConfigChange: vi.fn(),
      onValueChange: vi.fn(),
      getAIConfig: vi.fn(),
      updateValue: vi.fn(),
      updateValues: vi.fn()
    } as any)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('应该在 ConfigDbManager 初始化前将其实例注册到 ConfigOrchestrator 中', async () => {
    // 记录调用顺序
    const callOrder: string[] = []

    const mockRegister = vi
      .mocked(ConfigOrchestrator.registerConfigDbManager)
      .mockImplementation(() => {
        callOrder.push('registerConfigDbManager')
      })

    const mockInitialize = vi
      .mocked(ConfigDbManager.getInstance().initialize)
      .mockImplementation(async () => {
        callOrder.push('configDbManagerInitialize')
      })

    await initDatabaseAndDependentServices('zh-CN')

    // 验证确实调用了两个方法
    expect(mockRegister).toHaveBeenCalled()
    expect(mockInitialize).toHaveBeenCalled()

    // 验证调用顺序：registerConfigDbManager 必须在 configDbManagerInitialize 之前
    const registerIndex = callOrder.indexOf('registerConfigDbManager')
    const initializeIndex = callOrder.indexOf('configDbManagerInitialize')

    expect(registerIndex).toBeLessThan(initializeIndex)
    expect(registerIndex).toBe(0) // 由于它是这三个步骤的第一个
  })
})
