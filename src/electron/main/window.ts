import { BrowserWindow, app } from 'electron'
import { logger, LogCategory, ResourceLocator } from '@firefly/shared'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { pathToFileURL } from 'url'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { trayService } from '../runtime-services/system/tray-service'
import { resolveAppRegion, getWorktreeInfo } from './worktree-env'
import { t } from '@app/languages'

const getSplashHtml = (imagePath: string) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            margin: 0;
            padding: 0;
            background-color: #09090b;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            overflow: hidden;
            -webkit-app-region: drag;
        }
        .bg-image {
            width: 100%;
            height: 100%;
            background-image: url('${imagePath}');
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
        }
    </style>
</head>
<body>
    <div class="bg-image"></div>
</body>
</html>
`

let mainWindowInstance: BrowserWindow | null = null

// ---------------------------------------------------------------------------
// 渲染进程崩溃兜底（白屏自愈）
//
// 背景：主窗口以 show:false 创建、仅由 ready-to-show 触发显示，且此前全仓库没有任何
// render-process-gone / did-fail-load / unresponsive 监听。一旦渲染进程被系统回收
// （内存压力、GPU 驱动崩溃）或页面加载失败，用户看到的就是一个永久纯白窗口：
// 没有日志、没有提示、无法自愈，线上只能靠用户口述"白屏"来排查。
//
// 本兜底把"静默白屏"变成三件事：
//   1. 落盘完整现场（reason / exitCode / 主进程内存 / 系统可用内存）
//   2. 有限次自动重载（10 分钟窗口内最多 3 次，避免崩溃-重载死循环）
//   3. 重载耗尽后切换到可读的兜底页，引导用户重启应用并上报
// ---------------------------------------------------------------------------

/** 10 分钟内允许的最大自动重载次数 */
const CRASH_RELOAD_MAX = 3
/** 自动重载的统计窗口（毫秒） */
const CRASH_RELOAD_WINDOW_MS = 10 * 60 * 1000
/**
 * 页面加载完成后需要「存活」多久才算真正恢复，才允许清零自愈额度。
 *
 * 不能一 did-finish-load 就清零：加载成功 ≠ 页面稳定。渲染进程如果是在
 * 「加载完成 → 几秒后崩溃」的模式下反复出问题（典型如首屏渲染时 GPU 进程崩溃、
 * 大图/TIF 解码打爆内存），无条件清零会让 CRASH_RELOAD_MAX 永远到不了，
 * 退化成「每 N 秒静默重载一次、永不收敛」—— 正是本兜底要消灭的形态。
 */
const STABILITY_RESET_MS = 60 * 1000

let childProcessGoneHooked = false

/**
 * 全局子进程崩溃监听（GPU 进程 / Utility 进程）。
 * 这些进程崩溃不会触发 render-process-gone，但同样是白屏与花屏的常见源头。
 */
const hookChildProcessGoneOnce = () => {
  if (childProcessGoneHooked) return
  childProcessGoneHooked = true
  app.on('child-process-gone', (_event, details) => {
    logger.error(
      LogCategory.MAIN,
      `[CrashGuard] 子进程异常退出: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`
    )
  })
}

/**
 * 最小 HTML 文本转义。
 * 兜底页会把 reason / url 直接拼进 HTML 与内联事件，不转义就可能截断属性甚至注入。
 */
const escapeHtml = (raw: string): string =>
  raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * 构造崩溃兜底页（纯静态，不依赖渲染进程任何资源）
 * @param reason 崩溃原因（展示给用户，便于上报）
 * @param reloadUrl 崩溃前最后一次正常页面地址。兜底页本身已被导航到 data: URL，
 *   此时 `location.reload()` 只会重新加载这张 data 页、永远回不到应用，
 *   因此必须显式带上原地址，按钮才能真正重试。
 */
const buildCrashFallbackHtml = (reason: string, reloadUrl?: string): string => {
  const title = t('界面出现异常')
  const desc = t('界面渲染进程已退出，应用未能自动恢复。请重启应用后重试。')
  const detailLabel = t('异常原因')
  // JSON.stringify 负责引号与反斜杠转义，但不会转义单引号；而属性用的是单引号包裹，
  // 因此必须再把 ' 转成实体，否则 URL 里的撇号会提前闭合属性。
  const reloadLiteral = reloadUrl
    ? JSON.stringify(reloadUrl).replace(/</g, '\\u003c').replace(/'/g, '&#39;')
    : ''
  const reloadButton = reloadLiteral
    ? `<div><button onclick='location.replace(${reloadLiteral})'>${t('重新加载')}</button></div>`
    : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      display: flex; align-items: center; justify-content: center;
      background: #09090b; color: #e4e4e7;
      font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
      /* 允许选中：用户需要能复制「异常原因」原文反馈问题 */
      -webkit-user-select: text;
      user-select: text;
    }
    .card { max-width: 520px; padding: 40px; text-align: center; }
    .icon { font-size: 44px; line-height: 1; margin-bottom: 18px; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
    p { font-size: 14px; line-height: 1.7; color: #a1a1aa; margin: 0 0 8px; }
    code {
      display: inline-block; margin-top: 14px; padding: 6px 12px;
      font-size: 12px; color: #71717a; background: #18181b;
      border: 1px solid #27272a; border-radius: 6px;
    }
    button {
      margin-top: 26px; padding: 10px 26px; font-size: 14px; cursor: pointer;
      color: #fff; background: #0284c7; border: 0; border-radius: 6px;
    }
    button:hover { background: #0369a1; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${title}</h1>
    <p>${desc}</p>
    <code>${escapeHtml(detailLabel)}: ${escapeHtml(reason)}</code>
    ${reloadButton}
  </div>
</body>
</html>`
}

