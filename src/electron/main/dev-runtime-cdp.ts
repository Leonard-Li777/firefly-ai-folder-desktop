import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import {
  logger,
  LogCategory,
  getWorktreeDebugPortSlot,
  selectAvailablePortInSlotSync,
  ServiceDiscoveryFile,
  publishWorkspaceDevRuntimeMirror,
  revokeWorkspaceDevRuntimeMirror,
  type PortSlotRange,
  type PlatformDevRuntimeEntry
} from '@firefly/shared'
import {
  isLocalDevRuntime,
  resolveWorkspaceRootDir,
  touchActiveWorktree
} from './worktree-env'

export interface DevToolsActivePortInfo {
  port: number
  wsPath: string
}

export interface CandidateCdpPortResult {
  switchValue: string
  candidatePort: number
  isZeroPortFallback: boolean
  slot?: PortSlotRange
}

export interface DevCdpVerifyResult {
  relaunched: boolean
  published: boolean
  cdpPort?: number
  cdpWsEndpoint?: string
  cdpSource?: 'DevToolsActivePort' | 'json-version'
}

export interface DevRuntimeControllerDeps {
  isDevRuntime?: () => boolean
  appendSwitch: (name: string, value: string) => void
  relaunch: (options: { args: string[] }) => void
  exit: (code: number) => void
  argv?: string[]
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  pid?: number
  execPath?: string
  occupiedPorts?: Set<number>
  probeJsonVersion?: (port: number, timeoutMs: number) => Promise<{ webSocketDebuggerUrl: string } | null>
  readActivePort?: (
    userDataDir: string,
    options?: { maxAttempts?: number; delayMs?: number }
  ) => Promise<DevToolsActivePortInfo | null>
  touchActive?: (
    worktreeName: string,
    meta?: {
      platform?: NodeJS.Platform
      cdpPort?: number
      devServerPort?: number
      userDataDir?: string
    }
  ) => void
  maxActivePortAttempts?: number
  activePortDelayMs?: number
  jsonVersionTimeoutMs?: number
}

function parseValidPort(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const num = Number(raw.trim())
  if (Number.isInteger(num) && num >= 1 && num <= 65535) {
    return num
  }
  return undefined
}

/**
 * 从 ELECTRON_RENDERER_URL 或 PORT 环境变量提取当前 Renderer Dev Server 端口
 */
export function extractDevServerPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const rendererUrl = env.ELECTRON_RENDERER_URL?.trim()
  if (rendererUrl) {
    try {
      const parsed = new URL(rendererUrl)
      const portFromUrl = parseValidPort(parsed.port)
      if (portFromUrl !== undefined) {
        return portFromUrl
      }
    } catch {
      // 忽略非法 URL，回退至 PORT
    }
  }
  return parseValidPort(env.PORT)
}

/**
 * 解析命令行中显式传入的 --remote-debugging-port=<n>（支持 0 表示 OS 自动分配）
 */
function parseCliRemoteDebuggingPort(argv: string[]): number | undefined {
  const arg = argv.find(item => item.startsWith('--remote-debugging-port='))
  if (!arg) return undefined
  const raw = arg.slice('--remote-debugging-port='.length).trim()
  if (!/^\d+$/.test(raw)) return undefined
  const port = Number(raw)
  if (Number.isInteger(port) && port >= 0 && port <= 65535) {
    return port
  }
  return undefined
}

/**
 * 在开发模式下基于平台有界 CDP 子槽位与单次端口占用快照选择候选 CDP 端口：
 * - 若 CLI 已指定 --remote-debugging-port=0（含自愈 relaunch 分支），直接返回 '0'；
 * - 否则将 CLI/ENV 指定的端口（若有）作为 preferredPort，强制经过单次快照空闲检测；
 * - 若子槽位已满，直接返回 '0' 交由 OS 内核原子分配空闲端口。
 */
export function selectCandidateCdpPort(options: {
  worktreeName: string
  platform?: NodeJS.Platform
  argv?: string[]
  env?: NodeJS.ProcessEnv
  occupiedPorts?: Set<number>
}): CandidateCdpPortResult {
  const platform = options.platform ?? process.platform
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env

  const cliPort = parseCliRemoteDebuggingPort(argv)
  if (cliPort === 0) {
    return {
      switchValue: '0',
      candidatePort: 0,
      isZeroPortFallback: true
    }
  }

  const envPort = parseValidPort(env.REMOTE_DEBUGGING_PORT)
  const preferredPort = cliPort !== undefined && cliPort > 0 ? cliPort : envPort
  const slot = getWorktreeDebugPortSlot(options.worktreeName, platform)

  const selected = selectAvailablePortInSlotSync({
    slot,
    preferredPort,
    occupiedPorts: options.occupiedPorts
  })

  if (selected === null) {
    logger.warn(
      LogCategory.STARTUP,
      `[Chromium] Worktree=${options.worktreeName} 平台=${platform} CDP 子槽位 [${slot.basePort}~${slot.maxPort}] 已全部被占用，切入 --remote-debugging-port=0 兜底`
    )
    return {
      switchValue: '0',
      candidatePort: 0,
      isZeroPortFallback: true,
      slot
    }
  }

  return {
    switchValue: String(selected),
    candidatePort: selected,
    isZeroPortFallback: false,
    slot
  }
}

