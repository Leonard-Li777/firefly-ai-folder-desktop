import { BrowserWindow, app } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import * as path from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { trayService } from '../runtime-services/system/tray-service'

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
      webSecurity: false
    }
  })

  const bootImageName =
    typeof __BUILD_REGION__ !== 'undefined' && __BUILD_REGION__ === 'CN'
      ? 'boot.jpg'
      : 'boot_en.jpg'
  const bootImagePath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', bootImageName)
    : path.join(app.getAppPath(), '../../assets', bootImageName)

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
      sandbox: false,
      additionalArguments: [
        `--is-packaged=${app.isPackaged}`,
        ...(process.env.IS_INTEGRATION_TEST === 'true' ? ['--integration-test=true'] : [])
      ]
    }
  })

  if (!isNaN(envWidth) && !isNaN(envHeight)) {
    mainWindow.setSize(width, height)
    mainWindow.center()
  }

  logger.info(LogCategory.MAIN, '[createWindow] 主浏览器窗口已创建，并设置为隐藏。')

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
      sandbox: false,
      additionalArguments: [`--is-packaged=${app.isPackaged}`]
    }
  })

  const queryParams = new URLSearchParams({
    filePath: params.filePath,
    extension: params.extension
  }).toString()

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
      sandbox: false,
      additionalArguments: [`--is-packaged=${app.isPackaged}`]
    }
  })

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
