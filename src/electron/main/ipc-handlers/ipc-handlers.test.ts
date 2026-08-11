import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerConfigIPCHandlers } from './config'
import { registerFileIPCHandlers } from './file'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { databaseService } from '../../runtime-services/database/database-service'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([]),
    fromWebContents: vi.fn()
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn()
  },
  app: {
    isPackaged: false,
    getAppPath: vi.fn().mockReturnValue('/mock/app/path'),
    getPath: vi.fn().mockReturnValue('/mock/temp/path')
  },
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn()
  },
  powerMonitor: {
    on: vi.fn()
  }
}))

vi.mock('../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: vi.fn().mockReturnValue({
      getConfig: vi.fn().mockReturnValue({ theme: 'dark' }),
      updateConfig: vi.fn(),
      getValue: vi.fn(),
      updateValue: vi.fn()
    })
  }
}))

vi.mock('../../runtime-services/database/database-service', () => ({
  databaseService: {
    getAllFiles: vi.fn().mockResolvedValue([{ id: 1, name: 'test.txt' }]),
    addFile: vi.fn(),
    findRootWorkspaceDirectory: vi.fn(),
    getFilesByParentPath: vi.fn().mockResolvedValue([]),
    getWorkspaceDirectoryById: vi.fn(),
    getUnitsForFile: vi.fn(),
    getUnitsForPath: vi.fn(),
    getFileAnalysisResult: vi.fn(),
    getDirectoryAnalysisResult: vi.fn(),
    getCurrentWorkspaceDirectory: vi.fn(),
    getAllWorkspaceDirectories: vi.fn().mockResolvedValue([]),
    setCurrentWorkspaceDirectory: vi.fn()
  }
}))

vi.mock('../../runtime-services/llama/llama-engine-service', () => ({
  llamaEngineService: {
    isEngineReady: vi.fn().mockResolvedValue(true)
  }
}))

vi.mock('@firefly/shared', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn()
  },
  LogCategory: {
    MAIN: 'MAIN',
    IPC: 'IPC'
  },
  getMimeTypeByExtension: vi.fn().mockReturnValue('text/plain'),
  getExtensionsByCategory: vi.fn().mockReturnValue([]),
  getMimeTypesByCategory: vi.fn().mockReturnValue([]),
  FileCategory: {
    TEXT: 'text'
  },
  DEFAULT_TIER_CONSTANTS: {
    prices: {}
  },
  createSecretHmac: vi.fn()
}))

vi.mock('@app/languages', () => ({
  t: vi.fn(s => s)
}))

vi.mock('@firefly/core-engine', () => ({
  fileAnalysisService: {
    process: vi.fn(),
    removeFromQueue: vi.fn()
  },
  EmptyFolderScanner: vi.fn().mockImplementation(() => ({
    scanEmptyFolders: vi.fn(),
    deleteEmptyFolders: vi.fn()
  })),
  createCoreEngine: vi.fn().mockReturnValue({
    initialize: vi.fn(),
    on: vi.fn()
  })
}))

vi.mock('../../runtime-services/ipc', () => ({
  registerSettingsIPCHandlers: vi.fn(),
  registerCloudModelConfigIPCHandlers: vi.fn(),
  registerLocalModelConfigIPCHandlers: vi.fn(),
  registerFfmpegIpcHandlers: vi.fn(),
  ModelDownloadManagerIPCHandler: {
    getInstance: vi.fn()
  }
}))

vi.mock('../state', () => ({
  globalLlamaIndexService: null,
  analyzedDirectoryService: null,
  syncedDirectories: new Set(),
  reorganizePauseFlags: new Map(),
  reorganizeEndFlags: new Map(),
  coreEngine: null,
  fileCleanupService: null
}))

vi.mock('../../runtime-services/filesystem/file-watcher-service', () => ({
  fileWatcherService: {
    syncDirectory: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn()
  }
}))

vi.mock('../../runtime-services/system/system-health-service', () => ({
  systemHealthService: {
    registerServiceHealthCheck: vi.fn()
  }
}))

vi.mock('../../runtime-services/system/libreoffice-detector', () => ({
  libreOfficeDetector: {
    detectLibreOffice: vi.fn()
  }
}))

vi.mock('../../runtime-services/invitation/invitation-service', () => ({
  invitationService: {
    initialize: vi.fn()
  }
}))

vi.mock('../../runtime-services/llama/model-service', () => ({
  modelService: {
    listModels: vi.fn()
  }
}))

vi.mock('../../runtime-services/user-tier/user-tier-service', () => ({
  userTierService: {
    getProfile: vi.fn()
  }
}))

vi.mock('../../runtime-services/analysis-queue-service', () => ({
  analysisQueueService: {
    getSnapshot: vi.fn()
  }
}))

vi.mock('../../runtime-services/ai/adapters/ai-engine-factory', () => ({
  AIEngineFactory: {
    getAdapter: vi.fn().mockReturnValue({ engineName: 'llama.cpp' })
  }
}))

vi.mock('../../runtime-services/ai/cloud-sync-worker', () => ({
  cloudSyncWorker: {
    start: vi.fn(),
    trySync: vi.fn()
  }
}))

vi.mock('../../runtime-services/ai/ai-error-handler', () => ({
  aiErrorHandler: {
    createAIError: vi.fn(),
    handleError: vi.fn()
  }
}))

vi.mock('../../runtime-services/filesystem/directory-context-service', () => ({
  DirectoryContextService: vi.fn()
}))

vi.mock('../../adapters', () => ({
  createCoreEngineAdapters: vi.fn()
}))

vi.mock('../../runtime-services/analysis/analysis-ignore-service', () => ({
  loadIgnoreRules: vi.fn().mockReturnValue([]),
  shouldIgnoreFile: vi.fn().mockReturnValue(false)
}))

describe('IPC Handlers Refactor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should register config IPC handlers', () => {
    registerConfigIPCHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('get-config', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('update-config', expect.any(Function))
  })

  it('get-config should call ConfigOrchestrator', async () => {
    registerConfigIPCHandlers()
    const handler = (ipcMain.handle as any).mock.calls.find(call => call[0] === 'get-config')[1]
    const result = await handler()
    expect(result).toEqual({ theme: 'dark' })
    expect(ConfigOrchestrator.getInstance().getConfig).toHaveBeenCalled()
  })

  it('should register file IPC handlers', () => {
    registerFileIPCHandlers()
    expect(ipcMain.handle).toHaveBeenCalledWith('get-all-files', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('add-file', expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith('read-directory', expect.any(Function))
  })

  it('get-all-files should call databaseService', async () => {
    registerFileIPCHandlers()
    const handler = (ipcMain.handle as any).mock.calls.find(call => call[0] === 'get-all-files')[1]
    const result = await handler()
    expect(result).toEqual([{ id: 1, name: 'test.txt' }])
    expect(databaseService.getAllFiles).toHaveBeenCalled()
  })
})
