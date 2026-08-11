/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/tutorial/process-model
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.ts` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */

import './index.css'
// import './i18n' // 导入i18n配置
import './stores/config-sync'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter as Router } from 'react-router-dom'
import App from './App'

import { ThemeProvider } from './components/ui/theme-provider'
import { LogCategory, logger } from '@firefly/shared'

import { VoerkaI18nProvider } from '@voerkai18n/react'

import { PostHogProvider } from '@posthog/react'
import posthog, { initPostHog } from './lib/posthog'

// 初始化 PostHog
initPostHog()

// 渲染React应用
const container = document.getElementById('root')
if (container) {
  const root = createRoot(container)
  root.render(
    <PostHogProvider client={posthog as any}>
      <Router>
        <VoerkaI18nProvider>
          <ThemeProvider defaultTheme="auto" defaultColorScheme="blue" storageKey="vite-ui-theme">
            <App />
          </ThemeProvider>
        </VoerkaI18nProvider>
      </Router>
    </PostHogProvider>
  )
}

window.addEventListener('error', event => {
  const { message, filename, lineno, colno, error } = event
  const errorInfo = {
    message,
    filename,
    lineno,
    colno,
    stack: error ? error.stack : 'N/A'
  }
  ;(window as any).ipcRenderer?.send('renderer-error', errorInfo)

  // 捕获到 PostHog
  if (error) {
    posthog.captureException(error, {
      source: 'window-error-listener',
      ...errorInfo
    })
  }
})

window.addEventListener('unhandledrejection', event => {
  const errorInfo = {
    message: event.reason.message || 'Unhandled rejection',
    stack: event.reason.stack || 'N/A'
  }
  ;(window as any).ipcRenderer?.send('renderer-error', errorInfo)

  // 捕获到 PostHog
  posthog.captureException(event.reason, {
    source: 'window-unhandledrejection-listener',
    ...errorInfo
  })
})

// 监听后端转发的日志并显示在控制台（message 已包含完整格式化内容）
if (window.electronAPI?.onLogForwarded) {
  window.electronAPI.onLogForwarded(payload => {
    const { category, level, message, data, origin } = payload
    const prefix = `[${origin}][${category}]`

    // 极其关键：在生产环境下使用动态属性访问 console，防止 Terser 优化删除
    // 使用 window.console 确保引用的是全局对象
    const dynamicConsole = window.console as any
    const consoleMethod =
      dynamicConsole[level] || dynamicConsole['log'] || dynamicConsole.info || console.log

    if (data !== undefined && data !== null) {
      consoleMethod(prefix, message, data)
    } else {
      consoleMethod(prefix, message)
    }
  })
}

if (window.electronAPI?.onLogBatchForwarded) {
  window.electronAPI.onLogBatchForwarded(payloads => {
    payloads.forEach(payload => {
      const { category, level, message, data, origin } = payload
      const prefix = `[${origin}][${category}]`
      const dynamicConsole = window.console as any
      const consoleMethod =
        dynamicConsole[level] || dynamicConsole['log'] || dynamicConsole.info || console.log
      if (data !== undefined && data !== null) {
        consoleMethod(prefix, message, data)
      } else {
        consoleMethod(prefix, message)
      }
    })
  })
}

logger.info(LogCategory.RENDERER, '🚀 React 19应用已启动，日志转发系统已就绪')
