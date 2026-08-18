/**
 * Release 生产安装包启动与控制 Helper
 * 支持 Windows, macOS, Linux 跨平台已安装二进制查找、CDP 远程调试连接、窗口定位与生命周期管理。
 */

import { chromium, Browser, BrowserContext, Page } from '@playwright/test'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { SnapshotManager } from '../fixtures/snapshot-manager'

export interface LaunchOptions {
  executablePath?: string
  userDataDir?: string
  timeout?: number
  headless?: boolean
  debugPort?: number
}

export interface ReleaseAppInstance {
  browser: Browser
  context: BrowserContext
  page: Page
  childProcess: ChildProcess
  userDataDir: string
  getPage: () => Promise<Page>
  close: () => Promise<void>
}

export class ReleaseAppLauncher {
  /**
   * 跨平台智能查找已安装的 Release 二进制程序路径
   */
  public static resolveExecutablePath(customPath?: string): string {
    if (customPath && fs.existsSync(customPath)) {
      return customPath
    }

    if (process.env.TEST_APP_EXECUTABLE && fs.existsSync(process.env.TEST_APP_EXECUTABLE)) {
      return process.env.TEST_APP_EXECUTABLE
    }

    const platform = process.platform

    if (platform === 'win32') {
      const ciTestApp = 'C:\\TestApp'
      if (fs.existsSync(ciTestApp)) {
        const found = this.findExecutableInDir(ciTestApp)
        if (found) return found
      }

      const repoRoot = path.resolve(__dirname, '../../../../..')
      const outDir = path.join(repoRoot, 'apps', 'desktop', 'out')
      if (fs.existsSync(outDir)) {
        const found = this.findExecutableInDir(outDir)
        if (found) return found
      }

      const localAppData = process.env.LOCALAPPDATA || ''
      if (localAppData) {
        const candidate1 = path.join(localAppData, 'Programs', 'firefly-ai-folder', 'firefly-ai-folder.exe')
        if (fs.existsSync(candidate1)) return candidate1
        const candidate2 = path.join(localAppData, 'Programs', 'firefly-ai-folder-cn', 'firefly-ai-folder-cn.exe')
        if (fs.existsSync(candidate2)) return candidate2
      }
    } else if (platform === 'linux') {
      const candidates = [
        '/usr/bin/firefly-ai-folder',
        '/usr/bin/firefly-ai-folder-cn',
        '/opt/firefly-ai-folder/firefly-ai-folder',
        '/opt/firefly-ai-folder-cn/firefly-ai-folder-cn'
      ]
      for (const c of candidates) {
        if (fs.existsSync(c)) return c
      }

      const repoRoot = path.resolve(__dirname, '../../../../..')
      const outDir = path.join(repoRoot, 'apps', 'desktop', 'out')
      if (fs.existsSync(outDir)) {
        const found = this.findExecutableInDir(outDir)
        if (found) return found
      }
    } else if (platform === 'darwin') {
      const candidates = [
        '/Applications/Firefly AI Folder.app/Contents/MacOS/Firefly AI Folder',
        '/Applications/firefly-ai-folder.app/Contents/MacOS/firefly-ai-folder',
        '/tmp/Firefly.app/Contents/MacOS/Firefly AI Folder',
        '/tmp/Firefly.app/Contents/MacOS/firefly-ai-folder'
      ]
      for (const c of candidates) {
        if (fs.existsSync(c)) return c
      }

      const repoRoot = path.resolve(__dirname, '../../../../..')
      const outDir = path.join(repoRoot, 'apps', 'desktop', 'out')
      if (fs.existsSync(outDir)) {
        const found = this.findExecutableInDir(outDir)
        if (found) return found
      }
    }

    throw new Error(
      `[ReleaseAppLauncher] 未能找到已安装的 Firefly 应用可执行文件！请设置环境变量 TEST_APP_EXECUTABLE 指定二进制路径。`
    )
  }

