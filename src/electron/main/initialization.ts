import { app, BrowserWindow } from 'electron'
import { logger, LogCategory, ErrorNormalizer, isTestEnvironment } from '@firefly/shared'
import { AIErrorType, AIServiceStatus, StartupPhase } from '@firefly/types'
import type { AICapabilities, LanguageCode } from '@firefly/types'
import { databaseService } from '../runtime-services/database/database-service'
import { cloudAnalysisService, WORKSPACE_CONSTANTS } from '@firefly/server'
import { createSupabaseClient } from '../runtime-services/system/supabase-client-factory'
import { analysisQueueService } from '../runtime-services/analysis-queue-service'
import { systemHealthService } from '../runtime-services/system/system-health-service'
import {
  llamaServerService,
  LlamaIndexAIService,
  binaryManager,
  ollamaService,
  multiModalModelService,
  ConfigOrchestrator as AIPackageConfigOrchestrator
} from '@firefly/electron-llamaIndex-service'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { fileDownloadService } from '../runtime-services/system/file-download-service'
import { DirectoryContextService } from '../runtime-services/filesystem/directory-context-service'
import { OrganizeRealDirectoryService } from '../runtime-services/filesystem/organize-real-directory-service/index'
import { FileCleanupService } from '../runtime-services/filesystem/file-cleanup-service'
import { fileWatcherService } from '../runtime-services/filesystem/file-watcher-service'
import { createCoreEngine } from '@firefly/core-engine'
import { createCoreEngineAdapters } from '../adapters'
import { ffmpegService } from '../runtime-services/system/ffmpeg-service'
import { SystemIdentityService } from '../runtime-services/system/system-identity-service'
import { unifiedModelManager } from '../runtime-services/llama/unified-model-manager'
import { hardwareDetectionService } from '../runtime-services/system/hardware-detection-service'
import { LicenseService, LicenseStatus } from '../runtime-services/system/license-service'
import { checkLicenseAndNotify } from './utils'
import { userTierService } from '../runtime-services/user-tier/user-tier-service'
import { networkInterceptorService } from '../services/network-interceptor-service'
import { invitationService } from '../runtime-services/invitation/invitation-service'
import { llamaEngineService } from '../runtime-services/llama/llama-engine-service'
import { gpuDriverComplianceService } from '../runtime-services/llama/gpu-driver-compliance-service'
import { modelMigrationService } from '../runtime-services/llama/model-migration-service'
import { deploymentIntegrityVerifier } from '../runtime-services/llama/deployment-integrity-verifier'
import { AIEngineFactory } from '../runtime-services/ai/adapters/ai-engine-factory'
import { aiErrorHandler } from '../runtime-services/ai/ai-error-handler'
import { cloudSyncWorker } from '../runtime-services/ai/cloud-sync-worker'
import { AISkillApiService } from '../runtime-services/ai-skill-api-service'
import { dataMigrationService } from '../runtime-services/system/data-migration-service'
import { ConfigDbManager } from '../runtime-services/config/config-db-manager'
import { markitdownServerManager } from '../runtime-services/system/markitdown-server-manager'
import { createModelCapabilityAdapter } from '../adapters/model-capability-adapter'
import * as path from 'path'
import {
  globalLlamaIndexService,
  setGlobalLlamaIndexService,
  coreEngine,
  setCoreEngine,
  setDirectoryContextService,
  setOrganizeRealDirectoryService,
  setFileCleanupService,
  initializationPhaseStarted,
  setInitializationPhaseStarted,
  analyzedDirectoryService,
  virtualDirectoryService
} from './state'
import { enrichAIStatus } from './utils'
import { t } from '@app/languages'

/**
 * 初始化硬件检测并更新统一配置
 */
export async function initializeHardwareDetection(wait = false): Promise<void> {
  try {
    logger.info(LogCategory.STARTUP, `正在${wait ? '同步' : '异步'}检测系统硬件资源...`)

    const config = ConfigOrchestrator.getInstance()
    const oldInfo = {
      cpu: config.getValue('HARDWARE_CPU_INFO'),
      memory: config.getValue('HARDWARE_MEMORY_INFO'),
      gpu: config.getValue('HARDWARE_GPU_INFO'),
      storage: config.getValue('HARDWARE_STORAGE_INFO')
    }

    const runDetection = async () => {
      const resources = await hardwareDetectionService.detectSystemResources(true)
      logger.info(LogCategory.STARTUP, '硬件资源检测完成，正在对比变更...', {
        cpu: resources.cpu.model,
        memory: resources.memory.total,
        gpus: resources.gpus.length
      })

      const newInfo = {
        cpu: resources.cpu,
        memory: resources.memory,
        gpu: resources.gpus,
        storage: resources.storage
      }

      const hasChanged = JSON.stringify(oldInfo) !== JSON.stringify(newInfo)

      if (hasChanged) {
        logger.info(LogCategory.STARTUP, '检测到硬件信息变更，更新本地配置并同步云端')

        config.updateValues(
          {
            HARDWARE_CPU_INFO: resources.cpu,
            HARDWARE_MEMORY_INFO: resources.memory,
            HARDWARE_GPU_INFO: resources.gpus,
            HARDWARE_STORAGE_INFO: resources.storage
          },
          { source: 'runtime' }
        )
      }

      if (hasChanged || wait) {
        try {
          await cloudAnalysisService.syncFeatures()
          if (cloudAnalysisService.isDeviceRegistered()) {
            LicenseService.getInstance().setOnlineAuthorized(true)
          }
        } catch (syncError) {
          logger.warn(LogCategory.STARTUP, '同步硬件特征到云端失败:', syncError)
        }
      }
    }

    if (wait) {
      await runDetection()
    } else {
      runDetection().catch(err => {
        logger.error(LogCategory.STARTUP, '硬件资源检测异步执行失败:', err)
      })
    }
  } catch (error) {
    logger.error(LogCategory.STARTUP, '发起硬件检测失败:', error)
  }
}

