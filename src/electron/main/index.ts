import * as fs from 'node:fs'
import fixPath from 'fix-path'

// 在 macOS 和 Linux 上修复 PATH 环境变量（必须在所有其他逻辑之前执行）
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default
    if (typeof fixPathFunc === 'function') {
      fixPathFunc()
    }
  } catch (e) {
    console.error('Failed to fix PATH in main/index.ts:', e)
  }
}

// 必须放在文件最顶部！
if (process.platform === 'darwin') {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true' // 顺便关闭安全警告（可选）

  // 对应的 Chromium 环境变量
  process.env.CHROMIUM_USER_FLAGS = '--password-store=basic --use-mock-keychain'
}

// 后续逻辑...
import { app, BrowserWindow, ipcMain, net, dialog, shell } from 'electron'
import * as path from 'node:path'

// 执行双应用数据目录隔离与迁移（用于改名 yonuc-ai-folder -> firefly-ai-folder 的无缝升级）
;(() => {
  try {
    const appDataDir = app.getPath('appData')
    const oldDir = path.join(appDataDir, 'yonuc-ai-folder')
    // 新目录使用 app.getPath('userData') 获取的实际路径（打包后含 region 后缀）
    const newDir = app.getPath('userData')

    // 检查旧目录是否存在数据库文件（模糊匹配 *.db）
    const hasOldDb =
      fs.existsSync(oldDir) &&
      fs
        .readdirSync(oldDir)
        .some(f => f.endsWith('.db') && !f.includes('-shm') && !f.includes('-wal'))

    // 检查新目录是否存在数据库文件
    const hasNewDb =
      fs.existsSync(newDir) &&
      fs
        .readdirSync(newDir)
        .some(f => f.endsWith('.db') && !f.includes('-shm') && !f.includes('-wal'))

    console.log(`[Migration] 旧数据库存在: ${hasOldDb}, 新数据库存在: ${hasNewDb}`)

    // 如果旧数据库存在，新数据库不存在，则执行迁移
    if (hasOldDb && !hasNewDb) {
      console.log('[Migration] 开始执行迁移...')

      // 1. 确保新数据目录存在
      if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true })
      }

      // 2. 复制配置文件与数据库相关文件（秒级完成）
      const files = fs.readdirSync(oldDir)
      console.log(`[Migration] 旧目录文件列表: ${files.join(', ')}`)
      for (const file of files) {
        // 白名单过滤：只拷贝这两个配置文件以及数据库相关文件 (*.db, *.db-shm, *.db-wal 等)
        const isConfigFile =
          file === 'yonuc-ai-folder-config.json' || file === 'yonuc-unified-config.json'
        const isDatabaseFile = file.includes('.db')
        if (!isConfigFile && !isDatabaseFile) continue

        const oldFilePath = path.join(oldDir, file)

        // 如果文件名中包含旧的品牌名，将其更名为新品牌名
        const newFileName = file.replace(/yonuc/g, 'firefly')
        const newFilePath = path.join(newDir, newFileName)

        try {
          const stat = fs.statSync(oldFilePath)
          if (stat.isFile()) {
            fs.copyFileSync(oldFilePath, newFilePath)
            console.log(`[Migration] 成功复制并更名: ${file} -> ${newFileName}`)

            // 3. 修改 firefly-unified-config.json 中的版本号 VERSION 为当前软件版本号
            if (newFileName === 'firefly-unified-config.json') {
              try {
                const content = fs.readFileSync(newFilePath, 'utf-8')
                const configObj = JSON.parse(content)
                if (configObj && configObj.app) {
                  const currentVersion = app.getVersion()
                  configObj.app.VERSION = currentVersion
                  fs.writeFileSync(newFilePath, JSON.stringify(configObj, null, 2), 'utf-8')
                  console.log(
                    `[Migration] 已成功将 firefly-unified-config.json 中的 VERSION 更新为 ${currentVersion}`
                  )
                }
              } catch (innerErr) {
                console.error('[Migration] 修改版本号失败:', innerErr)
              }
            }
          }
        } catch (e) {
          console.error(`[Migration] 复制文件 ${file} 失败:`, e)
        }
      }
      console.log('[Migration] 双应用数据隔离与继承迁移完成')
      // 验证迁移结果
      const newFiles = fs.readdirSync(newDir)
      console.log(`[Migration] 新目录文件列表: ${newFiles.join(', ')}`)
    } else {
      console.log('[Migration] 跳过迁移: 旧数据库不存在或新数据库已存在')
    }
  } catch (err) {
    console.error('[Migration] 初始化新版数据目录失败:', err)
  }
})()

