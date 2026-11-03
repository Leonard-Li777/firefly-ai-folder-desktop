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

// 日志来源图标映射：后端使用 ⚙️，前端使用 🖥️
const LOG_ORIGIN_ICONS: Record<string, string> = {
  backend: '⚙️',
  frontend: '🖥️'
}

// PostHog 结构化日志直采与每日配额熔断管理 (≤50条/天)
const getDailyCaptureCount = (): { count: number; date: string } => {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const stored = localStorage.getItem('ph_daily_app_log_quota')
    if (stored) {
      const parsed = JSON.parse(stored)
      if (parsed.date === today) return parsed
    }
    return { count: 0, date: today }
  } catch {
    return { count: 0, date: '' }
  }
}

const incrementDailyCaptureCount = (): boolean => {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const current = getDailyCaptureCount()
    if (current.count >= 50) return false
    localStorage.setItem(
      'ph_daily_app_log_quota',
      JSON.stringify({ count: current.count + 1, date: today })
    )
    return true
  } catch {
    return false
  }
}

// 调度队列：分帧摊平处理，防后台最小化挂起
const logQueue: any[] = []
let isProcessingQueue = false

const processLogItem = (payload: any) => {
  const { category, level, message, origin, origin_ts, trace_id } = payload
  const icon = LOG_ORIGIN_ICONS[origin] || '🖥️'
  const dynamicConsole = window.console as any

  // 出口白名单：严格仅限 info / warn / error，杜绝 console.trace
  const safeLevel = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
  const consoleMethod = dynamicConsole[safeLevel] || dynamicConsole['log'] || console.log

  // 严格单参数纯文本调用，消灭 rrweb 深克隆大对象
  const formattedLine = message.startsWith('[') ? message : `${icon}[${category}] ${message}`
  consoleMethod(formattedLine)

  // 致命 ERROR 结构化直采上报（受单日 50 条硬配额保护）
  if (level === 'error') {
    if (incrementDailyCaptureCount()) {
      import('./lib/posthog')
        .then(({ captureEvent }) => {
          captureEvent('app_log', {
            log_level: 'error',
            category,
            message: formattedLine,
            origin_ts: origin_ts || Date.now(),
            trace_id
          })
        })
        .catch(() => {})
    }
  }
}

const scheduleProcessQueue = () => {
  if (isProcessingQueue || logQueue.length === 0) return
  isProcessingQueue = true

  // 每次处理最多 15 条，避免长任务阻塞 UI
  const chunk = logQueue.splice(0, 15)
  for (const item of chunk) {
    processLogItem(item)
  }

  isProcessingQueue = false
  if (logQueue.length > 0) {
    // 使用 setTimeout(..., 16) 保证在后台/失焦时仍能持续排空，不依赖 rAF
    setTimeout(scheduleProcessQueue, 16)
  }
}

// 监听后端转发的日志并显示在控制台
if (window.electronAPI?.onLogForwarded) {
  window.electronAPI.onLogForwarded(payload => {
    logQueue.push(payload)
    scheduleProcessQueue()
  })
}

if (window.electronAPI?.onLogBatchForwarded) {
  window.electronAPI.onLogBatchForwarded(payloads => {
    logQueue.push(...payloads)
    scheduleProcessQueue()
  })
}

logger.info(LogCategory.RENDERER, '🚀 React 19应用已启动，日志转发系统已就绪')