/**
 * 非阻塞退避读取 Chromium 写入的 userData/DevToolsActivePort 文件（最多 15 × 50ms = 750ms）
 */
export async function readDevToolsActivePort(
  userDataDir: string,
  options?: { maxAttempts?: number; delayMs?: number }
): Promise<DevToolsActivePortInfo | null> {
  const filePath = path.join(userDataDir, 'DevToolsActivePort')
  const maxAttempts = options?.maxAttempts ?? 15
  const delayMs = options?.delayMs ?? 50

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8').trim()
        const lines = raw.split(/\r?\n/).map(line => line.trim())
        const port = parseValidPort(lines[0])
        const wsPath = lines[1] || ''
        if (port !== undefined && wsPath.startsWith('/devtools/browser/')) {
          return { port, wsPath }
        }
      }
    } catch {
      // 文件可能正在被 Chromium 写入中，等待下一轮退避
    }

    if (attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  return null
}

/**
 * 对本地 CDP 端点发起单次 HTTP GET /json/version（默认 1000ms 超时），校验 webSocketDebuggerUrl
 */
export function probeCdpJsonVersion(
  port: number,
  timeoutMs = 1000
): Promise<{ webSocketDebuggerUrl: string } | null> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: { webSocketDebuggerUrl: string } | null) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/json/version',
        timeout: timeoutMs
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume()
          finish(null)
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          body += chunk
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            if (
              parsed &&
              typeof parsed.webSocketDebuggerUrl === 'string' &&
              parsed.webSocketDebuggerUrl.startsWith('ws://')
            ) {
              finish({ webSocketDebuggerUrl: parsed.webSocketDebuggerUrl })
              return
            }
          } catch {
            // 忽略非 JSON 响应
          }
          finish(null)
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })

    req.on('error', () => {
      finish(null)
    })
  })
}

/**
 * Desktop 本地开发运行时 CDP 端口治理、真值核验与镜像发布控制器：
 * - 严格仅在 requestSingleInstanceLock() 成功后实例化和调用；
 * - 严格遵守 isLocalDevRuntime() 门控，生产/打包/单测模式下 0 磁盘副作用。
 */
export class DesktopDevRuntimeController {
  private readonly worktreeName: string
  private readonly userDataDir: string
  private readonly workspaceRootDir: string
  private readonly deps: DevRuntimeControllerDeps
  private readonly instanceId: string
  private readonly startedAt: string

  private discoveryFile: ServiceDiscoveryFile | null = null
  private candidateResult: CandidateCdpPortResult | null = null
  private revision = 0
  private lastVerified: {
    cdpPort: number
    cdpUrl: string
    cdpWsEndpoint?: string
    cdpSource: 'DevToolsActivePort' | 'json-version'
    hostReachableUrl: string
    devServerPort?: number
  } | null = null

  constructor(options: {
    worktreeName: string
    userDataDir: string
    workspaceRootDir?: string
    deps: DevRuntimeControllerDeps
  }) {
    this.worktreeName = options.worktreeName
    this.userDataDir = options.userDataDir
    this.workspaceRootDir = options.workspaceRootDir ?? resolveWorkspaceRootDir()
    this.deps = options.deps
    this.instanceId = crypto.randomUUID()
    this.startedAt = new Date().toISOString()
  }

  private isDevMode(): boolean {
    return this.deps.isDevRuntime ? this.deps.isDevRuntime() : isLocalDevRuntime()
  }