/**
 * 初始化 llama-server 服务
 */
export async function initializeLlamaServer(): Promise<void> {
  try {
    logger.log(LogCategory.STARTUP, '正在初始化 llama-server 服务...')

    const health = await llamaServerService.checkHealth()
    logger.log(LogCategory.STARTUP, '健康检查结果:', health)

    if (health.healthy) {
      logger.log(LogCategory.STARTUP, '✅ llama-server 服务已就绪')
    } else {
      logger.log(LogCategory.STARTUP, '⚠️ llama-server 服务未启动，将在需要时启动')
    }
  } catch (error) {
    logger.error(LogCategory.STARTUP, 'llama-server 初始化失败:', error)
  }
}

/**
 * 确保 llama.cpp 引擎已部署
 */
export async function ensureLlamaEngineDeployed(options?: {
  forceDeploy?: boolean
  onProgress?: (msg: string) => void
}): Promise<void> {
  try {
    logger.info(LogCategory.MAIN, '正在确保 Llama 引擎已就绪 (含 llama.cpp 和 llamafile)...')
    const binaryPath = await llamaEngineService.ensureEngineDeployed(!!options?.forceDeploy)

    // 执行显卡驱动合规性检测 (仅针对 llama.cpp 引擎)
    // try {
    //   const config = ConfigOrchestrator.getInstance();
    //   const aiEngine = config.getValue<string>('AI_ENGINE');

    //   if (aiEngine === 'llama.cpp') {
    //     const compliance = await gpuDriverComplianceService.checkCompliance();

    //     if (!compliance.compliant) {
    //       logger.warn(LogCategory.AI_SERVICE, `显卡驱动合规性检测未通过: ${compliance.gpuName || 'NVIDIA|AMD GPU'}`);

    //       const aiError = aiErrorHandler.createAIError(
    //         AIErrorType.GPU_DRIVER_OUTDATED,
    //         t('检测到您的 {gpuName} 显卡驱动版本过低或不兼容，已为你降级AI引擎速度，建立升级驱动体验满血AI性能。', { gpuName: compliance.gpuName || 'NVIDIA|AMD' }),
    //         'GpuDriverComplianceService',
    //         { gpuName: compliance.gpuName }
    //       );
    //       aiErrorHandler.handleError(aiError).catch(err => {
    //         logger.error(LogCategory.AI_SERVICE, '处理驱动合规性错误失败:', err);
    //       });
    //     }
    //   }
    // } catch (complianceError) {
    //   logger.error(LogCategory.AI_SERVICE, '显卡驱动合规性检测过程异常:', complianceError);
    // }

    if (binaryManager) {
      binaryManager.setCustomBinaryPath(binaryPath)
      logger.info(LogCategory.MAIN, `Llama 引擎路径已成功注入: ${binaryPath}`)

      if (globalLlamaIndexService) {
        logger.info(LogCategory.MAIN, 'Llama 引擎部署完成，自动初始化拉起 AI 服务...')
        globalLlamaIndexService.initialize().catch(err => {
          logger.warn(LogCategory.MAIN, '自动拉起 AI 服务失败:', err.message)
        })
      }
    } else {
      logger.error(LogCategory.MAIN, '无法获取 binaryManager 实例')
      throw new Error('无法获取 binaryManager 实例')
    }
  } catch (error) {
    logger.error(LogCategory.MAIN, '确保 Llama 引擎部署失败:', error)
  }
}

/**
 * 初始化数据库及依赖于数据库的服务
 */