  private static findExecutableInDir(dir: string): string | null {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true })
      for (const item of items) {
        const fullPath = path.join(dir, item.name)
        if (item.isDirectory()) {
          const nested = this.findExecutableInDir(fullPath)
          if (nested) return nested
        } else if (item.isFile()) {
          const lower = item.name.toLowerCase()
          if (
            (lower.endsWith('.exe') || (!lower.includes('.') && process.platform !== 'win32')) &&
            lower.includes('firefly') &&
            !lower.includes('uninstall') &&
            !lower.includes('setup')
          ) {
            return fullPath
          }
        }
      }
    } catch {
      // ignore
    }
    return null
  }

  /**
   * 从 CDP HTTP 接口检索精准的 WebSocket 调试 URL
   */
  private static async getWebSocketDebuggerUrl(port: number, timeoutMs = 60000): Promise<string> {
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      const wsUrl = await new Promise<string | null>((resolve) => {
        const req = http.get(
          {
            hostname: '127.0.0.1',
            port,
            path: '/json/version',
            headers: { Host: `127.0.0.1:${port}` }
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => (data += chunk))
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data)
                if (parsed.webSocketDebuggerUrl) {
                  resolve(parsed.webSocketDebuggerUrl)
                  return
                }
              } catch {}
              resolve(null)
            })
          }
        )
        req.on('error', () => resolve(null))
        req.setTimeout(800, () => {
          req.destroy()
          resolve(null)
        })
      })

      if (wsUrl) return wsUrl
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error(`[ReleaseAppLauncher] 获取 DevTools WebSocketDebuggerUrl 超时 (端口: ${port})`)
  }

  /**
   * 启动已安装的 Electron 生产应用并通过 WebSocket CDP 建立全权控制连接
   */
  public static async launch(options: LaunchOptions = {}): Promise<ReleaseAppInstance> {
    const executablePath = this.resolveExecutablePath(options.executablePath)
    const userDataDir = options.userDataDir || SnapshotManager.getUserDataDir()
    const debugPort = options.debugPort || 9333 + Math.floor(Math.random() * 500)
    const isHeadless = options.headless ?? (process.env.HEADLESS === 'true')

    console.log(`[ReleaseAppLauncher] 正在启动生产包: ${executablePath}`)
    console.log(`[ReleaseAppLauncher] UserData 隔离目录: ${userDataDir}`)
    console.log(`[ReleaseAppLauncher] CDP 远程调试端口: ${debugPort}`)

    const launchArgs = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--force-device-scale-factor=1',
      '--enable-logging',
      ...(isHeadless ? ['--headless'] : [])
    ]

    const child = spawn(executablePath, launchArgs, {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        APP_ENV: 'production',
        DISABLE_AUTO_UPDATE: '1',
        ELECTRON_ENABLE_LOGGING: '1',
        LOG_LEVEL: 'ALL'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    child.stdout?.on('data', (data) => {
      const text = data.toString().trim()
      if (text) console.log(`[APP OUT]: ${text}`)
    })

    child.stderr?.on('data', (data) => {
      const text = data.toString().trim()
      if (text) console.log(`[APP LOG]: ${text}`)
    })

    child.on('exit', (code, signal) => {
      console.log(`[ReleaseAppLauncher] 主程序进程退出: code=${code}, signal=${signal}`)
      try {
        const logsDir = path.join(userDataDir, 'logs')
        if (fs.existsSync(logsDir)) {
          const logFiles = fs.readdirSync(logsDir)
          for (const file of logFiles) {
            const content = fs.readFileSync(path.join(logsDir, file), 'utf-8')
            console.log(`\n📄 [APP LOG FILE: ${file}]:\n${content.slice(-2000)}\n`)
          }
        }
      } catch {}
    })

    // 等待并获取 WebSocket URL
    console.log(`[ReleaseAppLauncher] 等待 CDP 服务在端口 ${debugPort} 就绪...`)
    const wsEndpoint = await this.getWebSocketDebuggerUrl(debugPort, options.timeout || 60000)
    console.log(`[ReleaseAppLauncher] CDP WebSocket 就绪: ${wsEndpoint}`)

    let browser: Browser | null = null
    let lastError: any = null
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        console.log(`[ReleaseAppLauncher] 尝试建立 CDP 连接 (第 ${attempt}/10 次)...`)
        browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 45000 })
        if (browser) {
          console.log(`[ReleaseAppLauncher] 成功建立 CDP 连接！`)
          break
        }
      } catch (err: any) {
        lastError = err
        console.warn(`[ReleaseAppLauncher] CDP 连接尝试 ${attempt} 异常: ${err?.message || err}`)
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    if (!browser) {
      throw new Error(`[ReleaseAppLauncher] 连接 CDP 失败: ${wsEndpoint} (原因: ${lastError?.message || lastError})`)
    }

    const contexts = browser.contexts()
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext()

    // 智能检索主窗口 (放宽超时至 45 秒)
    const page = await this.waitForMainWindow(browser, 45000)

    const getPage = async (): Promise<Page> => {
      return await this.waitForMainWindow(browser, 30000)
    }

    const close = async () => {
      try {
        await browser?.close().catch(() => {})
      } catch {}
      try {
        child.kill()
      } catch {}
    }

    return {
      browser,
      context,
      page,
      childProcess: child,
      userDataDir,
      getPage,
      close
    }
  }

  /**
   * 智能定位主渲染窗口（跨所有 Browser Context 搜索存活页面）
   */
  public static async waitForMainWindow(browserOrContext: Browser | BrowserContext, maxWaitMs = 30000): Promise<Page> {
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const contexts = 'contexts' in browserOrContext ? browserOrContext.contexts() : [browserOrContext]
      for (const ctx of contexts) {
        const pages = ctx.pages()
        for (const p of pages) {
          try {
            const isClosed = p.isClosed()
            const url = isClosed ? '' : p.url()
            if (!isClosed && url && !url.startsWith('devtools:') && !url.includes('splash')) {
              await p.waitForLoadState('domcontentloaded').catch(() => {})
              return p
            }
          } catch {}
        }
      }
      await new Promise((r) => setTimeout(r, 600))
    }

    const contexts = 'contexts' in browserOrContext ? browserOrContext.contexts() : [browserOrContext]
    for (const ctx of contexts) {
      const valid = ctx.pages().filter((p) => !p.isClosed())
      if (valid.length > 0) return valid[0]
    }

    throw new Error(`[ReleaseAppLauncher] 未能找到任何存活的 Electron 主页面窗口 (超时: ${maxWaitMs}ms)`)
  }
}