import { logger, LogCategory, ErrorNormalizer } from '@firefly/shared'

// 为不同平台或命令行指定的参数设置远程调试端口，避免冲突
const debuggingPortArg = process.argv.find(arg => arg.includes('--remote-debugging-port'))
if (debuggingPortArg) {
  const portMatch = debuggingPortArg.match(/--remote-debugging-port=(\d+)/)
  if (portMatch && portMatch[1]) {
    app.commandLine.appendSwitch('remote-debugging-port', portMatch[1])
  }
} else if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  const debugPort =
    process.platform === 'win32' ? '9222' : process.platform === 'darwin' ? '9223' : '9224' // Linux
  app.commandLine.appendSwitch('remote-debugging-port', debugPort)
}

// 检测代理环境变量并配置 Electron Chromium 网络栈
// Electron 的 net.request/net.fetch 使用 Chromium 网络栈，不读取 HTTP_PROXY/HTTPS_PROXY 环境变量
// 需要通过命令行开关 --proxy-server 显式配置
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy
const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy
const proxyRules = httpsProxy || httpProxy
if (proxyRules && !process.argv.some(arg => arg.includes('--proxy-server'))) {
  app.commandLine.appendSwitch('proxy-server', proxyRules)
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || ''
  if (noProxy) {
    app.commandLine.appendSwitch('proxy-bypass-rules', noProxy)
  }
  console.log(`[native-network] 已通过命令行开关配置 Chromium 代理: ${proxyRules}`)
}

// 为 Node.js 环境提供 DOMMatrix 全局变量
if (typeof (globalThis as any).DOMMatrix === 'undefined') {
  ;(globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1
    b = 0
    c = 0
    d = 1
    e = 0
    f = 0
    m11 = 1
    m12 = 0
    m13 = 0
    m14 = 0
    m21 = 0
    m22 = 1
    m23 = 0
    m24 = 0
    m31 = 0
    m32 = 0
    m33 = 1
    m34 = 0
    m41 = 0
    m42 = 0
    m43 = 0
    m44 = 1
    constructor(init?: string | number[]) {}
    static fromMatrix(other?: DOMMatrix | DOMMatrixInit): DOMMatrix {
      return new DOMMatrix()
    }
    static fromFloat32Array(array32: Float32Array): DOMMatrix {
      return new DOMMatrix()
    }
    static fromFloat64Array(array64: Float64Array): DOMMatrix {
      return new DOMMatrix()
    }
    multiply(other: DOMMatrix): DOMMatrix {
      return this
    }
    multiplySelf(other: DOMMatrix): DOMMatrix {
      return this
    }
    preMultiplySelf(other: DOMMatrix): DOMMatrix {
      return this
    }
    translate(tx: number, ty: number, tz?: number): DOMMatrix {
      return this
    }
    translateSelf(tx: number, ty: number, tz?: number): DOMMatrix {
      return this
    }
    scale(scale: number, originX?: number, originY?: number): DOMMatrix {
      return this
    }
    scaleSelf(scale: number, originX?: number, originY?: number): DOMMatrix {
      return this
    }
    rotate(angle: number, originX?: number, originY?: number): DOMMatrix {
      return this
    }
    rotateSelf(angle: number, originX?: number, originY?: number): DOMMatrix {
      return this
    }
    rotateFromVector(x: number, y: number): DOMMatrix {
      return this
    }
    rotateFromVectorSelf(x: number, y: number): DOMMatrix {
      return this
    }
    skewX(sx: number): DOMMatrix {
      return this
    }
    skewXSelf(sx: number): DOMMatrix {
      return this
    }
    skewY(sy: number): DOMMatrix {
      return this
    }
    skewYSelf(sy: number): DOMMatrix {
      return this
    }
    invertSelf(): DOMMatrix {
      return this
    }
    inverse(): DOMMatrix {
      return this
    }
    transformPoint(point?: DOMPointInit): any {
      return { x: 0, y: 0, z: 0, w: 1 }
    }
    toFloat32Array(): Float32Array {
      return new Float32Array(16)
    }
    toFloat64Array(): Float64Array {
      return new Float64Array(16)
    }
    toString(): string {
      return ''
    }
  }
}