  private getPlatform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform
  }

  private getPid(): number {
    return this.deps.pid ?? process.pid
  }

  private getArgv(): string[] {
    return this.deps.argv ?? process.argv
  }

  private getEnv(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env
  }

  private ensureDiscoveryFile(): ServiceDiscoveryFile {
    if (!this.discoveryFile) {
      this.discoveryFile = new ServiceDiscoveryFile({
        fileName: 'desktop-dev-config.json',
        serviceId: 'desktop-dev',
        userDataPath: this.userDataDir
      })
    }
    return this.discoveryFile
  }

  /**
   * 必须在 app.requestSingleInstanceLock() 成功后、app.on('ready') 之前调用：
   * 1. 开发模式下清理孤儿 desktop-dev-config.json 与陈旧 DevToolsActivePort；
   * 2. 基于平台有界子槽位 + 单次快照选定候选 CDP 端口并追加 Chromium 开关。
   */
  prepareBeforeReady(): CandidateCdpPortResult | null {
    const argv = this.getArgv()
    if (!this.isDevMode()) {
      // 生产/测试模式下严禁触碰 DevToolsActivePort 或任何 dev 发现文件，仅透传显式 CLI 参数
      const explicitCliPort = parseCliRemoteDebuggingPort(argv)
      if (explicitCliPort !== undefined) {
        this.deps.appendSwitch('remote-debugging-port', String(explicitCliPort))
      }
      return null
    }

    // 1. 清理历史孤儿 desktop-dev-config.json 与陈旧 *.tmp.*
    this.ensureDiscoveryFile().cleanupOrphanOnStartup()

    // 2. 启动前删除陈旧的 userData/DevToolsActivePort，彻底消灭上次崩溃残留的旧端口误导
    const activePortPath = path.join(this.userDataDir, 'DevToolsActivePort')
    try {
      fs.unlinkSync(activePortPath)
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        logger.warn(
          LogCategory.STARTUP,
          `[Chromium] 删除陈旧 DevToolsActivePort 失败 (${activePortPath}):`,
          err
        )
      }
    }

    // 3. 计算候选 CDP 端口并配置 Chromium 开关
    const result = selectCandidateCdpPort({
      worktreeName: this.worktreeName,
      platform: this.getPlatform(),
      argv,
      env: this.getEnv(),
      occupiedPorts: this.deps.occupiedPorts
    })
    this.candidateResult = result
    this.deps.appendSwitch('remote-debugging-port', result.switchValue)

    if (result.slot && !result.isZeroPortFallback) {
      logger.info(
        LogCategory.STARTUP,
        `[Chromium] Worktree=${this.worktreeName} 平台=${result.slot.platform} 候选远程调试端口: ${result.candidatePort} (子槽位: ${result.slot.basePort}~${result.slot.maxPort})`
      )
    } else {
      logger.info(
        LogCategory.STARTUP,
        `[Chromium] Worktree=${this.worktreeName} 使用 --remote-debugging-port=0 由 OS 动态分配 CDP 端口`
      )
    }

    return result
  }

  /**
   * 必须在 app.on('ready') 中、创建主窗口之前调用：
   * 1. 非阻塞退避读取 DevToolsActivePort，并单次请求 /json/version 校验真值；
   * 2. 若未生成且 /json/version 不可达且未处于 port=0 重试态，静默 relaunch 切换 --remote-debugging-port=0；
   * 3. 核验通过后发布 desktop-dev-config.json 与工作区 .firefly-dev-runtime 分片+聚合镜像。
   */
  async verifyAndPublishOnReady(): Promise<DevCdpVerifyResult> {
    if (!this.isDevMode()) {
      return { relaunched: false, published: false }
    }

    const readActive = this.deps.readActivePort ?? readDevToolsActivePort
    const probeVersion = this.deps.probeJsonVersion ?? probeCdpJsonVersion

    const activePortInfo = await readActive(this.userDataDir, {
      maxAttempts: this.deps.maxActivePortAttempts ?? 15,
      delayMs: this.deps.activePortDelayMs ?? 50
    })

    const candidatePort = this.candidateResult?.candidatePort ?? 0
    const probePort = activePortInfo?.port ?? (candidatePort > 0 ? candidatePort : null)
    const versionInfo =
      probePort !== null
        ? await probeVersion(probePort, this.deps.jsonVersionTimeoutMs ?? 1000)
        : null

    // 绑定失败自愈：DevToolsActivePort 未生成且 /json/version 不可达
    if (!activePortInfo && !versionInfo) {
      const alreadyZeroPort = this.candidateResult?.isZeroPortFallback === true
      if (!alreadyZeroPort) {
        const nextArgs = [
          ...this.getArgv()
            .slice(1)
            .filter(arg => !arg.startsWith('--remote-debugging-port')),
          '--remote-debugging-port=0'
        ]
        logger.warn(
          LogCategory.STARTUP,
          `[Chromium] 候选 CDP 端口 (${candidatePort}) 绑定核验失败（DevToolsActivePort 缺失且 /json/version 不可达），建窗前静默 relaunch 切换 --remote-debugging-port=0`
        )
        this.deps.relaunch({ args: nextArgs })
        this.deps.exit(0)
        return { relaunched: true, published: false }
      }

      logger.warn(
        LogCategory.STARTUP,
        '[Chromium] 已处于 --remote-debugging-port=0 重试态仍未检测到可用 CDP 端点，跳过发布并继续启动'
      )
      return { relaunched: false, published: false }
    }

    const actualPort = activePortInfo?.port ?? probePort!
    const cdpSource: 'DevToolsActivePort' | 'json-version' = activePortInfo
      ? 'DevToolsActivePort'
      : 'json-version'
    const cdpUrl = `http://127.0.0.1:${actualPort}`
    const cdpWsEndpoint =
      versionInfo?.webSocketDebuggerUrl ??
      (activePortInfo ? `ws://127.0.0.1:${actualPort}${activePortInfo.wsPath}` : undefined)

    if (activePortInfo && !versionInfo) {
      logger.warn(
        LogCategory.STARTUP,
        `[Chromium] 已从 DevToolsActivePort 读取真实端口 ${actualPort}，但 /json/version 单次探测超时，使用 DevToolsActivePort 推导端点继续发布`
      )
    }

    const env = this.getEnv()
    const publicUrlOverride = env.FIREFLY_DEV_CDP_PUBLIC_URL?.trim()
    const hostReachableUrl = publicUrlOverride || cdpUrl
    const devServerPort = extractDevServerPort(env)

    this.lastVerified = {
      cdpPort: actualPort,
      cdpUrl,
      cdpWsEndpoint,
      cdpSource,
      hostReachableUrl,
      devServerPort
    }

    await this.publishCurrentState()
    return {
      relaunched: false,
      published: true,
      cdpPort: actualPort,
      cdpWsEndpoint,
      cdpSource
    }
  }

  /**
   * second-instance 触发时重发布，刷新 revision 与活跃时间戳
   */
  async republishOnSecondInstance(): Promise<void> {
    if (!this.isDevMode() || !this.lastVerified) {
      return
    }
    await this.publishCurrentState()
  }

  private async publishCurrentState(): Promise<void> {
    if (!this.lastVerified) return
    this.revision += 1

    const platform = this.getPlatform()
    const pid = this.getPid()
    const { cdpPort, cdpUrl, cdpWsEndpoint, cdpSource, hostReachableUrl, devServerPort } =
      this.lastVerified

    await this.ensureDiscoveryFile().publish({
      instanceId: this.instanceId,
      pid,
      port: cdpPort,
      host: '127.0.0.1',
      baseUrl: cdpUrl,
      startedAt: this.startedAt,
      revision: this.revision,
      userDataDir: this.userDataDir,
      capabilities: ['cdp'],
      debug: {
        platform,
        worktreeName: this.worktreeName,
        cdpPort,
        cdpUrl,
        cdpWsEndpoint,
        cdpSource,
        hostReachableUrl,
        devServerPort,
        userDataDir: this.userDataDir,
        devBinaryPath: this.deps.execPath ?? process.execPath
      }
    })

    const mirrorEntry: PlatformDevRuntimeEntry = {
      pid,
      instanceId: this.instanceId,
      cdpPort,
      cdpUrl,
      cdpWsEndpoint,
      cdpSource,
      hostReachableUrl,
      devServerPort,
      userDataDir: this.userDataDir,
      startedAt: this.startedAt
    }

    publishWorkspaceDevRuntimeMirror(this.workspaceRootDir, this.worktreeName, platform, mirrorEntry)

    const touchFn = this.deps.touchActive ?? touchActiveWorktree
    touchFn(this.worktreeName, {
      platform,
      cdpPort,
      devServerPort,
      userDataDir: this.userDataDir
    })
  }

  /**
   * 接入 app.on('before-quit') 异步清理链（置于 app.exit 之前，严禁挂在 will-quit）
   */
  async revokeAsync(): Promise<void> {
    if (!this.isDevMode()) return
    const pid = this.getPid()
    try {
      await this.ensureDiscoveryFile().revoke({ pid, instanceId: this.instanceId })
    } catch (err) {
      logger.warn(LogCategory.MAIN, '[DevRuntime] 撤销 desktop-dev-config.json 失败:', err)
    }
    try {
      revokeWorkspaceDevRuntimeMirror(this.workspaceRootDir, this.getPlatform(), pid)
    } catch (err) {
      logger.warn(LogCategory.MAIN, '[DevRuntime] 撤销工作区开发运行时镜像失败:', err)
    }
  }

  /**
   * 接入 SIGINT / SIGTERM 同步处理器，确保进程被终端信号终止时同步清理镜像与发现文件
   */
  revokeSync(): void {
    if (!this.isDevMode()) return
    const pid = this.getPid()
    try {
      this.ensureDiscoveryFile().revokeSync({ pid, instanceId: this.instanceId })
    } catch {
      // 信号退出路径静默容错
    }
    try {
      revokeWorkspaceDevRuntimeMirror(this.workspaceRootDir, this.getPlatform(), pid)
    } catch {
      // 信号退出路径静默容错
    }
  }
}
