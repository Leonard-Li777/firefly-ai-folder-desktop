/**
 * 统一常驻微服务管理器 (UnifiedWorkerManager)
 * 负责守护微服务的生命周期管理、端口协商、健康检查与客户端 HTTP 请求调用
 */

import { logger, LogCategory, findAvailablePort } from '@firefly/shared'
import * as http from 'node:http'
import { UnifiedWorkerServer } from './unified-worker-server'
import { WorkerHealthStatus } from './types'

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export class UnifiedWorkerManager {
  private static instance: UnifiedWorkerManager
  private workerServer: UnifiedWorkerServer | null = null
  private configuredPort = 28686
  private actualPort = 0
  private isStarted = false

  private constructor() {}

  public static getInstance(): UnifiedWorkerManager {
    if (!UnifiedWorkerManager.instance) {
      UnifiedWorkerManager.instance = new UnifiedWorkerManager()
    }
    return UnifiedWorkerManager.instance
  }

  /**
   * 获取微服务监听端口
   */
  public getActualPort(): number {
    return this.actualPort
  }

  /**
   * 启动统一常驻微服务
   * @param port 期望端口 (默认 28686)
   */
  public async start(port = 28686): Promise<number> {
    if (this.isStarted && this.actualPort > 0) {
      return this.actualPort
    }

    this.configuredPort = port
    const availablePort = await findAvailablePort(this.configuredPort)

    this.workerServer = new UnifiedWorkerServer(availablePort)
    this.actualPort = await this.workerServer.start()
    this.isStarted = true

    logger.info(
      LogCategory.SYSTEM,
      `[UnifiedWorkerManager] 守护微服务初始化成功，使用端口: ${this.actualPort}`
    )

    await this.writeConfigFile().catch(err =>
      logger.warn(LogCategory.SYSTEM, '[UnifiedWorkerManager] 持久化 Skill 配置落盘失败:', err)
    )

    return this.actualPort
  }

  /**
   * 将当前微服务的真实监听端口写入 userData/ai-skill-config.json
   */
  private async writeConfigFile(): Promise<void> {
    try {
      const { app } = require('electron')
      if (app && typeof app.getPath === 'function') {
        const userDataPath = app.getPath('userData')
        const configPath = path.join(userDataPath, 'ai-skill-config.json')
        const payload = JSON.stringify(
          {
            port: this.actualPort,
            host: '127.0.0.1',
            startedAt: new Date().toISOString(),
            pid: process.pid
          },
          null,
          2
        )
        await fs.mkdir(userDataPath, { recursive: true })
        await fs.writeFile(configPath, payload, 'utf-8')
        logger.info(
          LogCategory.SYSTEM,
          `[UnifiedWorkerManager] 端口配置文件已同步落盘 (port=${this.actualPort}): ${configPath}`
        )
      }
    } catch {
      // 单测或非 Electron 环境静默跳过
    }
  }

  /**
   * 停止守护微服务
   */
  public async stop(): Promise<void> {
    if (this.workerServer) {
      await this.workerServer.stop()
      this.workerServer = null
    }
    this.isStarted = false
    this.actualPort = 0
    logger.info(LogCategory.SYSTEM, '[UnifiedWorkerManager] 守护微服务已停止')
  }

  /**
   * 获取底层 Server 实例（方便扩展或挂载 Skill 处理器）
   */
  public getServer(): UnifiedWorkerServer | null {
    return this.workerServer
  }

  /**
   * 检查守护微服务健康状态
   */
  public async checkHealth(): Promise<WorkerHealthStatus | null> {
    if (!this.isStarted || this.actualPort === 0) return null
    try {
      const res = await this.postJson<WorkerHealthStatus>('/api/health', {}, 'GET')
      return res
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[UnifiedWorkerManager] 健康检查失败:', err)
      return null
    }
  }

  /**
   * 通用 JSON HTTP 请求辅助函数
   */
  public postJson<T = any>(
    pathname: string,
    body: any = {},
    method: 'GET' | 'POST' = 'POST'
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.actualPort === 0) {
        return reject(new Error('Unified Worker Service is not started'))
      }

      const jsonStr = JSON.stringify(body)
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.actualPort,
        path: pathname,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(jsonStr)
        }
      }

      const req = http.request(options, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          try {
            const parsed = JSON.parse(raw)
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              if (parsed.success) {
                // 如果返回包含了 data 字段则解包，否则返回全量对象
                resolve(parsed.data !== undefined ? parsed.data : parsed)
              } else {
                reject(new Error(parsed.error || 'Worker request failed'))
              }
            } else {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`))
            }
          } catch (err) {
            reject(new Error(`Failed to parse JSON response: ${raw}`))
          }
        })
      })

      req.on('error', reject)
      if (method === 'POST') {
        req.write(jsonStr)
      }
      req.end()
    })
  }
}

export const unifiedWorkerManager = UnifiedWorkerManager.getInstance()
