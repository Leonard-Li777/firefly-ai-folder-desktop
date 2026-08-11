import { spawn, execSync } from 'child_process'
import * as path from 'path'
import * as net from 'net'
import * as os from 'os'
import * as fs from 'fs'
import {
  logger,
  LogCategory,
  wrapSpawnForWindows,
  toShortPathOnWindows,
  isTestEnvironment
} from '@firefly/shared'
import { t } from '@app/languages'
import { MarkitdownProcessor } from '@firefly/core-engine'

export interface MarkitdownServerOptions {
  pages?: string
  thumbnailOut?: string
  enableOcr?: boolean
  ocrModelSize?: string
  maxContentSizeKb?: number
}

export interface MarkitdownExtractResponse {
  text?: { content?: string }
  metadata?: Record<string, any>
  thumbnail?: string
  magika?: any
  ocr?: { content?: string }
  document?: { content?: string }
  /** 总耗时（毫秒）：从接收请求到全部结果汇总返回的墙上时间 */
  time_ms?: number
  /** 各提取指标及预处理阶段的细分耗时字典（毫秒） */
  benchmark?: {
    total_ms?: number
    office_pre_pdf_ms?: number
    magika_ms?: number
    metadata_ms?: number
    text_ms?: number
    document_ms?: number
    ocr_ms?: number
    html_ms?: number
    thumbnail_ms?: number
  }
  error?: string
}

export class MarkitdownServerManager {
  private static instance: MarkitdownServerManager
  private serverProcess: any = null
  private port: number | null = null
  private isReady = false
  private isExternalProcess = false
  /** 主动关闭标志：shutdown() 触发的 exit 不视为意外崩溃 */
  private shuttingDown = false

  /** start() 返回的 Promise，extractAll() 可 await 等待 */
  private startPromise: Promise<number> | null = null

  // 总启动超时（端口检测 + 健康检查）
  private static readonly START_TIMEOUT = 45000

  private static cleanupRegistered = false

  private constructor() {
    if (!MarkitdownServerManager.cleanupRegistered) {
      MarkitdownServerManager.cleanupRegistered = true
      process.on('exit', () => this.shutdown())
      process.on('SIGTERM', () => {
        this.shutdown()
        if (!isTestEnvironment()) {
          process.exit(0)
        }
      })
      process.on('SIGINT', () => {
        this.shutdown()
        if (!isTestEnvironment()) {
          process.exit(0)
        }
      })
    }
  }

  public static getInstance(): MarkitdownServerManager {
    if (!MarkitdownServerManager.instance) {
      MarkitdownServerManager.instance = new MarkitdownServerManager()
    }
    return MarkitdownServerManager.instance
  }