export async function initDatabaseAndDependentServices(
  language: LanguageCode,
  force = false
): Promise<void> {
  try {
    logger.info(
      LogCategory.MAIN,
      `正在初始化数据库服务 (语言: ${language}${force ? ', 强制重新初始化' : ''})...`
    )

    if (force && databaseService.db) {
      logger.info(LogCategory.MAIN, '强制重新初始化：关闭旧数据库连接...')
      databaseService.close()
      analyzedDirectoryService.reset()
      virtualDirectoryService.reset()
      // 清理旧的回调，避免重复注册
      databaseService.clearPostMigrationCallbacks()
    }

    // 注册迁移后回调：在数据库迁移完成后自动从本地 JSON 加载初始配置
    // 这确保了配置数据在 databaseService.initialize() 返回时已就绪
    databaseService.registerPostMigrationCallback(db => {
      ConfigDbManager.getInstance().loadFromJson(db, language)
    })

    // 重要：必须在 databaseService.initialize 和 ConfigDbManager.initialize 之前注册
    // 否则当 ConfigDbManager 初始化后向渲染进程广播配置时，ConfigOrchestrator 无法获取 DB_MANAGED_KEYS，
    // 会导致 TIER_CONSTANTS 等关键配置为 undefined，进而在渲染进程引发空指针异常
    ConfigOrchestrator.registerConfigDbManager(ConfigDbManager.getInstance())

    await databaseService.initialize(language)
    // loadFromJson 已在迁移后回调中执行，此处只需确保内存数据同步
    await ConfigDbManager.getInstance().initialize(language, force)
    unifiedModelManager.ensureLoaded(true)

    // 数据库就绪后，为新用户一次性插入 welcome_grant（幂等：确定性 txId + INSERT OR IGNORE）
    if (databaseService.db) {
      try {
        const { SystemIdentityService } =
          await import('../runtime-services/system/system-identity-service')
        const { UserTierDataManager } = await import('@firefly/core-engine')
        const { userTierService } = await import('../runtime-services/user-tier/user-tier-service')
        const machineId = await SystemIdentityService.getInstance().getMachineId()
        const tc = ConfigOrchestrator.getInstance().getTierConstants()
        UserTierDataManager.insertWelcomeGrant(databaseService.db, machineId, tc)

        // 插入 welcome_grant 后立即初始化并同步刷新缓存，确保 UI 菜单即刻感知并更新萤火数
        await userTierService.initialize()
        userTierService.syncToCache(machineId).catch(err => {
          logger.error(LogCategory.MAIN, '[Initialization] welcome_grant 同步失败:', err)
        })
      } catch (e) {
        logger.error(LogCategory.MAIN, '[Initialization] welcome_grant 插入失败:', e)
      }
    }

    if (databaseService.db) {
      if (globalLlamaIndexService) {
        setDirectoryContextService(new DirectoryContextService(globalLlamaIndexService))
      }

      setOrganizeRealDirectoryService(new OrganizeRealDirectoryService(databaseService.db as any))
      setFileCleanupService(new FileCleanupService(databaseService.db))

      await analysisQueueService.reloadDatabase()
      await fileWatcherService.startAllAutoWatchers().catch(err => {
        logger.error(LogCategory.MAIN, '启动文件监听失败:', err)
      })

      ConfigDbManager.getInstance()
        .syncFromCloud()
        .catch(err => {
          logger.error(LogCategory.CONFIG, '数据库初始化后同步云端配置失败:', err)
        })

      logger.info(LogCategory.MAIN, '依赖数据库的业务服务初始化完成')
    } else {
      logger.error(LogCategory.MAIN, '数据库初始化失败，未获得有效的数据库实例')
    }
  } catch (error) {
    logger.error(LogCategory.MAIN, '初始化数据库及其依赖服务失败:', error)
    throw error
  }
}

/**
 * 注册服务健康检查
 */