import { databaseService } from '../runtime-services/database/database-service'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import {
  ConfigOrchestrator as AIPackageConfigOrchestrator,
  LlamaIndexAIService
} from '@firefly/electron-llamaIndex-service'
import { loggingService } from '../runtime-services/system/logging-service'
import { systemHealthService } from '../runtime-services/system/system-health-service'
import { fileWatcherService } from '../runtime-services/filesystem/file-watcher-service'
import { analysisQueueService } from '../runtime-services/analysis-queue-service'
import { SystemIdentityService } from '../runtime-services/system/system-identity-service'
import { LicenseService, LicenseStatus } from '../runtime-services/system/license-service'
import { regionDetectionService } from '../runtime-services/system/region-detection-service'
import { postHogMain } from '../services/posthog-service'
import { AIEngineFactory } from '../runtime-services/ai/adapters/ai-engine-factory'
import { llamaModelManager } from '../runtime-services/llama/llama-model-manager'
import { omniService } from '../runtime-services/system/omni-service'
import { hardwareDetectionService } from '../runtime-services/system/hardware-detection-service'
import { deploymentIntegrityVerifier } from '../runtime-services/llama/deployment-integrity-verifier'

// Import local main modules
import {
  initializeMinimalServices,
  initializeFullServices,
  initializeHardwareDetection,
  initializeLlamaServer,
  initDatabaseAndDependentServices
} from './initialization'
import { createWindow } from './window'
import { trayService } from '../runtime-services/system/tray-service'
import { setupIPCHandlers } from './ipc-handlers'
import { t } from '@app/languages'
import {
  earlyInitializationPromise,
  setEarlyInitializationPromise,
  globalLlamaIndexService,
  setActiveHardwareBackendCache
} from './state'
import { ConfigDbManager } from '../runtime-services/config/config-db-manager'
import { LanguageCode } from '@firefly/types'

// =================================================================
// 日志处理逻辑 (含 IPC 节流)
// =================================================================
let logBatch: any[] = []
let logThrottleTimer: NodeJS.Timeout | null = null

const flushLogs = () => {
  if (logBatch.length === 0) return

  const currentBatch = [...logBatch]
  logBatch = []
  logThrottleTimer = null

  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('system:log-forward-batch', currentBatch)
    }
  })
}