/**
 * 为指定窗口安装渲染进程崩溃兜底。
 * @param win 目标窗口
 * @param label 日志标识（如 main / preview / queue）
 */
const installRendererCrashGuards = (win: BrowserWindow, label: string): void => {
  hookChildProcessGoneOnce()

  const wc = win.webContents
  let reloadCount = 0
  let windowStartAt = Date.now()
  /** 兜底页是否已展示：兜底页自身崩溃时不允许再自愈，否则会形成紧密的重载循环 */
  let fallbackShown = false
  /** 崩溃前最后一次正常页面地址，用于兜底页「重新加载」按钮 */
  let lastGoodUrl = ''
  /** 稳定性计时器：页面加载成功后启动，存活够久才清零自愈额度 */
  let stabilityTimer: NodeJS.Timeout | null = null

  const clearStabilityTimer = () => {
    if (stabilityTimer) {
      clearTimeout(stabilityTimer)
      stabilityTimer = null
    }
  }

  /** 窗口销毁时清理定时器，避免定时器持有已销毁的 webContents 引用 */
  win.on('closed', clearStabilityTimer)

  const showFallback = (reason: string) => {
    if (fallbackShown) return
    if (win.isDestroyed() || wc.isDestroyed()) return
    fallbackShown = true
    const html = buildCrashFallbackHtml(reason, lastGoodUrl)
    wc.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`).catch(err => {
      logger.error(LogCategory.MAIN, `[CrashGuard] ${label} 兜底页加载失败:`, err)
    })
  }

  const tryRecover = (reason: string) => {
    // 兜底页已经是最后一道防线：它自己再崩就只剩重启应用一条路，
    // 此时若继续 loadURL 兜底页，会变成「崩溃→加载→崩溃」的无限循环。
    if (fallbackShown) {
      logger.error(
        LogCategory.MAIN,
        `[CrashGuard] ${label} 兜底页仍异常（${reason}），已停止自愈，请重启应用`
      )
      return
    }

    // 每次进入自愈流程都取消稳定性计时：页面还没稳够就再次崩溃，额度必须继续累计
    clearStabilityTimer()

    const now = Date.now()
    if (now - windowStartAt > CRASH_RELOAD_WINDOW_MS) {
      windowStartAt = now
      reloadCount = 0
    }
    if (reloadCount >= CRASH_RELOAD_MAX) {
      logger.error(
        LogCategory.MAIN,
        `[CrashGuard] ${label} 在 ${Math.round(CRASH_RELOAD_WINDOW_MS / 60000)} 分钟内已自动重载 ${CRASH_RELOAD_MAX} 次仍异常，切换兜底页（原因: ${reason}）`
      )
      showFallback(reason)
      return
    }
    reloadCount += 1
    const delay = 500 * reloadCount
    logger.warn(
      LogCategory.MAIN,
      `[CrashGuard] ${label} 界面异常（${reason}），${delay}ms 后自动重载（第 ${reloadCount}/${CRASH_RELOAD_MAX} 次）`
    )
    setTimeout(() => {
      if (win.isDestroyed() || wc.isDestroyed()) return
      // 记录重载前的地址：data: 页面不能作为重试目标，只有真实应用页面才有意义
      const currentUrl = wc.getURL()
      if (currentUrl && !currentUrl.startsWith('data:')) lastGoodUrl = currentUrl
      wc.reload()
    }, delay)
  }

  wc.on('render-process-gone', (_event, details) => {
    // 记录崩溃瞬间的内存现场：渲染进程被系统回收（oom）时，这是唯一可用的判据
    const mem = process.memoryUsage()
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024)
    const rssMb = Math.round(mem.rss / 1024 / 1024)
    const totalMb = Math.round(os.totalmem() / 1024 / 1024)
    const freeMb = Math.round(os.freemem() / 1024 / 1024)
    logger.error(
      LogCategory.MAIN,
      `[CrashGuard] ${label} 渲染进程退出: reason=${details.reason}, exitCode=${details.exitCode}, 主进程RSS=${rssMb}MB(heap=${heapMb}MB), 系统内存=${totalMb - freeMb}/${totalMb}MB`
    )
    // 正常关闭（如用户退出）不触发自愈
    if (details.reason === 'clean-exit') return
    tryRecover(details.reason)
  })

  wc.on('unresponsive', () => {
    // 挂起多为长任务占满主线程；不强制重载（会丢失用户上下文），仅落盘便于与 CPU 曲线对照
    logger.warn(LogCategory.MAIN, `[CrashGuard] ${label} 渲染进程无响应（界面可能冻结）`)
  })

  wc.on('responsive', () => {
    logger.info(LogCategory.MAIN, `[CrashGuard] ${label} 渲染进程已恢复响应`)
  })

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED，属正常导航取消（如页面内跳转），不处理
    if (!isMainFrame || errorCode === -3) return
    logger.error(
      LogCategory.MAIN,
      `[CrashGuard] ${label} 页面加载失败: code=${errorCode}, desc=${errorDescription}, url=${validatedURL}`
    )
    tryRecover(`did-fail-load:${errorCode}`)
  })

  wc.on('preload-error', (_event, preloadPath, error) => {
    // preload 抛错会让 window.electronAPI 整体缺失，界面表现为空白或启动阶段卡死
    logger.error(
      LogCategory.MAIN,
      `[CrashGuard] ${label} preload 脚本执行失败: ${preloadPath}`,
      error
    )
  })

  wc.on('did-finish-load', () => {
    const url = wc.getURL()
    // data: 兜底页不算「恢复」，不能碰任何自愈状态
    if (!url || url.startsWith('data:')) return

    // 只要加载成功的是真实应用页面，就立即复位兜底页开关。
    // 否则用户在兜底页点「重新加载」恢复一次之后，后续再崩溃会因为 fallbackShown
    // 永久为 true 而彻底失去自愈能力 —— 又退回静默白屏。
    if (fallbackShown) {
      logger.info(LogCategory.MAIN, `[CrashGuard] ${label} 已恢复为正常页面，复位兜底页开关`)
    }
    fallbackShown = false

    // 但自愈额度不能立刻清零：加载成功不代表页面稳定。
    // 只有页面存活满 STABILITY_RESET_MS 才认定「真的好了」，此时才把额度还回去。
    clearStabilityTimer()
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null
      if (win.isDestroyed() || wc.isDestroyed()) return
      if (reloadCount > 0) {
        logger.info(
          LogCategory.MAIN,
          `[CrashGuard] ${label} 页面已稳定运行 ${Math.round(STABILITY_RESET_MS / 1000)}s，重置自愈计数`
        )
      }
      reloadCount = 0
      windowStartAt = Date.now()
    }, STABILITY_RESET_MS)
  })
}

export const getMainWindow = (): BrowserWindow | null => {
  if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
    return mainWindowInstance
  }
  return null
}

export const createWindow = () => {
  logger.info(LogCategory.MAIN, '[createWindow] 开始创建主浏览器窗口...')

  const splashWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    skipTaskbar: true,
    backgroundColor: '#09090b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      sandbox: true
    }
  })

  const appRegion = resolveAppRegion()
  const bootImageName = appRegion === 'cn' ? 'boot.jpg' : 'boot_en.jpg'
  const bootImagePath =
    ResourceLocator.resolveAsset(bootImageName) ||
    path.join(ResourceLocator.getBaseResourceDir(), 'assets', bootImageName)

  const bootImageUrl = pathToFileURL(bootImagePath).toString()

  splashWindow.loadURL(
    `data:text/html;charset=UTF-8,${encodeURIComponent(getSplashHtml(bootImageUrl))}`
  )

  splashWindow.once('ready-to-show', () => {
    logger.info(LogCategory.MAIN, `[createWindow] 显示启动画面 (使用 ${bootImageName})`)
    splashWindow.show()
  })

  const envWidth = process.env.WINDOW_WIDTH ? parseInt(process.env.WINDOW_WIDTH, 10) : 1600
  const envHeight = process.env.WINDOW_HEIGHT ? parseInt(process.env.WINDOW_HEIGHT, 10) : 1100

  const width = isNaN(envWidth) ? 1600 : envWidth
  const height = isNaN(envHeight) ? 1100 : envHeight

  const mainWindow = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      sandbox: true,
      additionalArguments: [
        `--is-packaged=${app.isPackaged}`,
        `--app-region=${appRegion}`,
        `--has-peer-data=${getWorktreeInfo()?.hasPeerData ? 'true' : 'false'}`,
        `--peer-region=${getWorktreeInfo()?.peerRegion || (appRegion === 'cn' ? 'intl' : 'cn')}`,
        ...(process.env.IS_INTEGRATION_TEST === 'true' ? ['--integration-test=true'] : [])
      ]
    }
  })

  if (!isNaN(envWidth) && !isNaN(envHeight)) {
    mainWindow.setSize(width, height)
    mainWindow.center()
  }

  logger.info(LogCategory.MAIN, '[createWindow] 主浏览器窗口已创建，并设置为隐藏。')

  // 安装渲染进程崩溃兜底：白屏不再静默，转为「日志 + 自动重载 + 兜底页」
  installRendererCrashGuards(mainWindow, 'main')

  mainWindow.once('ready-to-show', () => {
    logger.info(LogCategory.MAIN, '[createWindow] 渲染进程内容已加载完毕，准备显示窗口。')
    if (!splashWindow.isDestroyed()) {
      splashWindow.destroy()
    }

    if (!isNaN(envWidth) && !isNaN(envHeight)) {
      mainWindow.setSize(width, height)
      mainWindow.center()
    }

    mainWindow.show()
    logger.info(LogCategory.MAIN, `__IS_PROD__: ${__IS_PROD__}`)
    logger.info(LogCategory.MAIN, `[createWindow] 应用窗口尺寸配置: ${width}x${height}`)
    logger.info(
      LogCategory.MAIN,
      `[createWindow] 窗口已显示，最终尺寸: ${mainWindow.getBounds().width}x${mainWindow.getBounds().height}`
    )

    if (process.env.DEVTOOLS === 'true') {
      logger.info(LogCategory.MAIN, '[createWindow] 尝试打开开发者工具...')
      mainWindow.webContents.openDevTools()
      logger.info(LogCategory.MAIN, '[createWindow] 开发者工具已打开。')
    }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isShortcutTriggered = __IS_PROD__
      ? input.key === 'F12' && input.control && input.shift && input.type === 'keyDown'
      : input.key === 'F12' && input.type === 'keyDown'

    if (isShortcutTriggered) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools()
        logger.info(
          LogCategory.MAIN,
          `[DevTools] 开发者工具已关闭 (${__IS_PROD__ ? 'Ctrl+Shift+F12' : 'F12'})`
        )
      } else {
        mainWindow.webContents.openDevTools()
        logger.info(
          LogCategory.MAIN,
          `[DevTools] 开发者工具已打开 (${__IS_PROD__ ? 'Ctrl+Shift+F12' : 'F12'})`
        )
      }
    }

    // ESC 键：即使焦点在 iframe 内也能拦截，通知渲染进程关闭预览
    if (input.key === 'Escape' && input.type === 'keyDown') {
      try {
        mainWindow.webContents.send('preview:force-close')
        // 同时用 executeJavaScript 直接调用，确保即使 send 被拦截也能生效
        mainWindow.webContents.executeJavaScript(
          `window.dispatchEvent(new CustomEvent('preview:force-close'))`
        )
      } catch {
        // 窗口可能已销毁
      }
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    logger.info(
      LogCategory.MAIN,
      `[createWindow] 加载开发服务器URL: ${process.env['ELECTRON_RENDERER_URL']}`
    )
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    logger.info(LogCategory.MAIN, '[createWindow] 开发服务器URL加载完成。')
  } else {
    logger.info(LogCategory.MAIN, '[createWindow] 正在加载生产环境的index.html...')
    const indexHtml = path.join(__dirname, '../renderer/index.html')
    if (fs.existsSync(indexHtml)) {
      logger.info(LogCategory.MAIN, `[createWindow] 找到并加载生产环境index.html: ${indexHtml}`)
      mainWindow.loadURL(pathToFileURL(indexHtml).toString())
      logger.info(LogCategory.MAIN, '[createWindow] 生产环境index.html加载完成。')
    } else {
      logger.error(LogCategory.MAIN, `[createWindow] 生产环境index.html未找到: ${indexHtml}`)
      // 此处若不兜底，窗口会永远停留在 show:false（ready-to-show 不会触发，splash 也不会销毁），
      // 用户看到的就是永久白屏 —— 正是本次要消灭的形态之一。直接载入静态兜底页，
      // 让 ready-to-show 正常触发、窗口可见、原因可读。
      const html = buildCrashFallbackHtml(
        t('应用界面资源缺失（index.html 未找到），无法加载界面。请重新安装或修复安装本应用。')
      )
      mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`).catch(err => {
        logger.error(LogCategory.MAIN, '[createWindow] 界面资源缺失兜底页加载失败:', err)
      })
    }
  }

  // 初始化系统托盘
  trayService.init(mainWindow)

  // 拦截关闭事件实现最小化到托盘
  mainWindow.on('close', event => {
    if (trayService.getIsQuitting()) {
      return
    }

    const closeToTray = ConfigOrchestrator.getInstance().getValue<boolean>('CLOSE_TO_TRAY') ?? true
    if (closeToTray) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindowInstance = mainWindow
  mainWindow.on('closed', () => {
    mainWindowInstance = null
  })

  return mainWindow
}

export const createPreviewWindow = (params: { filePath: string; extension: string }) => {
  logger.info(LogCategory.MAIN, '[createPreviewWindow] 开始创建预览窗口...', params)

  const previewWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 1024,
    minHeight: 768,
    useContentSize: true,
    frame: false, // 保持与主窗口一致的无边框设计
    show: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      sandbox: true,
      additionalArguments: [`--is-packaged=${app.isPackaged}`, `--app-region=${resolveAppRegion()}`]
    }
  })

  const queryParams = new URLSearchParams({
    filePath: params.filePath,
    extension: params.extension
  }).toString()

  installRendererCrashGuards(previewWindow, 'preview')

  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = `${process.env['ELECTRON_RENDERER_URL']}#/preview-window?${queryParams}`
    logger.info(LogCategory.MAIN, `[createPreviewWindow] 加载开发服务器URL: ${url}`)
    previewWindow.loadURL(url)
  } else {
    const indexHtml = path.join(__dirname, '../renderer/index.html')
    const url = `${pathToFileURL(indexHtml).toString()}#/preview-window?${queryParams}`
    logger.info(LogCategory.MAIN, `[createPreviewWindow] 加载生产环境URL: ${url}`)
    previewWindow.loadURL(url)
  }

  previewWindow.once('ready-to-show', () => {
    previewWindow.show()
    if (process.env.DEVTOOLS === 'true') {
      previewWindow.webContents.openDevTools()
    }
  })

  return previewWindow
}