  /**
   * 清理 PyInstaller 解压残留的 _MEI* 临时目录
   *
   * markitdown.exe 是 PyInstaller 打包的单文件程序，启动时会把内嵌依赖解压到
   * %TEMP%\_MEIxxxxxx（每次运行目录名随机，如 _MEI14802、_MEI179882）。
   * 正常退出时 PyInstaller bootloader 会自动清理，但崩溃、断电或被 taskkill /F 强杀时
   * 钩子无法执行，_MEI* 目录会残留。
   *
   * 注意：_MEI* 是 PyInstaller 打包单 exe 的通用命名规则，其它 PyInstaller 应用
   * 也会生成同名目录，不能无脑删除。此处通过检查解压目录内的特征文件来精确识别
   * markitdown 的解压目录：markitdown 打包依赖中特有的 magika（文件类型识别）与
   * exiftool（元数据提取）目录同时存在时才判定为 markitdown 残留并清理。
   */
  private cleanupMeiTempDirs(): void {
    try {
      const tmpDir = os.tmpdir()
      if (!fs.existsSync(tmpDir)) return
      const entries = fs.readdirSync(tmpDir)
      for (const entry of entries) {
        // PyInstaller 解压目录命名规则：_MEI + 数字（如 _MEI14802）
        if (!/^_MEI\d+$/i.test(entry)) continue
        const dirPath = path.join(tmpDir, entry)
        try {
          // 特征检测：markitdown 解压目录内必须同时包含 magika 与 exiftool 依赖目录，
          // 仅凭 _MEI* 命名无法区分来源，避免误删其它 PyInstaller 应用的临时文件
          const hasMagika = fs.existsSync(path.join(dirPath, 'magika'))
          const hasExifTool = fs.existsSync(path.join(dirPath, 'exiftool'))
          if (!hasMagika || !hasExifTool) {
            logger.debug(
              LogCategory.SYSTEM,
              `[MarkitdownServer] 跳过非 markitdown 的 _MEI 临时目录（缺少 magika/exiftool 特征）: ${dirPath}`
            )
            continue
          }
          fs.rmSync(dirPath, { recursive: true, force: true })
          logger.info(
            LogCategory.SYSTEM,
            `[MarkitdownServer] 已清理 markitdown 残留 _MEI 临时目录: ${dirPath}`
          )
        } catch (err) {
          // 目录可能正被其他进程占用（如仍有 PyInstaller 进程存活），跳过并继续清理其余项
          logger.debug(
            LogCategory.SYSTEM,
            `[MarkitdownServer] 跳过无法清理的 _MEI 临时目录: ${dirPath}`,
            err
          )
        }
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[MarkitdownServer] 清理 _MEI 临时目录失败:', err)
    }
  }

  /** 获取一个空闲端口 */
  private static getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port
        server.close(() => resolve(port))
      })
      server.on('error', reject)
    })
  }

  /** 静态方法：检查特定端口上的 Markitdown 服务健康状态 */
  public static async checkHealth(port: number, timeoutMs = 1500): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * 启动 Markitdown Server 并等待就绪
   * 统一超时控制，串联 start + waitForReady
   */
  public async startAndWait(timeoutMs = MarkitdownServerManager.START_TIMEOUT): Promise<number> {
    const deadline = Date.now() + timeoutMs
    const port = await this.start(deadline)
    await this.waitForReady(deadline)
    return port
  }

  /**
   * 启动 Markitdown Server
   */
  public async start(deadline?: number): Promise<number> {
    if (this.serverProcess || (this.isExternalProcess && this.isReady)) {
      logger.info(LogCategory.SYSTEM, '[MarkitdownServer] Server is already running')
      return this.port!
    }

    if (this.startPromise) {
      logger.info(LogCategory.SYSTEM, '[MarkitdownServer] Waiting for ongoing start')
      return this.startPromise
    }

    this.startPromise = (async () => {
      // 优先尝试复用已在运行的服务（如指定了 MARKITDOWN_SERVER_PORT，或处于测试/复用模式）
      const configuredPortStr = process.env.MARKITDOWN_SERVER_PORT
      const isTestMode = isTestEnvironment()
      const reuseEnabled =
        process.env.MARKITDOWN_REUSE_SERVER === 'true' || !!configuredPortStr || isTestMode

      if (reuseEnabled) {
        const portsToCheck: number[] = []
        if (configuredPortStr) {
          const p = parseInt(configuredPortStr, 10)
          if (!isNaN(p) && p > 0) portsToCheck.push(p)
        }
        if (this.port && !portsToCheck.includes(this.port)) {
          portsToCheck.push(this.port)
        }

        for (const checkPort of portsToCheck) {
          const isAlive = await MarkitdownServerManager.checkHealth(checkPort)
          if (isAlive) {
            logger.info(
              LogCategory.SYSTEM,
              `[MarkitdownServer] 检测到已在运行的 Markitdown 服务 (端口: ${checkPort})，直接复用`
            )
            this.port = checkPort
            this.isReady = true
            this.isExternalProcess = true
            return checkPort
          }
        }
      }

      // 非复用模式且非现有健康服务时，仅清理残留进程
      if (!this.isExternalProcess) {
        try {
          execSync('taskkill /F /IM markitdown.exe /T 2>NUL', { windowsHide: true, timeout: 5000 })
        } catch {
          logger.debug(LogCategory.SYSTEM, '[MarkitdownServer] 没有残留 markitdown 进程需要清理')
        }
        // 清理上次运行残留的 _MEI* 解压目录（崩溃/强杀后 PyInstaller 无法自清理）
        this.cleanupMeiTempDirs()
      }

      const port = await MarkitdownServerManager.getFreePort()
      const binaryPath = toShortPathOnWindows(MarkitdownProcessor.getMarkitdownBinaryPath())
      const args = ['server', '--port', port.toString()]

      logger.info(
        LogCategory.SYSTEM,
        `[MarkitdownServer] Starting server on port ${port}: ${binaryPath} ${args.join(' ')}`
      )

      const { command, args: spawnArgs } = wrapSpawnForWindows(binaryPath, args)

      const childEnv = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1'
      }

      logger.debug(
        LogCategory.SYSTEM,
        `[MarkitdownServer] Spawn args: command=${command} args=${JSON.stringify(spawnArgs)}`
      )

      this.serverProcess = spawn(command, spawnArgs, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        shell: false
      })

      // 复用模式残留标记清零：本次已实际托管子进程，需纳入 shutdown 清理
      this.isExternalProcess = false
      this.port = port

      this.serverProcess.stdout.on('data', (data: Buffer) => {
        logger.debug(LogCategory.SYSTEM, `[MarkitdownServer] stdout: ${data.toString().trim()}`)
      })

      this.serverProcess.stderr.on('data', (data: Buffer) => {
        logger.debug(LogCategory.SYSTEM, `[MarkitdownServer] stderr: ${data.toString().trim()}`)
      })

      this.serverProcess.on('error', (err: Error) => {
        logger.error(LogCategory.SYSTEM, '[MarkitdownServer] Failed to start server', err)
        this.serverProcess = null
        this.port = null
        // 启动失败时进程可能已留下 _MEI* 解压残留，兜底清理
        this.cleanupMeiTempDirs()
      })

      this.serverProcess.on('exit', (code: number) => {
        if (this.shuttingDown) {
          logger.info(
            LogCategory.SYSTEM,
            `[MarkitdownServer] Server exited with code ${code} (shutting down)`
          )
        } else {
          // 运行中意外退出：保留 port 供下次 extractAll 健康检查复用（可能 Worker 仍存活），
          // 状态交由 extractAll 按需自动恢复/重启
          logger.warn(
            LogCategory.SYSTEM,
            `[MarkitdownServer] Server exited unexpectedly with code ${code}，将在下次调用时按需自动恢复`
          )
          // 进程意外退出（崩溃/被杀）后 PyInstaller 无法自清理 _MEI* 解压目录，兜底删除残留
          this.cleanupMeiTempDirs()
        }
        this.serverProcess = null
        this.isReady = false
      })

      return port
    })().finally(() => {
      this.startPromise = null
    })

    return this.startPromise
  }

  /**
   * 等待服务就绪
   */
  public async waitForReady(deadline?: number): Promise<boolean> {
    if (this.isReady) return true
    if (!this.port) throw new Error('MarkitdownServer not started')

    const url = `http://127.0.0.1:${this.port}/health`

    while (!deadline || Date.now() < deadline) {
      try {
        const response = await fetch(url)
        if (response.ok) {
          this.isReady = true
          logger.info(LogCategory.SYSTEM, '[MarkitdownServer] Server is ready')
          return true
        }
      } catch (e) {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, 500))
    }

    throw new Error('MarkitdownServer health check timeout')
  }

  /**
   * 调用 /extract 接口提取所有指标
   */
  public async extractAll(
    filePath: string,
    extractIndicators: string[],
    options: MarkitdownServerOptions = {}
  ): Promise<MarkitdownExtractResponse> {
    if (!this.isReady) {
      // 端口存在时（含 PyInstaller onefile 引导进程退出但 Worker 仍存活的场景）先做健康检查复用
      const alive = this.port ? await MarkitdownServerManager.checkHealth(this.port) : false
      if (alive) {
        this.isReady = true
        logger.info(
          LogCategory.SYSTEM,
          `[MarkitdownServer] 检测到服务仍存活 (端口: ${this.port})，恢复就绪状态复用`
        )
      } else if (this.startPromise) {
        logger.info(LogCategory.SYSTEM, '[MarkitdownServer] extractAll 等待启动完成...')
        const port = await this.startPromise
        if (port > 0) {
          await this.waitForReady(Date.now() + 10000)
        } else {
          throw new Error(t('MarkitdownServer 启动失败'))
        }
      } else {
        // 未启动或已崩溃：按需自动启动/重启，避免出现 "MarkitdownServer is not started"
        logger.warn(LogCategory.SYSTEM, '[MarkitdownServer] 服务未运行或已退出，按需自动启动...')
        await this.startAndWait(MarkitdownServerManager.START_TIMEOUT)
      }
    }

    const url = `http://127.0.0.1:${this.port}/extract`
    const body: any = {
      file_path: filePath,
      extract: extractIndicators.join(',')
    }
    if (options.pages) body.pages = options.pages
    if (options.thumbnailOut) body.thumbnail_out = options.thumbnailOut
    if (options.enableOcr !== undefined) body.enable_ocr = options.enableOcr
    if (options.ocrModelSize) body.ocr_model_size = options.ocrModelSize
    // maxContentSizeKb：undefined 不发送（服务端默认 30 KB），0/-1 表示不限制（服务端已支持）
    if (options.maxContentSizeKb !== undefined) {
      body.max_content_size_kb = options.maxContentSizeKb
    }
    logger.debug(
      LogCategory.SYSTEM,
      `[MarkitdownServer] extractAll request: url=${url}\n${JSON.stringify(body, null, 2)}`
    )

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`MarkitdownServer extract failed (${response.status}): ${errorText}`)
      }

      const result = (await response.json()) as any

      logger.debug(
        LogCategory.SYSTEM,
        `[MarkitdownServer] extractAll response:\n${JSON.stringify(
          truncateAllLongFields(result),
          null,
          2
        )}`
      )

      // server 可能返回 { result: { document, ocr, ... }, metadata: {...}, magika: {...} } 或直接展开
      const unwrapped: MarkitdownExtractResponse = result?.result || result
      // 解包时保留顶层字段（与 result 同级），例如 metadata、magika 等
      if (result?.result) {
        for (const key of Object.keys(result)) {
          if (key !== 'result' && !(key in unwrapped)) {
            ;(unwrapped as any)[key] = result[key]
          }
        }
      }
      return unwrapped
    } catch (error) {
      logger.error(LogCategory.SYSTEM, `[MarkitdownServer] Extract failed: ${filePath}`, error)
      throw error
    }
  }

  /**
   * 获取服务基础 URL
   */
  public getBaseUrl(): string {
    if (!this.port) return ''
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * 服务是否已就绪
   */
  public getIsReady(): boolean {
    return this.isReady
  }

  /**
   * 关闭服务（同步，确保子进程树全部终止）
   */
  public shutdown(): void {
    this.shuttingDown = true
    const isTestMode = isTestEnvironment()
    if (this.isExternalProcess || isTestMode) {
      logger.info(
        LogCategory.SYSTEM,
        '[MarkitdownServer] 复用的外部/测试环境服务，保留运行，解绑管理器状态'
      )
      this.serverProcess = null
      this.port = null
      this.isReady = false
      this.isExternalProcess = false
      return
    }

    logger.info(LogCategory.SYSTEM, '[MarkitdownServer] Shutting down server')
    try {
      if (process.platform === 'win32') {
        if (this.serverProcess?.pid) {
          try {
            execSync(`taskkill /F /T /PID ${this.serverProcess.pid} 2>NUL`, {
              windowsHide: true,
              timeout: 5000
            })
          } catch {}
        }
        // PyInstaller onefile 的引导进程 (1.3M) 启动完 Worker (97.4M) 后可能已 exit，
        // 导致 this.serverProcess 为 null，必须强杀映像名 markitdown.exe 确保清理 97.4M 的 Worker 进程
        execSync('taskkill /F /IM markitdown.exe /T 2>NUL', {
          windowsHide: true,
          timeout: 5000
        })
      } else {
        if (this.serverProcess) {
          this.serverProcess.kill('SIGTERM')
        }
      }
    } catch (e) {
      logger.error(LogCategory.SYSTEM, '[MarkitdownServer] Failed to kill process', e)
    }
    this.serverProcess = null
    this.port = null
    this.isReady = false

    // taskkill /F 强杀后 PyInstaller 无法自清理 _MEI* 解压目录，此处兜底删除残留
    this.cleanupMeiTempDirs()
  }
}

/** 递归截断日志中的长字段（content/data 超过 300 字符时） */
function truncateAllLongFields(obj: any): any {
  if (Array.isArray(obj)) return obj.map(truncateAllLongFields)
  if (obj === null || typeof obj !== 'object') return obj
  const result: any = {}
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string' && (key === 'content' || key === 'data') && val.length > 300) {
      result[key] = `${val.slice(0, 300)}... (truncated, total ${val.length})`
    } else if (typeof val === 'object' && val !== null) {
      result[key] = truncateAllLongFields(val)
    } else {
      result[key] = val
    }
  }
  return result
}

export const markitdownServerManager = MarkitdownServerManager.getInstance()
