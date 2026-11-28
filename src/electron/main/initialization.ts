import { app, BrowserWindow } from 'electron'
import * as os from 'os'
import {
  logger,
  LogCategory,
  ErrorNormalizer,
  isTestEnvironment,
  shouldSkipAIServiceInTest,
  ResourceLocator,
  APP_PORTS
} from '@firefly/shared'
import { AIErrorType, AIServiceStatus, StartupPhase, UserTier } from '@firefly/types'
import type { AICapabilities, LanguageCode } from '@firefly/types'
import { databaseService } from '../runtime-services/database/database-service'
import { cloudAnalysisService, WORKSPACE_CONSTANTS } from '@firefly/server'
import { createSupabaseClient } from '../runtime-services/system/supabase-client-factory'
import { analysisQueueService } from '../runtime-services/analysis-queue-service'
import { moduleHibernationCoordinator } from '../runtime-services/hibernation/module-hibernation-coordinator'
import { isTTSActive } from './ipc-handlers/tts'
import { systemHealthService } from '../runtime-services/system/system-health-service'
import {
  llamaServerService,
  LlamaIndexAIService,
  multiModalModelService,
  ConfigOrchestrator as AIPackageConfigOrchestrator
} from '@firefly/electron-llamaIndex-service'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { fileDownloadService } from '../runtime-services/system/file-download-service'
import { DirectoryContextService } from '../runtime-services/filesystem/directory-context-service'
import { OrganizeRealDirectoryService } from '../runtime-services/filesystem/organize-real-directory-service/index'
import { FileCleanupService } from '../runtime-services/filesystem/file-cleanup-service'
import { fileWatcherService } from '../runtime-services/filesystem/file-watcher-service'
import { workspaceAdmissionService } from '../runtime-services/workspace/workspace-admission-service'
import { loadIgnoreRules } from '../runtime-services/analysis/analysis-exclusion-service'
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
import { omniService } from '../runtime-services/system/omni-service'
import { omniClient } from '../services/omni-client'
import { invalidateClipTextWarmState } from '../runtime-services/filesystem/virtual-directory-service/HybridSearchArbiter'

/** CLIP 文本陈旧状态复位监听是否已注册（幂等保护：重复初始化/热重载都不得重复注册） */
let clipTextRuntimeResetRegistered = false

/** ConfigDbManager 词表自愈监听是否已延迟绑定（幂等保护） */
let configDbTaxonomySelfHealRegistered = false

/**
 * 延迟绑定 ConfigDbManager 词表空表自愈（Spec §3.3 / Ticket 04）：
 * - Push：订阅 `omniService.onInstanceChanged`（不受 Coordinator 的 `observedGeneration` 过滤影响），
 *   实例就绪或重启切换时清空负缓存并触发空表补灌与有界退避重试；
 * - Pull：订阅后立即 `await omniService.ensureRunning()` 确认当前是否已就绪，消除错失早期事件导致的空表死锁。
 */
export async function registerConfigDbTaxonomySelfHeal(): Promise<void> {
  if (!configDbTaxonomySelfHealRegistered) {
    configDbTaxonomySelfHealRegistered = true
    omniService.onInstanceChanged(() => {
      const manager = ConfigDbManager.getInstance()
      manager.clearUnresolvableCodeCache()
      void manager.triggerEmptyTableSelfHeal().catch(err => {
        logger.warn(LogCategory.CONFIG, '[ConfigDbManager] onInstanceChanged 触发词表自愈异常:', err)
      })
    })
  }

  const ready = await omniService.ensureRunning().catch(() => false)
  if (ready) {
    await ConfigDbManager.getInstance()
      .triggerEmptyTableSelfHeal()
      .catch(err => {
        logger.warn(LogCategory.CONFIG, '[ConfigDbManager] ensureRunning pull 触发词表自愈异常:', err)
      })
  }
}

/**
 * 注册「Omni 就绪 ⇒ CLIP 文本第 5 路陈旧状态复位」。
 *
 * 必要性：`firefly-omni` 进程（重）启动后，`/health.clipText` 缓存（5 分钟）与 3 个
 * `HybridSearchArbiter` 实例热态时间戳都会停留在一个已经消失的进程上 —— 于是用 800ms
 * 热态预算去打一次真实 1045~1195ms 的冷加载，超时失败后还会计入本路熔断。
 *
 * 挂点选 `omniService.onReady`：它是**事件**（复用已运行实例 / 端口顺延复用 / 新进程探活就绪
 * 三条路径），不是轮询，因此稳态检索不会反复触发复位；且不放进任何懒单例的构造函数，
 * 避免「单例没被用到就永远不注册」。
 */
function registerClipTextRuntimeReset(): void {
  if (clipTextRuntimeResetRegistered) return
  clipTextRuntimeResetRegistered = true
  omniService.onReady(() => {
    omniClient.clearClipTextHealthCache()
    invalidateClipTextWarmState()
    logger.info(LogCategory.MAIN, '[CLIP] Omni 已就绪，已复位文本塔探活缓存与热态纪元')
    // 延迟 3s 后台静默预热 70 套官方工作流向量缓存，避免用户首次打开工作目录向导时现场编码 70 套触发超时降级
    setTimeout(() => {
      import('../runtime-services/workflow/workflow-semantic-matcher-service')
        .then(({ WorkflowSemanticMatcherService }) =>
          WorkflowSemanticMatcherService.getInstance().tryPrewarm()
        )
        .catch(() => {})
    }, 3000)
  })
}
import { invitationService } from '../runtime-services/invitation/invitation-service'
import { modelMigrationService } from '../runtime-services/llama/model-migration-service'
import { deploymentIntegrityVerifier } from '../runtime-services/llama/deployment-integrity-verifier'
import { aiErrorHandler } from '../runtime-services/ai/ai-error-handler'
import { cloudSyncWorker } from '../runtime-services/ai/cloud-sync-worker'
import { AISkillApiService } from '../runtime-services/ai-skill-api-service'
import { dataMigrationService } from '../runtime-services/system/data-migration-service'
import { ConfigDbManager } from '../runtime-services/config/config-db-manager'
import { createModelCapabilityAdapter } from '../adapters/model-capability-adapter'
import * as path from 'path'
import * as fs from 'fs'
import { resolveAppRegion } from './worktree-env'
import {
  computeUpdaterCacheDir,
  seedBaselineInstaller
} from '../runtime-services/system/installer-baseline-seeder'
import {
  globalLlamaIndexService,
  setGlobalLlamaIndexService,
  coreEngine,
  setCoreEngine,
  directoryContextService,
  setDirectoryContextService,
  setOrganizeRealDirectoryService,
  setFileCleanupService,
  setOrphanGcScheduler,
  orphanGcScheduler,
  initializationPhaseStarted,
  setInitializationPhaseStarted,
  virtualDirectoryService
} from './state'
import { OrphanGcScheduler } from './orphan-gc-scheduler'
import { recoverPendingFsJournals } from '../runtime-services/filesystem/fs-journal-recovery'
import { enrichAIStatus, clearEnrichCache } from './utils'
import { t, changeLanguage } from '@app/languages'
import { mark } from '@pro/perf/startup-timeline'
import { settleGateOk, settleGateFailed } from './startup-gates'
import { getPerfFlagsSnapshot } from './perf-flags'