logger.on(
  'log',
  ({ category, level, args }: { category: LogCategory; level: string; args: any[] }) => {
    // 将所有 args 合并为一条完整消息，对象格式化为带换行缩进的 JSON
    let foundStack: string | undefined
    const parts: string[] = []
    let extractedData: any = undefined

    for (const arg of args) {
      if (typeof arg === 'object' && arg !== null) {
        if (arg instanceof Error) {
          foundStack = arg.stack
          parts.push(`${arg.name}: ${arg.message}`)
        } else if (arg instanceof Date) {
          parts.push(arg.toISOString())
        } else {
          const prettyJson = JSON.stringify(arg, null, 2)
          const beautifiedJson = prettyJson
            .split('\n')
            .map(line => {
              const indentMatch = line.match(/^(\s*)/)
              const indent = indentMatch ? indentMatch[1] : ''
              if (line.includes('\\n')) {
                return line.replace(/\\n/g, '\n' + indent + '  ')
              }
              return line
            })
            .join('\n')
          parts.push(beautifiedJson)
          if (extractedData === undefined) {
            extractedData = arg
          }
        }
      } else {
        parts.push(String(arg))
      }
    }

    const message = parts.join(' ')

    if (category === LogCategory.HTTP_CLIENT) {
      if (level === 'debug') return
      if (level === 'info') {
        const upperMsg = message.toUpperCase()
        if (upperMsg.includes('[DEBUG]') || upperMsg.includes('[INFO]')) return
      }
    }

    if (category === LogCategory.ANALYSIS_QUEUE) {
      if ((level === 'debug' || level === 'info') && message.includes('发送状态更新')) return
    }

    switch (level) {
      case 'info':
        loggingService.info(category, message)
        break
      case 'warn':
        loggingService.warn(category, message)
        break
      case 'error':
        if (category === LogCategory.ERROR) return
        loggingService.error(category, message, undefined, foundStack)
        break
      case 'debug':
        loggingService.debug(category, message)
        break
      default:
        loggingService.info(category, message)
    }

    if (category !== LogCategory.RENDERER) {
      logBatch.push({
        category,
        level,
        message,
        data: extractedData,
        origin: 'backend',
        timestamp: Date.now()
      })

      if (logBatch.length >= 100) {
        if (logThrottleTimer) {
          clearTimeout(logThrottleTimer)
          logThrottleTimer = null
        }
        flushLogs()
      } else if (!logThrottleTimer) {
        logThrottleTimer = setTimeout(flushLogs, 100)
      }
    }
  }
)

// =================================================================
// 早期服务初始化
// =================================================================
setEarlyInitializationPromise(
  (async () => {
    try {
      await SystemIdentityService.getInstance().initialize()
      // PostHog 客户端已在模块加载时创建（临时标识），此处更新为真实机器 ID 并检查授权
      await postHogMain.init()
      logger.info(LogCategory.MAIN, '[App] 身份系统与追踪服务早期初始化完成')
    } catch (err) {
      console.error('Early service initialization background task failed:', err)
    }
  })()
)

// =================================================================
// 核心监听器
// =================================================================

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  logger.error(LogCategory.ERROR, `证书错误: ${error} URL: ${url}`)
  loggingService.error(LogCategory.ERROR, '证书验证失败', {
    url,
    error,
    certificateIssuer: certificate.issuer,
    certificateSubject: certificate.subject
  })
  event.preventDefault()
  callback(false)
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('ssl-certificate-error', { url, error })
  })
})

ConfigOrchestrator.getInstance().on('unified-change', async newConfig => {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('config:change', newConfig)
  })
})

ConfigOrchestrator.getInstance().onValueChange<boolean>('LANGUAGE_CONFIRMED', async confirmed => {
  if (confirmed && !databaseService.db) {
    const language = (ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') ||
      'zh-CN') as LanguageCode
    logger.info(
      LogCategory.MAIN,
      `用户已在欢迎界面确认语言 (${language})，开始建立并初始化数据库...`
    )
    try {
      await initDatabaseAndDependentServices(language, true)
      await analysisQueueService.reloadDatabase()
      BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('database-switched', { language })
      })
    } catch (error) {
      logger.error(LogCategory.MAIN, '建立数据库失败:', error)
    }
  }
})