let queueWindowInstance: BrowserWindow | null = null

export const getQueueWindow = (): BrowserWindow | null => {
  if (queueWindowInstance && !queueWindowInstance.isDestroyed()) {
    return queueWindowInstance
  }
  return null
}

export const closeQueueWindow = (): void => {
  if (queueWindowInstance && !queueWindowInstance.isDestroyed()) {
    queueWindowInstance.close()
  }
  queueWindowInstance = null
}

export const createQueueWindow = (): BrowserWindow => {
  logger.info(LogCategory.MAIN, '[createQueueWindow] 开始创建独立分析队列窗口...')

  if (queueWindowInstance && !queueWindowInstance.isDestroyed()) {
    if (queueWindowInstance.isMinimized()) queueWindowInstance.restore()
    queueWindowInstance.show()
    queueWindowInstance.focus()
    return queueWindowInstance
  }

  queueWindowInstance = new BrowserWindow({
    width: 960,
    height: 600,
    minWidth: 650,
    minHeight: 400,
    useContentSize: true,
    frame: false,
    autoHideMenuBar: true,
    show: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      sandbox: true,
      additionalArguments: [`--is-packaged=${app.isPackaged}`, `--app-region=${resolveAppRegion()}`]
    }
  })

  installRendererCrashGuards(queueWindowInstance, 'queue')

  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = `${process.env['ELECTRON_RENDERER_URL']}#/queue-window`
    logger.info(LogCategory.MAIN, `[createQueueWindow] 加载开发服务器URL: ${url}`)
    queueWindowInstance.loadURL(url)
  } else {
    const indexHtml = path.join(__dirname, '../renderer/index.html')
    const url = `${pathToFileURL(indexHtml).toString()}#/queue-window`
    logger.info(LogCategory.MAIN, `[createQueueWindow] 加载生产环境URL: ${url}`)
    queueWindowInstance.loadURL(url)
  }

  queueWindowInstance.once('ready-to-show', () => {
    if (queueWindowInstance && !queueWindowInstance.isDestroyed()) {
      queueWindowInstance.show()
    }
  })

  queueWindowInstance.on('closed', () => {
    queueWindowInstance = null
  })

  return queueWindowInstance
}