export function registerServiceHealthChecks(): void {
  systemHealthService.registerServiceHealthCheck('database', async () => {
    try {
      const isConnected = await databaseService.isConnected()
      return {
        name: 'database',
        status: isConnected ? 'healthy' : 'critical',
        responseTime: 10,
        lastCheck: new Date(),
        details: { connected: isConnected }
      }
    } catch (error) {
      return {
        name: 'database',
        status: 'critical',
        responseTime: 0,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  systemHealthService.registerServiceHealthCheck('ai', async () => {
    try {
      if (!globalLlamaIndexService) {
        return {
          name: 'ai',
          status: 'warning',
          responseTime: 0,
          lastCheck: new Date(),
          details: { initialized: false, message: 'AI服务未创建' }
        }
      }

      const isInitialized = globalLlamaIndexService.isInitialized()
      return {
        name: 'ai',
        status: isInitialized ? 'healthy' : 'warning',
        responseTime: 5,
        lastCheck: new Date(),
        details: { initialized: isInitialized }
      }
    } catch (error) {
      return {
        name: 'ai',
        status: 'critical',
        responseTime: 0,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  systemHealthService.registerServiceHealthCheck('config', async () => {
    try {
      const config = ConfigOrchestrator.getInstance().getConfig()
      return {
        name: 'config',
        status: 'healthy',
        responseTime: 1,
        lastCheck: new Date(),
        details: { configLoaded: true }
      }
    } catch (error) {
      return {
        name: 'config',
        status: 'critical',
        responseTime: 0,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  systemHealthService.registerServiceHealthCheck('core-engine', async () => {
    try {
      if (!coreEngine) {
        return {
          name: 'core-engine',
          status: 'warning',
          responseTime: 0,
          lastCheck: new Date(),
          details: { initialized: false, message: '引擎未初始化' }
        }
      }

      const isInitialized = coreEngine.isInitialized()
      const snapshot = coreEngine.getQueueSnapshot()

      return {
        name: 'core-engine',
        status: isInitialized ? 'healthy' : 'warning',
        responseTime: 2,
        lastCheck: new Date(),
        details: {
          initialized: isInitialized,
          queueStatus: snapshot
        }
      }
    } catch (error) {
      return {
        name: 'core-engine',
        status: 'critical',
        responseTime: 0,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  logger.info(LogCategory.MAIN, '服务健康检查注册完成')
}

/**
 * 初始化配置阶段所需的最小服务集合
 */
export async function initializeMinimalServices(options?: {
  onProgress?: (msg: string) => void
}): Promise<void> {
  try {
    // 关键：将桌面侧 ConfigOrchestrator 注入 AI 包（包内服务如 unifiedModelManager 通过该静态入口读取配置）
    AIPackageConfigOrchestrator.setInstance(ConfigOrchestrator.getInstance())
    AIEngineFactory.setBuildTimeEngine(__AI_ENGINE__)
    logger.info(LogCategory.MAIN, '正在初始化配置阶段所需的最小服务...')
    logger.info(LogCategory.MAIN, '日志服务初始化成功')
    logger.info(LogCategory.MAIN, '错误处理服务初始化成功')
    logger.info(LogCategory.MAIN, '自动恢复服务初始化成功')
    logger.info(LogCategory.MAIN, '正在初始化系统健康检查服务...')
    logger.info(LogCategory.MAIN, '系统健康检查服务初始化成功')
    invitationService.initialize()

    // 注入硬件探测服务的依赖 (ConfigOrchestrator, deploymentIntegrityVerifier)
    hardwareDetectionService.setConfigOrchestrator(ConfigOrchestrator.getInstance())
    hardwareDetectionService.setDeploymentIntegrityVerifier(deploymentIntegrityVerifier)

    // 1. 在本地引擎部署和身份注册前，同步执行硬件资源探测，以确保能够获取硬件特征 (CPU/GPU/内存/存储)
    await initializeHardwareDetection(true)

    // 2. 及时在 Supabase 中同步注册机器记录 (含硬件特征)，确保后续交易和日志外键依赖在 DB 中存在
    const machineId = SystemIdentityService.getInstance().getMachineId()
    const supabaseClient = createSupabaseClient(
      WORKSPACE_CONSTANTS.SUPABASE_URL,
      WORKSPACE_CONSTANTS.SUPABASE_ANON_KEY,
      machineId
    )
    cloudAnalysisService.setSupabaseClient(supabaseClient)
    cloudAnalysisService.setIdentityProvider(SystemIdentityService.getInstance())
    logger.info(LogCategory.MAIN, '系统身份服务初始化成功')

    try {
      await cloudAnalysisService.initialize()
      logger.info(LogCategory.MAIN, '系统身份 Supabase 注册完成')
    } catch (err) {
      logger.warn(LogCategory.MAIN, '系统身份 Supabase 注册未完成 (可能离线):', err)
    }

    // 3. 仅在非云端模式下执行本地 AI 引擎部署（不依赖云端/数据库）
    const initMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
    if (initMode !== 'cloud') {
      logger.info(LogCategory.MAIN, '正在执行本地 Llama 引擎部署...')
      await ensureLlamaEngineDeployed(options)
    } else {
      logger.info(LogCategory.MAIN, '当前为云端模式，跳过本地 AI 引擎部署')
    }

    // await ffmpegService.initialize()
    // logger.info(LogCategory.MAIN, 'FFmpeg 服务初始化成功')

    const isLanguageConfirmed =
      ConfigOrchestrator.getInstance().getValue<boolean>('LANGUAGE_CONFIRMED')
    if (isLanguageConfirmed) {
      const language = ConfigOrchestrator.getInstance().getValue<string>(
        'DEFAULT_LANGUAGE'
      ) as LanguageCode
      await initDatabaseAndDependentServices(language)

      // 执行数据迁移
      await dataMigrationService.migrate()
      logger.info(LogCategory.MAIN, '数据库服务初始化成功')
    } else {
      logger.info(
        LogCategory.MAIN,
        '[Initialization] 语言尚未确认 (LANGUAGE_CONFIRMED = false)，延迟初始化数据库，等待用户选择语言...'
      )
    }

    try {
      unifiedModelManager.ensureLoaded()
      logger.info(LogCategory.MAIN, '统一模型配置初始化成功 (含云端服务商)')
    } catch (error) {
      logger.error(LogCategory.MAIN, '统一模型配置初始化失败:', error)
    }

    logger.info(LogCategory.MAIN, '正在初始化配置服务...')
    // 异步同步云端配置 (非阻塞，仅启动时同步一次)
    ConfigDbManager.getInstance()
      .syncFromCloud()
      .catch(err => {
        logger.error(LogCategory.CONFIG, 'ConfigDbManager syncFromCloud failed:', err)
      })
    logger.info(LogCategory.MAIN, '配置服务初始化成功')

    LicenseService.getInstance().initializeGraceTimestamps()
    LicenseService.getInstance().startTimeMonitor()
    userTierService.initialize().catch(err => {
      logger.error(LogCategory.SYSTEM, 'UserTier 服务初始化失败:', err)
    })

    // 在数据库初始化完成后注册邀请服务 IPC（依赖 TIER_CONSTANTS 配置）
    invitationService.initialize()

    // 启动时检查离线授权码是否包含内嵌 userTierData，并写入缓存（离线恢复企业版权益）
    LicenseService.getInstance()
      .restoreFromOfflineLicenseIfNeeded()
      .catch(err => {
        logger.error(LogCategory.SYSTEM, '[License] 从离线授权恢复 userTierData 失败:', err)
      })

    networkInterceptorService.initialize().catch(err => {
      logger.error(LogCategory.SYSTEM, '网络拦截服务初始化失败:', err)
    })

    logger.info(LogCategory.MAIN, '配置阶段最小服务初始化完成')
  } catch (error) {
    logger.error(LogCategory.MAIN, '最小服务初始化失败:', error)
    try {
      require('fs').writeSync(
        2,
        '[CRASH] ' + ((error as Error)?.message || (error as Error)?.stack || String(error)) + '\n'
      )
    } catch {}
    throw error
  }
}

/**
 * 初始化服务（应在用户完成配置阶段后调用）
 */
export async function initializeFullServices(): Promise<void> {
  if (initializationPhaseStarted) {
    logger.warn(LogCategory.MAIN, '完整初始化已启动，忽略重复调用')
    return
  }
  setInitializationPhaseStarted(true)

  try {
    logger.info(LogCategory.MAIN, '进入初始化阶段，开始完整服务初始化...')
    logger.info(LogCategory.MAIN, '正在初始化统一AI服务...')

    const fullInitMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')

    if (fullInitMode === 'cloud') {
      logger.info(LogCategory.MAIN, '当前为云端模式，跳过本地 AI 引擎部署和初始化')
    } else {
      ensureLlamaEngineDeployed().catch(err => {
        logger.error(LogCategory.MAIN, 'Llama 引擎后台初始化启动失败:', err)
      })
    }

    const modelStoragePath = ConfigOrchestrator.getInstance().getValue<string>('MODEL_STORAGE_PATH')
    try {
      await modelMigrationService.migrateModels(modelStoragePath, true)
    } catch (err) {
      logger.error(LogCategory.MAIN, '内置模型后台静默迁移失败:', err)
    }

    cloudAnalysisService
      .initialize()
      .then(async () => {
        try {
          const language =
            ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
          logger.info(LogCategory.MAIN, `正在从云端拉取维度定义 (语言: ${language})...`)
          const cloudDims = await cloudAnalysisService.fetchDimensions(language)

          if (cloudDims && cloudDims.length > 0 && databaseService.db) {
            const db = databaseService.db
            db.transaction(() => {
              // 先清空表
              db.prepare('DELETE FROM file_dimensions').run()

              for (const dim of cloudDims) {
                const tags =
                  typeof dim.tags === 'string' ? dim.tags : JSON.stringify(dim.tags || [])
                const trigger_conditions =
                  typeof dim.trigger_conditions === 'string'
                    ? dim.trigger_conditions
                    : dim.trigger_conditions
                      ? JSON.stringify(dim.trigger_conditions)
                      : null
                const applicable_file_types =
                  typeof dim.applicable_file_types === 'string'
                    ? dim.applicable_file_types
                    : dim.applicable_file_types
                      ? JSON.stringify(dim.applicable_file_types)
                      : null
                const context_hints =
                  typeof dim.context_hints === 'string'
                    ? dim.context_hints
                    : dim.context_hints
                      ? JSON.stringify(dim.context_hints)
                      : null

                db.prepare(
                  `
                INSERT INTO file_dimensions (
                  id, name, level, tags, trigger_conditions, is_ai_generated, description,
                  applicable_file_types, context_hints, sync_status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)
              `
                ).run(
                  dim.id,
                  dim.name,
                  dim.level,
                  tags,
                  trigger_conditions,
                  dim.is_ai_generated ? 1 : 0,
                  dim.description,
                  applicable_file_types,
                  context_hints,
                  dim.created_at || new Date().toISOString()
                )
              }
            })()
            logger.info(LogCategory.MAIN, `已同步 ${cloudDims.length} 个云端维度(含ID)到本地`)
          }
        } catch (err) {
          logger.warn(LogCategory.MAIN, '从云端拉取维度失败，使用本地缓存:', err)
        }
      })
      .catch(err => {
        logger.error(LogCategory.MAIN, '云端分析服务初始化失败:', err)
      })

    // 确保适配器在每次 Phase2 执行时都被设置到 llamaServerService。
    // 必须在 if (!globalLlamaIndexService) 之外，否则当 gpu-driver-compliance-service
    // 在 Phase2 完成前触发 reloadConfig() 时，llamaServerService.adapter 仍为 null，
    // 导致"服务切换失败: 未设置 AI 引擎适配器"错误。setAdapter 是幂等操作，重复调用安全。
    const engineAdapter = AIEngineFactory.getAdapter()
    llamaServerService.setAdapter(engineAdapter)

    // Inject ModelManager into multiModalModelService
    multiModalModelService.setModelManager(unifiedModelManager)

    if (!globalLlamaIndexService) {
      // 注入依赖到 ollamaService
      ollamaService.setConfigOrchestrator(ConfigOrchestrator.getInstance())
      ollamaService.setModelManager(unifiedModelManager as any)
      ollamaService.setFileDownloadService(fileDownloadService)

      const service = LlamaIndexAIService.getInstance(
        ConfigOrchestrator.getInstance(),
        llamaServerService,
        ConfigOrchestrator.getInstance()
      )

      if (!service) {
        logger.error(LogCategory.MAIN, '无法获取 LlamaIndexAIService 实例')
        throw new Error('无法获取 LlamaIndexAIService 实例')
      }

      service.on('memory-cache-save', (data: any) => {
        try {
          if (!databaseService.db) return

          // training_data_collection 门控：企业版禁用训练数据收集
          try {
            const tierData = userTierService.getCachedData()
            if (tierData?.computed_limits?.training_data_collection === false) {
              return
            }
          } catch {
            // 未就绪时默认允许写入
          }

          // 排除 ollama 服务商，不需要缓存
          if (data.provider === 'ollama') {
            return
          }

          // 如果指纹为全零 0000...（文件操作但获取指纹失败），不保存
          // 空字符串表示非文件操作，允许通过
          if (data.fileFingerprint && data.fileFingerprint.startsWith('0000')) {
            return
          }

          const id = require('crypto').randomUUID()
          databaseService.db
            .prepare(
              `
            INSERT INTO memory_cache (
              id, request_data, response_data, model, provider, latency_ms, 
              file_fingerprint, sync_status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
          `
            )
            .run(
              id,
              data.requestData,
              data.responseData,
              data.model,
              data.provider || 'unknown',
              data.latencyMs,
              data.fileFingerprint,
              new Date().toISOString()
            )
          logger.debug(
            LogCategory.AI_SERVICE,
            `[initialization] 微调数据已存入 memory_cache: ${id}`
          )
        } catch (err) {
          logger.error(LogCategory.AI_SERVICE, `[initialization] 存入 memory_cache 失败: ${err}`)
        }
      })

      if (service.listenerCount('error') <= 1) {
        logger.info(
          LogCategory.MAIN,
          `正在注册 AI 服务全局错误监听器 (当前监听器数: ${service.listenerCount('error')})`
        )
        service.on('error', (error: any) => {
          const normalized = ErrorNormalizer.normalize(error, error?.code || error?.aiErrorType)
          logger.warn(
            LogCategory.AI_SERVICE,
            `[initialization] 捕获到 AI 服务错误: ${normalized.message}, 代码: ${normalized.code || '未知'}`
          )
          const code = (normalized.code as AIErrorType) || AIErrorType.UNKNOWN_ERROR
          const aiError = aiErrorHandler.createAIError(
            code,
            normalized.message,
            'LlamaIndexAIService',
            normalized.details,
            error instanceof Error ? error : undefined
          )
          aiErrorHandler.handleError(aiError).catch(err => {
            logger.error(LogCategory.AI_SERVICE, '[initialization] AI 错误处理器处理失败:', err)
          })
        })
      }

      setGlobalLlamaIndexService(service)

      // 缓存上次的模型身份和能力信息，避免未切换模型时重复检测
      let lastModelIdentity: string | null = null
      let lastCapabilities: AICapabilities | null = null

      service.onStatusChange(async info => {
        // 构建当前模型身份标识（仅基于模型相关的字段，排除状态）
        const currentModelIdentity = JSON.stringify({
          modelName: info.modelName,
          modelMode: info.modelMode,
          provider: info.provider
        })

        // 仅当模型身份发生变化时才重新检测能力
        if (currentModelIdentity !== lastModelIdentity) {
          try {
            const adapter = createModelCapabilityAdapter()
            const caps = await adapter.getCapabilities()
            lastCapabilities = caps
            info.capabilities = caps
            info.modelName = caps.modelName || null
            info.provider = caps.provider || null
          } catch (err) {
            logger.error(LogCategory.MAIN, '[StatusChange] Failed to fetch capabilities:', err)
          }
          lastModelIdentity = currentModelIdentity
        } else if (lastCapabilities) {
          // 模型未切换，复用缓存的能力信息（同时覆盖 modelName/provider，避免 switchInfo 中的原始路径/llama.cpp 值）
          info.capabilities = lastCapabilities
          info.modelName = lastCapabilities.modelName || info.modelName
          info.provider = lastCapabilities.provider || info.provider
        }

        const enrichedInfo = await enrichAIStatus(info)
        logger.debug(LogCategory.MAIN, 'AI服务状态变更，广播给渲染进程:', enrichedInfo)
        BrowserWindow.getAllWindows().forEach(win => {
          win.webContents.send('ai-model-status-changed', enrichedInfo)
        })
      })

      service.onModelNotDownloaded(modelId => {
        logger.info(LogCategory.MAIN, '检测到模型未下载，通知前端跳转到模型选择页面', { modelId })
        const windows = BrowserWindow.getAllWindows()
        windows.forEach(win => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('model-not-downloaded', { modelId })
          }
        })
      })
    }

    if (globalLlamaIndexService) {
      try {
        if (!globalLlamaIndexService.isInitialized()) {
          // 测试环境下跳过 AI 服务初始化（使用 mock 数据，不需要真实 AI 服务）
          if (isTestEnvironment()) {
            logger.info(LogCategory.MAIN, '[Test] 测试环境跳过 AI 服务初始化')
          } else {
            await globalLlamaIndexService.initialize()
          }
        }
        logger.info(LogCategory.MAIN, '统一AI服务初始化成功')

        if (databaseService.db) {
          setDirectoryContextService(new DirectoryContextService(globalLlamaIndexService))
          logger.info(LogCategory.MAIN, '目录上下文服务已初始化 (AI 已就绪)')
        }
      } catch (error) {
        logger.error(LogCategory.MAIN, '统一AI服务初始化失败，等待用户手动重试:', error)
        try {
          const service = LlamaIndexAIService.getInstance() as any
          let targetError = ErrorNormalizer.normalize(
            error,
            AIErrorType.SERVER_START_FAILED,
            'main:initializeFullServices'
          )

          if (service && service.lastInitError) {
            const priorityMap: Record<string, number> = {
              GPU_DRIVER_OUTDATED: 1,
              INSUFFICIENT_VRAM: 1,
              MODEL_OUT_OF_MEMORY: 1,
              INSUFFICIENT_MEMORY: 2,
              GPU_NOT_AVAILABLE: 2,
              MODEL_LOAD_FAILED: 3,
              MODEL_NOT_FOUND: 3,
              MODEL_CORRUPTED: 3,
              FREQUENT_CRASH: 3,
              SERVER_START_FAILED: 4,
              SERVICE_SWITCH_FAILED: 4,
              MODEL_SWITCH_FAILED: 4,
              CONFIG_INVALID: 5,
              CONNECTION_FAILED: 5,
              NETWORK_ERROR: 5,
              SERVER_CRASHED: 5
            }
            const existingPriority = priorityMap[service.lastInitError.code || ''] ?? 99
            const incomingPriority = priorityMap[targetError.code || ''] ?? 99
            if (existingPriority < incomingPriority) {
              targetError = service.lastInitError
            }
          }

          BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
              win.webContents.send('ai-service:error', targetError)
            }
          })
        } catch (normalizeError) {
          logger.error(LogCategory.MAIN, '规范化或广播AI初始化错误失败:', normalizeError)
        }
      }
    }

    logger.info(LogCategory.MAIN, '正在初始化核心引擎...')
    try {
      const adapters = await createCoreEngineAdapters()
      const resourcesPath = app.isPackaged
        ? process.resourcesPath
        : path.join(__dirname, '../../build/extraResources')

      const rendererConfig = ConfigOrchestrator.getInstance().getConfig()
      const defaultLanguage = (rendererConfig.language ||
        ConfigOrchestrator.getInstance().getValue<LanguageCode>('DEFAULT_LANGUAGE') ||
        'zh-CN') as LanguageCode
      const queueConcurrency =
        ConfigOrchestrator.getInstance().getValue<number>('QUEUE_MAX_CONCURRENCY') ?? 3
      const queueBatchSize =
        ConfigOrchestrator.getInstance().getValue<number>('QUEUE_BATCH_SIZE') ?? 10
      const aiTemperature =
        ConfigOrchestrator.getInstance().getValue<number>('MODEL_TEMPERATURE') ?? 0.7
      const aiMaxTokens =
        ConfigOrchestrator.getInstance().getValue<number>('MODEL_MAX_TOKENS') ?? 2048
      const aiTimeout =
        ConfigOrchestrator.getInstance().getValue<number>('AI_REQUEST_TIMEOUT') ?? 300000
      const errorMaxRetries =
        ConfigOrchestrator.getInstance().getValue<number>('ERROR_MAX_RETRIES') ?? 3
      const errorRetryDelay =
        ConfigOrchestrator.getInstance().getValue<number>('ERROR_RETRY_DELAY') ?? 1000

      const engine = createCoreEngine(adapters, {
        language: defaultLanguage,
        resourcesPath,
        errorRecovery: {
          maxRetries: errorMaxRetries,
          retryDelay: errorRetryDelay,
          fileProcessingTimeout: aiTimeout,
          aiRequestTimeout: aiTimeout,
          unitRecognitionTimeout: 5000
        },
        queue: {
          maxConcurrency: queueConcurrency,
          batchSize: queueBatchSize,
          enableAutoRetry: true
        },
        ai: {
          temperature: aiTemperature,
          maxTokens: aiMaxTokens,
          timeout: aiTimeout,
          enableMultimodal: true
        }
      })
      setCoreEngine(engine)

      if (coreEngine) {
        await coreEngine.initialize()
        coreEngine.on('event', (event: unknown) => {
          const allWindows = BrowserWindow.getAllWindows()
          allWindows.forEach(win => {
            win.webContents.send('core-engine-event', event)
          })
        })
      }

      logger.info(LogCategory.MAIN, '核心引擎初始化成功')
    } catch (error) {
      logger.error(LogCategory.MAIN, '核心引擎初始化失败:', error)
    }

    logger.info(LogCategory.MAIN, '正在初始化文件监听服务...')
    try {
      await fileWatcherService.initialize()
      logger.info(LogCategory.MAIN, '文件监听服务初始化成功')
    } catch (error) {
      logger.error(LogCategory.MAIN, '文件监听服务初始化失败:', error)
    }

    logger.info(LogCategory.MAIN, '正在初始化分析队列服务...')
    try {
      await analysisQueueService.initialize()
      logger.info(LogCategory.MAIN, '分析队列服务初始化成功')
      void analysisQueueService.start()
    } catch (error) {
      logger.error(LogCategory.MAIN, '[analysis-queue] 分析队列服务初始化失败:', error)
    }

    registerServiceHealthChecks()
    cloudSyncWorker.start()

    const orchestrator = ConfigOrchestrator.getInstance()

    // 启动 Markitdown Server
    const analysisMode = orchestrator.getValue<string>('ANALYSIS_MODE')
    if (analysisMode === 'document' || analysisMode === 'full') {
      logger.info(
        LogCategory.MAIN,
        `[MarkitdownServer] 分析模式为 ${analysisMode}，正在启动 server...`
      )
      markitdownServerManager.startAndWait().catch(err => {
        logger.error(LogCategory.MAIN, '[MarkitdownServer] Server 启动失败:', err)
      })
    }

    // 监听分析模式变更，按需启动 server
    orchestrator.onValueChange('ANALYSIS_MODE', async mode => {
      if (mode === 'document' || mode === 'full') {
        logger.info(
          LogCategory.MAIN,
          `[MarkitdownServer] 分析模式切至 ${mode}，正在按需启动 server...`
        )
        try {
          await markitdownServerManager.startAndWait()
        } catch (err) {
          logger.error(LogCategory.MAIN, '[MarkitdownServer] 按需启动 server 失败:', err)
        }
      }
    })

    // 启动 AI Skill API 服务
    const startApiService = async (port: number) => {
      const { AISkillApiService } = await import('../runtime-services/ai-skill-api-service')
      const apiService = new AISkillApiService(port, app.getPath('userData'))
      await apiService.start()
      return apiService
    }

    let currentApiService: any = null
    const initialEnableAiSkill = orchestrator.getValue<boolean>('ENABLE_AI_SKILL_API') ?? true
    const initialAiSkillPort = orchestrator.getValue<number>('AI_SKILL_API_PORT') ?? 28686

    if (initialEnableAiSkill) {
      currentApiService = await startApiService(initialAiSkillPort)
    }

    // 监听配置变更
    orchestrator.onValueChange('ENABLE_AI_SKILL_API', async enabled => {
      if (enabled) {
        if (!currentApiService) {
          const port = orchestrator.getValue<number>('AI_SKILL_API_PORT') ?? 28686
          currentApiService = await startApiService(port)
        }
      } else {
        if (currentApiService) {
          await currentApiService.stop()
          currentApiService = null
        }
      }
    })

    orchestrator.onValueChange('AI_SKILL_API_PORT', async port => {
      if (currentApiService) {
        await currentApiService.stop()
        currentApiService = await startApiService(port as number)
      }
    })

    logger.info(LogCategory.MAIN, '初始化阶段完成，所有服务已初始化')
    logger.info(LogCategory.MAIN, '开始同步云端配置...')

    logger.info(LogCategory.MAIN, '完整服务初始化完成')
  } catch (error) {
    logger.error(LogCategory.MAIN, '服务初始化失败:', error)
  }
}