ConfigOrchestrator.getInstance().onValueChange<string>(
  'DEFAULT_LANGUAGE',
  async (newLanguage, oldLanguage) => {
    const isLanguageConfirmed =
      ConfigOrchestrator.getInstance().getValue<boolean>('LANGUAGE_CONFIRMED')
    if (!isLanguageConfirmed) {
      logger.info(
        LogCategory.MAIN,
        `语言暂未确认 (LANGUAGE_CONFIRMED = false)，跳过自动创建/切换数据库 (${newLanguage})`
      )
      return
    }

    if (newLanguage !== oldLanguage) {
      logger.info(
        LogCategory.MAIN,
        `语言由 ${oldLanguage} 切换为 ${newLanguage}，正在切换数据库...`
      )
      try {
        await initDatabaseAndDependentServices(newLanguage as any, true)
        await analysisQueueService.reloadDatabase()
        // 数据库重建后，重新同步 UserTierDataManager
        const { userTierService } = await import('../runtime-services/user-tier/user-tier-service')
        const { SystemIdentityService } =
          await import('../runtime-services/system/system-identity-service')
        const machineId = await SystemIdentityService.getInstance().getMachineId()
        userTierService.syncToCache(machineId).catch(err => {
          logger.error(LogCategory.MAIN, '语言切换后同步失败:', err)
        })
        // 重新同步云端对应语言的配置
        ConfigDbManager.getInstance()
          .syncFromCloud()
          .catch(err => {
            logger.error(LogCategory.MAIN, '语言切换后同步云端配置失败:', err)
          })

        BrowserWindow.getAllWindows().forEach(win => {
          win.webContents.send('database-switched', { language: newLanguage })
        })
      } catch (error) {
        logger.error(LogCategory.MAIN, '切换数据库失败:', error)
      }
    }
  }
)

ConfigOrchestrator.getInstance().onValueChange<string>(
  'MODEL_STORAGE_PATH',
  async (newPath, oldPath) => {
    if (newPath !== oldPath) {
      logger.info(
        LogCategory.MAIN,
        `模型存储路径由 ${oldPath} 切换为 ${newPath}，正在刷新模型管理器...`
      )
      try {
        llamaModelManager.refreshBaseDirectory()
        const resources = await hardwareDetectionService.detectSystemResources(true)
        ConfigOrchestrator.getInstance().updateValues({ HARDWARE_STORAGE_INFO: resources.storage })
        if (globalLlamaIndexService) {
          await globalLlamaIndexService.reloadConfig().catch(err => {
            logger.warn(LogCategory.MAIN, 'AI 服务重新加载配置失败:', err.message)
          })
        }
      } catch (error) {
        logger.error(LogCategory.MAIN, '刷新模型路径相关服务失败:', error)
      }
    }
  }
)

ConfigOrchestrator.getInstance().onValueChange<string>(
  'AI_ENGINE',
  async (newEngine, oldEngine) => {
    if (newEngine !== oldEngine) {
      logger.info(
        LogCategory.MAIN,
        `AI 引擎由 ${oldEngine} 切换为 ${newEngine}，正在刷新硬件信息...`
      )
      try {
        const resources = await hardwareDetectionService.detectSystemResources(true)
        ConfigOrchestrator.getInstance().updateValues({ HARDWARE_STORAGE_INFO: resources.storage })
      } catch (error) {
        logger.error(LogCategory.MAIN, '刷新 AI 引擎相关硬件信息失败:', error)
      }
    }
  }
)

ConfigOrchestrator.getInstance().onValueChange('HARDWARE_GPU_INFO', () => {
  setActiveHardwareBackendCache(null)
})

ConfigOrchestrator.getInstance().onValueChange<boolean>(
  'AI_ENGINE_FORCE_CPU_MODE',
  async (newValue, oldValue) => {
    if (newValue !== oldValue) {
      // 清除硬件加速后端描述缓存，避免 Footer 引擎标识继续显示旧的 GPU 后端（如 cuda）
      setActiveHardwareBackendCache(null)
      logger.info(
        LogCategory.MAIN,
        `强制 CPU 模式由 ${oldValue} 切换为 ${newValue}，正在重启 AI 服务...`
      )
      try {
        if (globalLlamaIndexService) {
          await globalLlamaIndexService.reloadConfig().catch(err => {
            logger.warn(LogCategory.MAIN, 'AI 服务重新加载配置失败:', err.message)
          })
        }
      } catch (error) {
        logger.error(LogCategory.MAIN, '重启 AI 服务失败:', error)
      }
    }
  }
)