/**
 * 初始化硬件检测并更新统一配置
 */
export async function initializeHardwareDetection(wait = false): Promise<void> {
  try {
    logger.debug(LogCategory.STARTUP, `正在${wait ? '同步' : '异步'}检测系统硬件资源...`)

    const config = ConfigOrchestrator.getInstance()
    const oldInfo = {
      cpu: config.getValue('HARDWARE_CPU_INFO'),
      memory: config.getValue('HARDWARE_MEMORY_INFO'),
      gpu: config.getValue('HARDWARE_GPU_INFO'),
      storage: config.getValue('HARDWARE_STORAGE_INFO')
    }

    const runDetection = async () => {
      const resources = await hardwareDetectionService.detectSystemResources(true)
      logger.debug(LogCategory.STARTUP, '硬件资源检测完成，正在对比变更...', {
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

      // 若未显式设置嵌入画像档位（首次运行），按硬件能力自适应推荐并持久化 (Spec §3.4.1 & AC 4.2)
      if (!config.hasUserConfig('AI_EMBEDDING_PROFILE')) {
        const memRaw = resources?.memory?.total || 0
        const totalMemGB = memRaw > 1024 * 1024 ? memRaw / (1024 * 1024 * 1024) : memRaw / 1024
        const cpuCores = resources?.cpu?.cores || os.cpus().length

        const settings = hardwareDetectionService.getRecommendedEmbeddingSettings?.({
          totalMemGB,
          cpu: { cores: cpuCores }
        }) || {
          profile: totalMemGB >= 7.5 && cpuCores > 4 ? 'gemma_unified' : 'classic_light',
          mrlDimension: totalMemGB >= 15.5 ? 768 : totalMemGB >= 7.5 ? 512 : 256,
          videoSoftTokenBudget: totalMemGB < 7.5 || cpuCores <= 4 ? 70 : 140
        }
        config.updateValue('AI_EMBEDDING_PROFILE', settings.profile)
        config.updateValue('EMBEDDING_MRL_DIMENSION', settings.mrlDimension)
        // 抽帧间隔已改由引擎按 120s 单文件预算自决，不再持久化（避免与引擎求解值冲突）
        config.updateValue('VIDEO_SOFT_TOKEN_BUDGET', settings.videoSoftTokenBudget)
        logger.debug(
          LogCategory.STARTUP,
          `[Profile] 首次启动自适应推荐嵌入画像: profile=${settings.profile}, mrl=${settings.mrlDimension}, videoTokens=${settings.videoSoftTokenBudget} (内存: ${totalMemGB.toFixed(1)}GB, CPU: ${cpuCores}核)`
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
      mark('hw:detected')
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
 * 初始化数据库及依赖于数据库的服务
 */
/**
 * Critical 层纯本地数据库初始化（ST-P0-2：零网络、零外部进程，必须在 createMainWindow 之前完成）。
 * 含 databaseService.initialize + ConfigDbManager + recoverPendingFsJournals + reloadDatabase。
 * 任何致命失败均原样上浮并 settle dbReady 失败，绝不伪兜底。
 */
export async function initDatabaseCore(language: LanguageCode, force = false): Promise<void> {
  try {
    logger.debug(
      LogCategory.MAIN,
      `正在初始化数据库核心服务 (语言: ${language}${force ? ', 强制重新初始化' : ''})...`
    )

    if (force && databaseService.db) {
      logger.debug(LogCategory.MAIN, '强制重新初始化：关闭旧数据库连接...')
      databaseService.close()
      virtualDirectoryService.reset()
      databaseService.clearPostMigrationCallbacks()
    }

    databaseService.registerPostMigrationCallback((db, currentLang) => {
      ConfigDbManager.getInstance().loadFromJson(db, currentLang)
    })

    ConfigOrchestrator.registerConfigDbManager(ConfigDbManager.getInstance())

    if (typeof changeLanguage === 'function') {
      try {
        await changeLanguage(language)
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '主进程切换 i18n 语言失败:', err)
      }
    }

    await databaseService.initialize(language)
    await ConfigDbManager.getInstance().initialize(language, force)

    workspaceAdmissionService.configureRuntimeDependencies({
      getDb: () => databaseService.db,
      systemRulesProvider: () => loadIgnoreRules()
    })

    const { modularResourceService } =
      await import('../runtime-services/system/modular-resource-service')
    modularResourceService.configureRuntimeDependencies({
      getDb: () => databaseService.db,
      configOrchestrator: ConfigOrchestrator.getInstance()
    })
    modularResourceService.setConfigOrchestrator(ConfigOrchestrator.getInstance())

    const { workspacePolicyCommitService } =
      await import('../runtime-services/workspace/workspace-policy-commit-service')
    workspacePolicyCommitService.configureDependencies({
      getDb: () => databaseService.db
    })

    unifiedModelManager.ensureLoaded(true)

    if (databaseService.db) {
      try {
        databaseService.db
          .prepare("DELETE FROM builtin_modules WHERE id = 'ai_organize_skill'")
          .run()
      } catch (cleanErr) {
        logger.warn(LogCategory.MAIN, '[Initialization] 清理 ai_organize_skill 记录失败:', cleanErr)
      }

      if (globalLlamaIndexService) {
        setDirectoryContextService(new DirectoryContextService(globalLlamaIndexService))
      }

      setOrganizeRealDirectoryService(new OrganizeRealDirectoryService(databaseService.db as any))
      const cleanupService = new FileCleanupService(databaseService.db)
      setFileCleanupService(cleanupService)

      orphanGcScheduler?.stop()
      const gcScheduler = new OrphanGcScheduler(cleanupService)
      setOrphanGcScheduler(gcScheduler)
      gcScheduler.start()

      // [Issue 04 收尾 / ST-P0-2] 启动期 fs_operation_journal 自愈必须在开放业务前完成；
      // 若抛出不可恢复致命异常，绝不吞掉伪兜底，由上层销毁 splash 并受控 exit(1)。
      await recoverPendingFsJournals(databaseService.db!)
      mark('db:journal-recovered')

      await analysisQueueService.reloadDatabase()
      mark('db:ready')
      settleGateOk('dbReady')
    } else {
      throw new Error('数据库初始化失败，未获得有效的数据库实例')
    }
  } catch (error) {
    settleGateFailed('dbReady', error)
    logger.error(LogCategory.MAIN, '初始化数据库核心服务失败:', error)
    throw error
  }
}

/**
 * Deferred 链 1：数据库就绪后的后台监听器、对账与云端配置同步（ST-P0-2 / ST-P1-5 / J-11）。
 * 在 recoverPendingFsJournals 与 reloadDatabase 之后执行，切语言与向导首启共用本入口。
 */
export async function startDatabaseRuntimeWatchers(): Promise<void> {
  if (!databaseService.db) return

  // J-11 第 2 步：在 journal 自愈与 reloadDatabase 之后串行启动文件监听
  await fileWatcherService.startAllAutoWatchers().catch(err => {
    logger.error(LogCategory.MAIN, '启动文件监听失败:', err)
  })

  setImmediate(() => {
    void workspaceAdmissionService.reconcileAllWorkspacesOnStartup().catch(err => {
      logger.warn(LogCategory.MAIN, '启动期工作区准入对账自愈异常:', err)
    })
  })

  try {
    const { workspaceRuntimeContextService } =
      await import('../runtime-services/system/workspace-runtime-context-service')
    workspaceRuntimeContextService.initialize()
  } catch (err) {
    logger.warn(
      LogCategory.MAIN,
      '[Initialization] 初始化 WorkspaceRuntimeContextService 异常:',
      err
    )
  }

  try {
    const { tombstoneGCService } =
      await import('../runtime-services/modular-resource/tombstone-gc')
    const { modularResourceService } =
      await import('../runtime-services/system/modular-resource-service')
    const persistenceFile = path.join(
      app.getPath('userData'),
      'modules',
      '_pending_tombstones.json'
    )
    tombstoneGCService.setPersistenceFile(persistenceFile)
    setImmediate(() => {
      modularResourceService.reconcileOnStartup().catch(err => {
        logger.warn(LogCategory.MAIN, '[Initialization] 插件模块启动期对账自愈异常:', err)
      })
    })
  } catch (err) {
    logger.warn(LogCategory.MAIN, '[Initialization] 配置 Tombstone 持久化异常:', err)
  }

  try {
    const { userTierService } = await import('../runtime-services/user-tier/user-tier-service')
    await userTierService.initialize()
  } catch (e) {
    logger.error(LogCategory.MAIN, '[Initialization] tier 服务初始化失败:', e)
  }

  // 云端依赖（cloudSyncWorker + ConfigDbManager.syncFromCloud）严格等待 cloudReady 门闸后再触发
  void import('./startup-gates').then(async ({ gate }) => {
    const cloudSettlement = await gate('cloudReady')
    if (cloudSettlement.ok) {
      cloudSyncWorker.start()
      ConfigDbManager.getInstance()
        .syncFromCloud()
        .catch(err => {
          logger.error(LogCategory.CONFIG, '数据库初始化后同步云端配置失败:', err)
        })
    }
  })
}

export async function initDatabaseAndDependentServices(
  language: LanguageCode,
  force = false
): Promise<void> {
  await initDatabaseCore(language, force)
  await startDatabaseRuntimeWatchers()
  logger.debug(LogCategory.MAIN, '依赖数据库的业务服务初始化完成')
}

/**
 * 注册服务健康检查
 *
 * [N3] 周期健康巡检已停用（2026-11-27 决策），systemHealthService.start() 不再恢复；
 * 可用性由各能力用时检查与按需拉起保证，保留以下注册代码作命名防腐。
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

  logger.debug(LogCategory.MAIN, '服务健康检查注册完成')
}

/**
 * 初始化配置阶段所需的最小服务集合
 */
let deferredChainPromise: Promise<void> | null = null

/**
 * Deferred 启动链（ST-P0-2 / ST-P1-2 / ST-P1-3 / ST-P1-6）：
 * 在主窗口 ready-to-show 之后单飞触发，不阻塞首屏渲染。
 * 欢迎向导期间（LANGUAGE_CONFIRMED=false）绝不抢跑。
 */
export function runDeferredStartupChain(): Promise<void> {
  if (deferredChainPromise) {
    return deferredChainPromise
  }

  deferredChainPromise = (async () => {
    logger.debug(LogCategory.MAIN, '[Deferred] 启动后台延迟初始化链...')

    // 1. 数据库就绪后的监听器、对账与云端配置同步
    await startDatabaseRuntimeWatchers().catch(err => {
      logger.warn(LogCategory.MAIN, '[Deferred] 数据库后台监听器启动异常:', err)
    })

    // 2. Supabase 设备注册（cloudReady 门闸，失败时 settle { ok: false } 不永挂）
    try {
      const machineId = SystemIdentityService.getInstance().getMachineId()
      const supabaseClient = createSupabaseClient(
        WORKSPACE_CONSTANTS.SUPABASE_URL,
        WORKSPACE_CONSTANTS.SUPABASE_ANON_KEY,
        machineId
      )
      cloudAnalysisService.setSupabaseClient(supabaseClient)
      cloudAnalysisService.setIdentityProvider(SystemIdentityService.getInstance())
      await cloudAnalysisService.initialize()
      mark('cloud:registered')
      settleGateOk('cloudReady')
    } catch (err) {
      settleGateFailed('cloudReady', err)
      logger.warn(LogCategory.MAIN, '[Deferred] 系统身份 Supabase 注册未完成 (可能离线):', err)
    }

    // 3. 在线授权校验（穿透 5s 节流，远端结果无条件覆盖本地 LOCAL_GRACE_PENDING）
    try {
      const licenseResult = await LicenseService.getInstance().checkLicenseStatus(true)
      mark('license:online')
      if (licenseResult.status === LicenseStatus.AUTHORIZED) {
        await ConfigOrchestrator.getInstance().updateValue('MACHINE_REGISTERED', true)
        void initializeLlamaServer().catch(err => {
          logger.warn(LogCategory.MAIN, '[LlamaServer] 延迟健康检查异常:', err)
        })
      }
    } catch (err) {
      logger.warn(LogCategory.MAIN, '[Deferred] 后台授权校验异常:', err)
    }

    // 4. 外部服务与引擎桥接（FFmpeg + Tier 2 引擎 + 全量后台服务）
    await ffmpegService.initialize().catch(err => {
      logger.warn(LogCategory.MAIN, '[Deferred] FFmpeg 服务初始化异常:', err)
    })

    try {
      const { engineBridgeService } = await import('../runtime-services/engine-bridge')
      moduleHibernationCoordinator.setEngineBridgeService(engineBridgeService)
      const initMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
      if (initMode !== 'cloud' && initMode !== 'disabled') {
        const tier2Online = await engineBridgeService.ensureRunning().catch(() => false)
        mark(tier2Online ? 'engine:ready' : 'engine:failed')
      }
    } catch (err) {
      mark('engine:failed')
      logger.warn(LogCategory.MAIN, '[Deferred] Tier 2 引擎桥接异常:', err)
    }

    if (ConfigOrchestrator.getInstance().getValue<boolean>('LANGUAGE_CONFIRMED')) {
      await initializeFullServices().catch(err => {
        logger.warn(LogCategory.MAIN, '[Deferred] initializeFullServices 异常:', err)
      })
    }

    // 非首启路径补跑异步硬件探测，不阻塞主流程
    if (!ConfigOrchestrator.getInstance().getValue<boolean>('IS_FIRST_RUN')) {
      void initializeHardwareDetection(false)
    }

    logger.debug(LogCategory.MAIN, '[Deferred] 后台延迟初始化链完成')
  })()

  return deferredChainPromise
}

export async function initializeMinimalServices(options?: {
  onProgress?: (msg: string) => void
}): Promise<void> {
  const perfFlags = getPerfFlagsSnapshot(app.getPath('userData'))
  const isSplitMode = perfFlags.startup.earlyWindow && process.env.NODE_ENV !== 'test'

  try {
    // 关键：将桌面侧 ConfigOrchestrator 注入 AI 包（包内服务如 unifiedModelManager 通过该静态入口读取配置）
    AIPackageConfigOrchestrator.setInstance(ConfigOrchestrator.getInstance())
    logger.debug(LogCategory.MAIN, '正在初始化配置阶段所需的最小服务...')
    invitationService.initialize()

    hardwareDetectionService.setConfigOrchestrator(ConfigOrchestrator.getInstance())
    hardwareDetectionService.setDeploymentIntegrityVerifier(deploymentIntegrityVerifier)

    moduleHibernationCoordinator.setAnalysisQueueService(analysisQueueService)
    moduleHibernationCoordinator.setTtsActiveChecker(isTTSActive)
    moduleHibernationCoordinator.setOmniLifecycleProvider(omniService)
    const managedOmniModuleIds = [
      'tts-m5-onnx',
      'tts-moss-onnx',
      'asr-sensevoice-onnx',
      'pocket-cpu-int8-onnx'
    ] as const
    omniService.onLifecycleInactive(nextGeneration => {
      for (const moduleId of managedOmniModuleIds) {
        moduleHibernationCoordinator.forceResetExternalHibernated(moduleId, nextGeneration)
      }
    })
    omniService.onInstanceChanged(nextGeneration => {
      for (const moduleId of managedOmniModuleIds) {
        moduleHibernationCoordinator.forceResetExternalHibernated(moduleId, nextGeneration)
      }
    })
    registerClipTextRuntimeReset()

    LicenseService.getInstance().initializeGraceTimestamps()
    LicenseService.getInstance().startTimeMonitor()

    if (isSplitMode) {
      // Critical 分层启动路径：仅执行纯本地 DB + Journal 自愈 + 本地快速授权判定，
      // 严禁在建主窗前阻塞于网络或外部进程。
      const isFirstRun = ConfigOrchestrator.getInstance().getValue<boolean>('IS_FIRST_RUN')
      if (isFirstRun) {
        await initializeHardwareDetection(true)
      }

      const isLanguageConfirmed =
        ConfigOrchestrator.getInstance().getValue<boolean>('LANGUAGE_CONFIRMED')
      if (isLanguageConfirmed) {
        const language = ConfigOrchestrator.getInstance().getValue<string>(
          'DEFAULT_LANGUAGE'
        ) as LanguageCode
        await initDatabaseCore(language)
        await dataMigrationService.migrate()
      } else {
        settleGateOk('dbReady')
      }

      // 构造轻量 LlamaIndexAIService 实例供阶段 A 注入 DirectoryContextService
      if (!globalLlamaIndexService) {
        setGlobalLlamaIndexService(
          LlamaIndexAIService.getInstance(
            ConfigOrchestrator.getInstance(),
            llamaServerService,
            ConfigOrchestrator.getInstance()
          )
        )
      }
      settleGateOk('phaseAGate')

      await LicenseService.getInstance().checkLocalLicenseFast()
      mark('license:local')

      LicenseService.getInstance()
        .restoreFromOfflineLicenseIfNeeded()
        .catch(err => {
          logger.error(LogCategory.SYSTEM, '[License] 从离线授权恢复 userTierData 失败:', err)
        })
      networkInterceptorService.initialize().catch(err => {
        logger.error(LogCategory.SYSTEM, '网络拦截服务初始化失败:', err)
      })

      logger.debug(LogCategory.MAIN, 'Critical 阶段最小服务初始化完成')
      return
    }

    // 回退或测试全量串行路径（earlyWindow=0 或 NODE_ENV=test）
    await initializeHardwareDetection(true)

    const machineId = SystemIdentityService.getInstance().getMachineId()
    const supabaseClient = createSupabaseClient(
      WORKSPACE_CONSTANTS.SUPABASE_URL,
      WORKSPACE_CONSTANTS.SUPABASE_ANON_KEY,
      machineId
    )
    cloudAnalysisService.setSupabaseClient(supabaseClient)
    cloudAnalysisService.setIdentityProvider(SystemIdentityService.getInstance())
    logger.debug(LogCategory.MAIN, '系统身份服务初始化成功')

    try {
      await cloudAnalysisService.initialize()
      settleGateOk('cloudReady')
      logger.debug(LogCategory.MAIN, '系统身份 Supabase 注册完成')
    } catch (err) {
      settleGateFailed('cloudReady', err)
      logger.warn(LogCategory.MAIN, '系统身份 Supabase 注册未完成 (可能离线):', err)
    }
    mark('cloud:registered')

    try {
      const { engineBridgeService } = await import('../runtime-services/engine-bridge')
      moduleHibernationCoordinator.setEngineBridgeService(engineBridgeService)
      const initMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
      if (initMode !== 'cloud' && initMode !== 'disabled') {
        const tier2Online = await engineBridgeService.ensureRunning().catch(() => false)
        mark(tier2Online ? 'engine:ready' : 'engine:failed')
      }
    } catch (bridgeError) {
      mark('engine:failed')
      logger.warn(
        LogCategory.MAIN,
        '[EngineBridge] Tier 2 引擎桥接初始化异常（不阻断启动）:',
        bridgeError
      )
    }

    await ffmpegService.initialize()
    logger.debug(LogCategory.MAIN, 'FFmpeg 服务初始化完成')

    const isLanguageConfirmed =
      ConfigOrchestrator.getInstance().getValue<boolean>('LANGUAGE_CONFIRMED')
    if (isLanguageConfirmed) {
      const language = ConfigOrchestrator.getInstance().getValue<string>(
        'DEFAULT_LANGUAGE'
      ) as LanguageCode
      await initDatabaseAndDependentServices(language)
      await dataMigrationService.migrate()
      logger.debug(LogCategory.MAIN, '数据库服务初始化成功')
    } else {
      settleGateOk('dbReady')
      logger.debug(
        LogCategory.MAIN,
        '[Initialization] 语言尚未确认 (LANGUAGE_CONFIRMED = false)，延迟初始化数据库，等待用户选择语言...'
      )
    }

    try {
      unifiedModelManager.ensureLoaded()
      logger.debug(LogCategory.MAIN, '统一模型配置初始化成功 (含云端服务商)')
    } catch (error) {
      logger.error(LogCategory.MAIN, '统一模型配置初始化失败:', error)
    }

    settleGateOk('phaseAGate')

    LicenseService.getInstance()
      .restoreFromOfflineLicenseIfNeeded()
      .catch(err => {
        logger.error(LogCategory.SYSTEM, '[License] 从离线授权恢复 userTierData 失败:', err)
      })

    networkInterceptorService.initialize().catch(err => {
      logger.error(LogCategory.SYSTEM, '网络拦截服务初始化失败:', err)
    })

    logger.debug(LogCategory.MAIN, '配置阶段最小服务初始化完成')
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
    logger.debug(LogCategory.MAIN, '进入初始化阶段，开始完整服务初始化...')
    logger.debug(LogCategory.MAIN, '正在初始化统一AI服务...')

    const fullInitMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')

    if (fullInitMode === 'cloud') {
      logger.debug(LogCategory.MAIN, '当前为云端模式，跳过本地 AI 引擎初始化')
    } else if (fullInitMode === 'disabled') {
      logger.debug(LogCategory.MAIN, '当前为禁用模式，跳过本地 AI 引擎初始化')
    } else {
      logger.debug(LogCategory.MAIN, '本地模式：启动阶段自适应拉起 Tier 2 引擎模型推理服务')
      // 启动阶段在初始化 AI 服务前，确保外部 Tier 2 引擎与模型推理服务就绪（避免 waitForModelReady 超时）
      if (!shouldSkipAIServiceInTest()) {
        try {
          const { engineBridgeService } = await import('../runtime-services/engine-bridge')
          const targetMode = analysisQueueService.determineIntentMode()
          if (!targetMode) {
            logger.debug(
              LogCategory.MAIN,
              '[EngineBridge] 启动阶段判定当前无需拉起引擎模型（分析模式为标准分析且无高维修正需求）'
            )
          } else {
            logger.debug(
              LogCategory.MAIN,
              `[EngineBridge] 启动阶段自适应拉起 Tier 2 引擎模型，目标意图: ${targetMode}`
            )
            const res = await engineBridgeService.ensureMode(targetMode, { force: true })
            mark(res.ok ? 'engine:ready' : 'engine:failed')
            if (res.ok) {
              logger.debug(
                LogCategory.MAIN,
                `[EngineBridge] Tier 2 引擎模型推理服务已就绪 (${targetMode})`
              )
            } else {
              logger.warn(LogCategory.MAIN, `[EngineBridge] 引擎模型服务拉起告警: ${res.error}`)
            }
          }
        } catch (err) {
          mark('engine:failed')
          logger.warn(LogCategory.MAIN, '[EngineBridge] 启动阶段拉起引擎模型服务失败:', err)
        }
      }
    }

    // PRD-0044：MODEL_STORAGE_PATH 配置键删除；内置元数据底座迁移按默认底座目录（userData/models）静默执行
    // （迁移进度 IPC 已随「内置模型迁移链」清退，服务仅做文件迁移并写日志）
    const modelStoragePath = unifiedModelManager.getModelBaseDir()
    try {
      await modelMigrationService.migrateModels(modelStoragePath)
    } catch (err) {
      logger.error(LogCategory.MAIN, '内置模型后台静默迁移失败:', err)
    }

    // Inject ModelManager into multiModalModelService
    multiModalModelService.setModelManager(unifiedModelManager)

    if (!globalLlamaIndexService) {
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
              file_fingerprint, sync_status, created_at_ms
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
              Date.now()
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
        logger.debug(
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

      if (
        !shouldSkipAIServiceInTest() &&
        typeof (service as any).setEnsureLocalServerHandler === 'function'
      ) {
        ;(service as any).setEnsureLocalServerHandler(async () => {
          const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
          if (mode === 'disabled' || mode === 'cloud' || mode === 'cpu') {
            return false
          }
          const { engineBridgeService } = await import('../runtime-services/engine-bridge')
          const targetMode = analysisQueueService.determineIntentMode() ?? 'language'
          const res = await engineBridgeService.ensureMode(targetMode, { force: true })
          return res.ok
        })
      }

      // 缓存上次的模型身份和能力信息，避免未切换模型时重复检测
      let lastModelIdentity: string | null = null
      let lastCapabilities: AICapabilities | null = null

      // 监听模型配置更新，发生变更时强行使状态缓存与能力缓存失效
      ConfigOrchestrator.getInstance().onConfigChange(changes => {
        if (
          // PRD-0044：SELECTED_MODEL_ID / SELECTED_MODEL_SOURCE 订阅点随配置键删除（本地模型身份以引擎桥接快照为准）
          'AI_CLOUD_SELECTED_MODEL_ID' in changes ||
          'AI_SERVICE_MODE' in changes ||
          'AI_CLOUD_PROVIDER' in changes
        ) {
          logger.info(LogCategory.MAIN, '[initialization] 模型关键配置变更，重置模型身份与能力缓存')
          lastModelIdentity = null
          lastCapabilities = null
          clearEnrichCache()
          createModelCapabilityAdapter().clearCache()
        }

        // PRD-0044：生效引擎切换为「禁用/云端」时，完全退出萤核AI引擎应用（不再需要本地推理）；
        // 反向对称：用户显式选择「萤核AI引擎」（local）时，desktop 主动拉起引擎应用，
        // 避免用户还要额外点一次设置页按钮。
        // onConfigChange 回调的 changes 值即为该 key 的新值
        if ('AI_SERVICE_MODE' in changes) {
          const newMode = changes['AI_SERVICE_MODE']
          if (newMode === 'disabled' || newMode === 'cloud' || newMode === 'cpu') {
            logger.info(
              LogCategory.MAIN,
              `[initialization] 生效引擎切换为 ${newMode}，请求萤核AI引擎完全退出`
            )
            void (async () => {
              try {
                const { engineBridgeService } = await import('../runtime-services/engine-bridge')
                await engineBridgeService.shutdown()
              } catch (err) {
                logger.warn(
                  LogCategory.MAIN,
                  '[initialization] 请求引擎退出失败（引擎可能未运行）:',
                  err
                )
              }
            })()
          } else if (newMode === 'local') {
            logger.info(
              LogCategory.MAIN,
              '[initialization] 生效引擎切换为 local，主动自适应拉起萤核AI引擎模型'
            )
            void (async () => {
              try {
                const { engineBridgeService } = await import('../runtime-services/engine-bridge')
                const targetMode = analysisQueueService.determineIntentMode()
                if (targetMode) {
                  const res = await engineBridgeService.ensureMode(targetMode)
                  logger.info(
                    LogCategory.MAIN,
                    `[initialization] 萤核AI引擎${res.ok ? `已就绪并启动 (${targetMode})` : '未能拉起（将由 Tier 1 兜底）'}`
                  )
                } else {
                  logger.info(
                    LogCategory.MAIN,
                    '[initialization] 生效引擎切换为 local，当前无需拉起模型（标准分析或无待办）'
                  )
                }
                if (analysisQueueService.hasPendingItems()) {
                  logger.info(
                    LogCategory.MAIN,
                    '[initialization] 切换 local 模式后检测到待办任务，自动启动分析队列循环'
                  )
                  void analysisQueueService.start()
                }
              } catch (err) {
                logger.warn(LogCategory.MAIN, '[initialization] 主动拉起萤核AI引擎失败:', err)
              }
            })()
          }
        }
      })

      service.onStatusChange(async info => {
        const orchestrator = ConfigOrchestrator.getInstance()
        const mode = orchestrator.getValue<string>('AI_SERVICE_MODE') || 'local'
        // PRD-0044：本地分支模型身份唯一真相 = 萤核AI引擎侧当前加载模型（桥接快照），desktop 不再读 SELECTED_MODEL_ID
        const activeModelId =
          mode === 'cloud'
            ? orchestrator.getValue<string>('AI_CLOUD_SELECTED_MODEL_ID')
            : (await import('../runtime-services/engine-bridge')).engineBridgeService.getSnapshot()
                .model
        const cloudProvider =
          mode === 'cloud' ? orchestrator.getValue<string>('AI_CLOUD_PROVIDER') : null

        // 构建当前模型身份标识（结合真实选中的 modelId、mode 和 provider，避免受滞后 status 干扰）
        const currentModelIdentity = JSON.stringify({
          mode,
          modelId: activeModelId,
          provider: cloudProvider || info.provider
        })

        // 仅当模型身份发生变化或未命中缓存时才重新检测能力
        if (currentModelIdentity !== lastModelIdentity || !lastCapabilities) {
          try {
            const adapter = createModelCapabilityAdapter()
            adapter.clearCache()
            const caps = await adapter.getCapabilities()
            lastCapabilities = caps
            info.capabilities = caps
            info.modelName = caps.modelName || activeModelId || info.modelName
            info.provider = caps.provider || cloudProvider || info.provider
          } catch (err) {
            logger.error(LogCategory.MAIN, '[StatusChange] Failed to fetch capabilities:', err)
          }
          lastModelIdentity = currentModelIdentity
        } else if (lastCapabilities) {
          // 模型未切换，复用缓存的能力信息
          info.capabilities = lastCapabilities
          info.modelName = lastCapabilities.modelName || activeModelId || info.modelName
          info.provider = lastCapabilities.provider || cloudProvider || info.provider
        }

        const enrichedInfo = await enrichAIStatus(info)
        logger.debug(LogCategory.MAIN, 'AI服务状态变更，广播给渲染进程:', enrichedInfo)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('ai-model-status-changed', enrichedInfo)
          }
        })
      })

      // PRD-0044（S5）：模型未下载通知链（onModelNotDownloaded → model-not-downloaded IPC）
      // 随「内置模型下载链」清退删除：渲染侧强制跳转监听器已下线，模型存在性归萤核AI引擎自管
    }

    if (globalLlamaIndexService) {
      try {
        if (!globalLlamaIndexService.isInitialized()) {
          // 单元/集成测试环境下跳过 AI 服务初始化（使用 mock 数据），E2E 端到端测试不跳过真实 AI 初始化
          if (shouldSkipAIServiceInTest()) {
            logger.debug(LogCategory.MAIN, '[Test] 集成测试环境跳过 AI 服务初始化')
          } else {
            await globalLlamaIndexService.initialize()
          }
        }
        logger.debug(LogCategory.MAIN, '统一AI服务初始化成功')
      } catch (error) {
        const errCode = (error as any)?.code
        const errStr = error instanceof Error ? error.message : String(error)
        const isNoEngineOrDegraded =
          errCode === 'no_engine_installed' ||
          errStr.includes('no_engine_installed') ||
          errStr.includes('未检测到已安装或硬件兼容的计算引擎') ||
          errStr.includes('未安装本地推理引擎') ||
          errStr.includes('未发现任何 llama-server 引擎') ||
          errStr.includes('没有任何与当前硬件指令集兼容的可用引擎') ||
          errStr.includes('未找到萤核AI引擎可执行文件')

        if (isNoEngineOrDegraded) {
          logger.info(
            LogCategory.MAIN,
            '[initialization] 本地 AI 推理引擎未安装或未就绪，系统转由基础 AI 引擎全程保底，不阻塞应用启动与文件分析'
          )
        } else {
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
      } finally {
        // 保证无论 AI 引擎是否就绪，工作区目录上下文服务 100% 成功注入
        if (databaseService.db && !directoryContextService) {
          setDirectoryContextService(new DirectoryContextService(globalLlamaIndexService))
          logger.debug(LogCategory.MAIN, '目录上下文服务已初始化')
        }
      }
    }

    // 启动时序铁律 (§3.1): 先执行 DB 绑定同步对账、冷启动回收自愈与 200ms 域 B 快路径校验，再拉起 Omni
    try {
      const { modularResourceService } =
        await import('../runtime-services/system/modular-resource-service')
      modularResourceService.reconcileBuiltinModuleBindingsSync()
      await modularResourceService.reconcileOnStartup()
      const fastReadyResult = await modularResourceService.runFastReadyBarrier(200)
      logger.info(
        LogCategory.MAIN,
        `[ModularResource] 启动期绑定对账与快路径校验完成 (root=${fastReadyResult.rootStatus}, timedOut=${fastReadyResult.timedOut})`
      )
    } catch (modInitErr) {
      logger.error(
        LogCategory.MAIN,
        '[ModularResource] 启动期数据库或插件对账发生致命异常，中止 Omni 拉起:',
        modInitErr
      )
      throw modInitErr
    }

    // 初始化常驻微服务 (Omni 原生微服务) —— 必须在对账与快路径校验之后启动
    const { omniService } = await import('../runtime-services/system/omni-service')
    await omniService.start().catch(err => {
      logger.error(LogCategory.MAIN, '[OmniService] 原生微服务启动失败:', err)
    })
    mark('omni:ready')
    // 延迟绑定 ConfigDbManager Push/Pull 双通道自愈（不阻塞启动关键路径）
    void registerConfigDbTaxonomySelfHeal()

    logger.debug(LogCategory.MAIN, '正在初始化核心引擎...')
    try {
      const adapters = await createCoreEngineAdapters()
      const resourcesPath = ResourceLocator.getBaseResourceDir()

      const rendererConfig = ConfigOrchestrator.getInstance().getConfig()
      const defaultLanguage = (rendererConfig.language ||
        ConfigOrchestrator.getInstance().getValue<LanguageCode>('DEFAULT_LANGUAGE') ||
        'zh-CN') as LanguageCode
      const queueConcurrency =
        ConfigOrchestrator.getInstance().getValue<number>('QUEUE_MAX_CONCURRENCY') ?? 3
      const queueBatchSize =
        ConfigOrchestrator.getInstance().getValue<number>('QUEUE_BATCH_SIZE') ?? 10
      const aiTemperature =
        ConfigOrchestrator.getInstance().getValue<number>('MODEL_TEMPERATURE') ?? 0.2
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

    logger.debug(LogCategory.MAIN, '正在初始化文件监听服务...')
    try {
      await fileWatcherService.initialize()
      logger.debug(LogCategory.MAIN, '文件监听服务初始化成功')
    } catch (error) {
      logger.error(LogCategory.MAIN, '文件监听服务初始化失败:', error)
    }

    logger.debug(LogCategory.MAIN, '正在初始化分析队列服务...')
    try {
      await analysisQueueService.initialize()
      logger.debug(LogCategory.MAIN, '分析队列服务初始化成功')
    } catch (error) {
      logger.error(LogCategory.MAIN, '[analysis-queue] 分析队列服务初始化失败:', error)
    }

    // 应用启动时，若用户是 Pro/VIP 会员，自动唤醒待续作长视频 (ISS-66)
    try {
      const tierData = userTierService.getCachedData()
      if (tierData?.tier && tierData.tier !== UserTier.FREE) {
        analysisQueueService.requeueIncompleteVideos().catch(err => {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            '[analysis-queue] 启动时唤醒待续作长视频失败:',
            err
          )
        })
      }
    } catch {}

    // 队列初始化完成后，若存在待办任务且处于可用模式，自动启动分析队列循环
    try {
      const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
      if (mode !== 'disabled' && analysisQueueService.hasPendingItems()) {
        logger.info(LogCategory.MAIN, '[analysis-queue] 检测到待办任务，自动启动分析队列循环')
        void analysisQueueService.start()
      }
    } catch (err) {
      logger.warn(LogCategory.MAIN, '[analysis-queue] 自动启动分析队列失败:', err)
    }

    registerServiceHealthChecks()
    const orchestrator = ConfigOrchestrator.getInstance()

    // 启动 AI Skill API 协调器 (由全局配置 ENABLE_AI_SKILL_API 与设置页驱动)
    try {
      const { aiSkillApiReconciler } =
        await import('../runtime-services/system/ai-skill-reconciler')
      const { aiSkillApiService } = await import('../runtime-services/ai-skill-api-service')
      const initialEnabled = Boolean(orchestrator.getValue<boolean>('ENABLE_AI_SKILL_API') ?? false)
      await aiSkillApiReconciler.initialize(initialEnabled)

      orchestrator.onValueChange<boolean>('ENABLE_AI_SKILL_API', enabled => {
        aiSkillApiReconciler.setDesired(Boolean(enabled)).catch(err => {
          logger.warn(LogCategory.SYSTEM, '[AISkillApiReconciler] setDesired 失败:', err)
        })
      })

      app.once('before-quit', async () => {
        try {
          await Promise.race([
            aiSkillApiReconciler.shutdown(),
            new Promise(resolve => setTimeout(resolve, 2500))
          ])
        } catch (stopErr) {
          logger.warn(LogCategory.SYSTEM, '[AISkillApiReconciler] before-quit 停止失败:', stopErr)
        }
      })

      process.on('exit', () => {
        try {
          aiSkillApiService.syncCleanupOnExit()
        } catch {}
      })
    } catch (skillErr) {
      logger.warn(LogCategory.SYSTEM, '[AISkillApiReconciler] 初始化启动失败:', skillErr)
    }

    logger.info(LogCategory.MAIN, '初始化阶段完成，所有服务已初始化')
    logger.debug(LogCategory.MAIN, '开始同步云端配置...')

    // 挂载自动更新服务 (支持双轨寻路与探针快速故障转移)
    try {
      const { autoUpdateService } = await import('../runtime-services/system/auto-update-service')
      autoUpdateService.initialize()
      logger.debug(LogCategory.MAIN, '[AutoUpdate] 自动更新服务初始化成功')
    } catch (updateErr: any) {
      logger.warn(LogCategory.MAIN, '[AutoUpdate] 自动更新服务初始化失败:', updateErr.message)
    }

    // 启动期安全清理废弃旧临时文件 + 差分基线播种（P0-2 / P0-3 · 工单 06）
    // 修正 F-3 盘符与目录名错配：electron-updater 真实缓存根为
    //   %LOCALAPPDATA%\<updaterCacheDirName>  （getAppCacheDir → LOCALAPPDATA）
    //   updaterCacheDirName = firefly-ai-folder_v4_<cn|intl>-updater（app-update.yml 单一事实源）
    // 旧代码清理的是 %APPDATA%(Roaming) userData 下的 `<app.getName()>-updater`
    //   = firefly-ai-folder-updater → 盘符(Roaming≠Local) + 目录名(缺 _v4_<region>) 双重错配，清错目录。
    try {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      const region = resolveAppRegion() // 'cn' | 'intl'
      const updaterCacheDir = computeUpdaterCacheDir(localAppData, region)

      if (fs.existsSync(updaterCacheDir)) {
        const files = fs.readdirSync(updaterCacheDir)
        for (const f of files) {
          // 版本感知剪枝（P0-3）：仅清理明确过期的临时文件
          //   永久保留 installer.exe（差分基线，cacheDir 根）与 pending 目录（已下载新版包）
          const isTemp =
            (f.startsWith('temp-') || f.endsWith('.tmp')) &&
            f !== 'installer.exe' &&
            f !== 'pending'
          if (isTemp) {
            try {
              fs.unlinkSync(path.join(updaterCacheDir, f))
            } catch (unlinkErr: any) {
              // 严禁静默降级：单文件清理失败显式上报，不阻断启动
              logger.warn(
                LogCategory.MAIN,
                '[Initialization] 清理更新临时文件失败:',
                unlinkErr?.message
              )
            }
          }
        }
      }

      // 差分基线播种（P0-2 · A1 裁决 B 路径）：把已安装版本的安装包副本
      // 复制为 <cacheDir>\installer.exe，使 electron-updater 差分引擎能命中基线、避免退化全量。
      // 任何失败均由 seeder 内部 logger.warn 显式上报后返回，不阻断启动。
      await seedBaselineInstaller({
        currentVersion: app.getVersion(),
        localAppDataDir: localAppData,
        programDataDir: process.env.PROGRAMDATA || path.join(localAppData, '..'),
        installDir: path.dirname(app.getPath('exe')),
        region
      })
    } catch (cleanupErr: any) {
      // 严禁静默降级：清理/播种编排整体失败显式上报（AGENTS.md 系统不变量 3）
      logger.warn(
        LogCategory.MAIN,
        '[Initialization] 启动期更新缓存清理/基线播种失败:',
        cleanupErr?.message
      )
    }

    logger.info(LogCategory.MAIN, '完整服务初始化完成')
    mark('full:done')
  } catch (error) {
    logger.error(LogCategory.MAIN, '服务初始化失败:', error)
    mark('full:done')
  }
}