// =================================================================
// 应用启动入口
// =================================================================

app.on('ready', async () => {
  // 关键：在注册 IPC 处理器之前注入包内 ConfigOrchestrator，
  // 避免 setupIPCHandlers 中 AIEngineFactory.getAdapter() 等早期调用触发
  // "ConfigOrchestrator has not been injected in AI package" 错误（日志已确认）
  AIPackageConfigOrchestrator.setInstance(ConfigOrchestrator.getInstance())

  // 关键：在注册 IPC 处理器与创建窗口之前注入硬件探测服务的依赖
  // (ConfigOrchestrator, deploymentIntegrityVerifier)。
  // 首次安装/升级模式下窗口会提前创建，欢迎向导、授权在线确认等早期流程
  // 会触发硬件探测与 fastfetch 完整性校验；若此时依赖未注入，
  // 完整性校验会被跳过并记录 "deploymentIntegrityVerifier 未注入" 日志。
  hardwareDetectionService.setConfigOrchestrator(ConfigOrchestrator.getInstance())
  hardwareDetectionService.setDeploymentIntegrityVerifier(deploymentIntegrityVerifier)

  // 注册 IPC 处理器，确保在任何窗口创建及前端加载之前 IPC 响应就绪
  await setupIPCHandlers()

  const orchestrator = ConfigOrchestrator.getInstance()

  AIEngineFactory.setBuildTimeEngine(__AI_ENGINE__)
  const engineType = AIEngineFactory.getBuildTimeEngineType()

  // 1. 探测启动状态（首次运行或版本升级）
  const isFirstRun = orchestrator.getValue<boolean>('IS_FIRST_RUN')
  const storedVersion = orchestrator.getValue<string>('VERSION')
  const currentVersion = __APP_VERSION__
  const isUpgrade = storedVersion && storedVersion !== currentVersion
  const isInitialSetupNeeded = isFirstRun || isUpgrade

  logger.info(
    LogCategory.MAIN,
    `[App] 启动状态检测: isFirstRun=${isFirstRun}, isUpgrade=${isUpgrade} (Stored: ${storedVersion}, Current: ${currentVersion})`
  )

  // 2. 如果需要初始安装/升级，则优先创建窗口并显示遮罩
  let setupReadyPromise: Promise<void> | null = null
  if (isInitialSetupNeeded) {
    logger.info(LogCategory.MAIN, '[App] 检测到首次运行或版本升级，提前创建窗口以显示安装遮罩')
    setupReadyPromise = new Promise(resolve => {
      ipcMain.once('system:setup-overlay-ready', () => {
        logger.info(LogCategory.MAIN, '[App] 渲染进程安装遮罩已就绪')
        resolve()
      })
      // 设置一个超时备份，防止渲染进程加载失败导致卡死
      setTimeout(resolve, 5000)
    })
    createWindow()
  }

  // 处理安装程序的语言选择
  try {
    const langFilePath = require('node:path').join(
      app.getPath('userData'),
      'installer_language.txt'
    )
    if (fs.existsSync(langFilePath)) {
      const lcid = fs.readFileSync(langFilePath, 'utf-8').trim()

      const lcidMap: Record<string, string> = {
        '1028': 'zh-TW',
        '1033': 'en-US',
        '1041': 'ja-JP',
        '1042': 'ko-KR',
        '1036': 'fr-FR',
        '1031': 'de-DE',
        '1034': 'es-ES',
        '1049': 'ru-RU',
        '2070': 'pt-PT',
        '1025': 'ar-EG',
        '2052': 'zh-CN'
      }

      const langCode = lcidMap[lcid]
      if (langCode) {
        orchestrator.updateValues({ DEFAULT_LANGUAGE: langCode }, { source: 'runtime' })
        logger.info(LogCategory.MAIN, `[App] 从安装程序中读取到语言选择: ${langCode} (${lcid})`)
      }

      // 删除文件，确保只在初次运行时处理一次
      fs.unlinkSync(langFilePath)
    }
  } catch (err) {
    logger.error(LogCategory.MAIN, '[App] 处理安装程序语言文件失败:', err)
  }

  const baseInitPromise = (async () => {
    await earlyInitializationPromise
    logger.info(LogCategory.MAIN, '[App] 身份系统与追踪服务初始化已就绪')
  })()

  const regionDetectPromise = regionDetectionService.detectAndSetMirror().catch(err => {
    logger.error(LogCategory.SYSTEM, '地域探测失败:', err)
  })

  orchestrator.updateValues({ AI_ENGINE: engineType }, { source: 'runtime' })
  orchestrator.updateRendererConfig({ aiEngine: engineType } as any)
  logger.info(LogCategory.MAIN, `[App] 已将 AI 引擎配置注入 ConfigOrchestrator: ${engineType}`)

  try {
    await baseInitPromise
    logger.info(LogCategory.MAIN, '[App] 应用启动，进入配置阶段...')

    // 1. 初始化最小服务（所有环境通用）
    // 如果是初始安装，我们会通过 IPC 发送进度
    const notifyProgress = (status: string, message?: string) => {
      if (isInitialSetupNeeded) {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('system:initial-setup-status', { status, message })
          }
        })
      }
    }

    // 等待渲染进程就绪后再发送第一个进度
    if (setupReadyPromise) {
      await setupReadyPromise
    }

    notifyProgress(
      'preparing',
      isFirstRun
        ? t('正在准备首次启动安装...')
        : t('正在从版本 {oldVersion} 升级到 {newVersion}...', {
            oldVersion: storedVersion,
            newVersion: currentVersion
          })
    )

    await initializeMinimalServices({
      onProgress: msg => notifyProgress('installing_engine', msg)
    })

    if (isInitialSetupNeeded) {
      await orchestrator.updateValues({
        VERSION: currentVersion,
        MIGRATION_VERSION: currentVersion
      })
      notifyProgress('completed')
      logger.info(LogCategory.MAIN, '[App] 初始安装/升级任务已完成')
    }

    // 2. 测试环境下的特殊注入逻辑
    if (process.env.NODE_ENV === 'test') {
      logger.info(LogCategory.MAIN, '[Test] 检测到测试环境，执行全量服务初始化并注入工作目录')
      try {
        await initializeFullServices()
        // 注意：initializeFullServices 内部已调用 globalLlamaIndexService.initialize()
        // 且有独立的 try-catch 处理初始化错误，此处不需要重复调用
        if (globalLlamaIndexService) {
          logger.info(LogCategory.MAIN, '[Test] 服务初始化完成')
        }

        const desktopPath = process.env.TEST_SPEEDY_PATH!
        const collectionPath = process.env.TEST_PRIVATE_PATH!
        await databaseService.addWorkspaceDirectory({
          path: desktopPath,
          name: '桌面',
          type: 'SPEEDY',
          recursive: true,
          isActive: true
        })
        await databaseService.addWorkspaceDirectory({
          path: collectionPath,
          name: '图片',
          type: 'PRIVATE',
          recursive: true,
          isActive: true
        })
        logger.info(LogCategory.MAIN, '[Test] 已成功注入预设工作目录')
      } catch (err) {
        logger.error(LogCategory.MAIN, '[Test] 初始化或注入失败，应用将退出:', err)
        console.error('=== FIREFLY_CRASH: 测试模式初始化失败 ===', err)
        app.exit(1)
        return
      }
    }

    await regionDetectPromise
  } catch (error) {
    logger.error(LogCategory.MAIN, '[App] 最小服务初始化失败:', error)
    console.error('=== FIREFLY_CRASH: 最小服务初始化失败 ===', error)
    app.exit(1)
    return
  }

  try {
    let licenseResult = await LicenseService.getInstance().checkLicenseStatus(true)
    logger.info(LogCategory.MAIN, '[App] 初始授权检查结果:', licenseResult.status)

    if (licenseResult.status !== LicenseStatus.AUTHORIZED) {
      try {
        logger.info(LogCategory.MAIN, '[App] 未检测到授权，尝试执行一次在线同步确认...')
        await initializeHardwareDetection(true)
        licenseResult = await LicenseService.getInstance().checkLicenseStatus(true)
        if (licenseResult.status === LicenseStatus.AUTHORIZED) {
          logger.info(LogCategory.MAIN, '[App] 在线授权确认成功')
          await orchestrator.updateValue('MACHINE_REGISTERED', true)
        }
      } catch (e) {
        logger.warn(LogCategory.MAIN, '[App] 启动阶段在线授权同步尝试失败:', e)
      }
    }

    if (licenseResult.status !== LicenseStatus.AUTHORIZED) {
      logger.warn(LogCategory.MAIN, '★★★ 授权校验未通过，锁定 AI 核心服务初始化 ★★★')
    } else {
      logger.info(LogCategory.MAIN, '[App] 授权校验通过，正在加载 AI 服务模块...')
      await initializeLlamaServer()
      logger.info(LogCategory.MAIN, '[App] AI 服务模块加载完成')
    }
  } catch (error) {
    logger.error(LogCategory.MAIN, '[App] 授权检查过程发生异常:', error)
  }

  if (!isInitialSetupNeeded) {
    logger.info(LogCategory.MAIN, '[App] 准备创建主窗口...')
    createWindow()
    logger.info(LogCategory.MAIN, '[App] 主窗口创建指令已发送。')
  } else {
    logger.info(LogCategory.MAIN, '[App] 初始安装已在早期创建窗口，跳过重复创建')
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    databaseService.close()
    app.quit()
  }
})

app.on('before-quit', async () => {
  trayService.setQuitting(true)
  logger.info(LogCategory.MAIN, '应用正在退出，清理资源...')

  try {
    omniService.stop()
    await fileWatcherService.cleanup()
    await systemHealthService.stop()
    databaseService.close()
    if (LlamaIndexAIService.hasInstance()) {
      const aiService = LlamaIndexAIService.getInstance()
      if (aiService && aiService.isInitialized()) await aiService.stop()
    }
    // 确保 PostHog 挂起事件在退出前全部发送
    await postHogMain.shutdown()
    logger.info(LogCategory.MAIN, '资源清理完成')
  } catch (error) {
    logger.error(LogCategory.MAIN, '资源清理失败:', error)
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

process.on('uncaughtException', err => {
  if ((err as any)?.code === 'EPIPE' || (err as any)?.code === 'ERR_STREAM_DESTROYED' || String(err?.message || '').includes('EPIPE')) {
    return
  }
  logger.error(LogCategory.MAIN, '[uncaughtException]', err)
  try {
    postHogMain.captureException(err, { source: 'uncaughtException' })
  } catch (e) {
    console.error('[uncaughtException] postHogMain.captureException 失败:', e)
  }
})
process.on('unhandledRejection', reason => {
  if ((reason as any)?.code === 'EPIPE' || (reason as any)?.code === 'ERR_STREAM_DESTROYED' || String((reason as any)?.message || '').includes('EPIPE')) {
    return
  }
  logger.error(LogCategory.MAIN, '[unhandledRejection]', reason)
  try {
    postHogMain.captureException(reason, { source: 'unhandledRejection' })
  } catch (e) {
    console.error('[unhandledRejection] postHogMain.captureException 失败:', e)
  }
})

// 处理终端终止信号 (Ctrl+C / 进程管理器杀进程)，确保 omni 等所有常驻子服务彻底释放
const handleProcessTermination = () => {
  try {
    omniService.stop()
  } catch {}
  process.exit(0)
}
process.on('SIGINT', handleProcessTermination)
process.on('SIGTERM', handleProcessTermination)
