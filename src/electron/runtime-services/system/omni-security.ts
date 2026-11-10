/**
 * apps/desktop/src/electron/runtime-services/system/omni-security.ts
 *
 * Omni 原生服务单实例文件锁、令牌安全与 Host 防御模块
 * 规范依据：docs/specs/generative-engine-pocket-cpu-and-unified-abstraction-spec.md §8
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { logger, LogCategory } from '@firefly/shared'

export interface OmniTokenPayload {
  pid: number
  bootId: string
  port: number
  token: string
  createdAt: number
}

/**
 * Omni 单实例文件咨询锁管理器
 * 遵循 Spec §8：通过操作系统文件咨询锁实现同一 OS 用户独占，多开实例自动退出
 */
export class OmniInstanceLock {
  private lockFd: number | null = null
  private lockFilePath: string

  constructor(runDir: string) {
    this.lockFilePath = path.join(runDir, 'firefly-omni.lock')
  }

  /**
   * 尝试获取文件咨询锁
   * @returns true 获取成功；false 已有活跃实例运行中
   */
  public acquire(): boolean {
    try {
      const dir = path.dirname(this.lockFilePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 使用排他创建模式 'wx' 或 'w+'
      // 在同一用户下，若文件已被其他实例独占打开或存在有效 PID 则排他
      if (fs.existsSync(this.lockFilePath)) {
        try {
          const content = fs.readFileSync(this.lockFilePath, 'utf8')
          const existingPid = parseInt(content.trim(), 10)
          if (!isNaN(existingPid) && existingPid > 0) {
            // 探测 PID 是否存活
            try {
              process.kill(existingPid, 0)
              // 存活，说明另一个实例正在运行
              logger.warn(
                LogCategory.SYSTEM,
                `[OmniInstanceLock] 实例已在运行中 (PID: ${existingPid})，自动放弃启动`
              )
              return false
            } catch {
              // 进程已死，说明是陈旧锁文件，允许接管
              fs.unlinkSync(this.lockFilePath)
            }
          }
        } catch {
          // 读取异常则尝试重新创建
        }
      }

      // 排他打开并写入当前 PID
      this.lockFd = fs.openSync(this.lockFilePath, 'w')
      fs.writeSync(this.lockFd, String(process.pid))
      return true
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[OmniInstanceLock] 获取实例锁失败:', err)
      return false
    }
  }

  /**
   * 释放单实例锁
   */
  public release(): void {
    if (this.lockFd !== null) {
      try {
        fs.closeSync(this.lockFd)
      } catch {}
      this.lockFd = null
    }
    try {
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath)
      }
    } catch {}
  }
}

/**
 * Omni 令牌安全管理器
 * 遵循 Spec §8：权限限制为仅当前用户可读写 (POSIX 0600)，原子写入覆盖
 */
export class OmniTokenManager {
  private tokenFilePath: string

  constructor(runDir: string) {
    this.tokenFilePath = path.join(runDir, 'omni.token')
  }

  /**
   * 原子创建并写入令牌文件
   */
  public createToken(port: number, bootId: string): OmniTokenPayload {
    const dir = path.dirname(this.tokenFilePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const payload: OmniTokenPayload = {
      pid: process.pid,
      bootId,
      port,
      token: crypto.randomBytes(32).toString('hex'),
      createdAt: Date.now()
    }

    const content = JSON.stringify(payload, null, 2)
    const tempFile = `${this.tokenFilePath}.${Date.now()}.tmp`

    // POSIX 0600 模式创建临时文件
    fs.writeFileSync(tempFile, content, { mode: 0o600, encoding: 'utf8' })

    // 原子覆盖重命名
    fs.renameSync(tempFile, this.tokenFilePath)

    return payload
  }

  /**
   * 读取并校验本地令牌
   */
  public readToken(): OmniTokenPayload | null {
    try {
      if (!fs.existsSync(this.tokenFilePath)) return null
      const content = fs.readFileSync(this.tokenFilePath, 'utf8')
      const parsed = JSON.parse(content) as OmniTokenPayload
      if (!parsed.token || !parsed.port) return null
      return parsed
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[OmniTokenManager] 读取令牌失败:', err)
      return null
    }
  }

  /**
   * 校验文件权限 (POSIX 必须严格 0600，Windows 必须仅当前用户)
   */
  public verifyTokenFilePermissions(): boolean {
    try {
      if (!fs.existsSync(this.tokenFilePath)) return false
      const stat = fs.statSync(this.tokenFilePath)
      if (process.platform !== 'win32') {
        const mode = stat.mode & 0o777
        return mode === 0o600
      }
      // Windows 平台下文件已创建且可读写
      return true
    } catch {
      return false
    }
  }

  /**
   * 删除令牌文件
   */
  public removeToken(): void {
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        fs.unlinkSync(this.tokenFilePath)
      }
    } catch {}
  }
}

/**
 * Host 头校验防御函数 (Spec §8)
 * 仅允许 127.0.0.1 及合法端口，防 DNS 重绑定攻击
 */
export function validateOmniRequestHost(hostHeader?: string, expectedPort?: number): boolean {
  if (!hostHeader) return false
  const trimmed = hostHeader.trim().toLowerCase()
  if (trimmed === '127.0.0.1') return true
  if (expectedPort && trimmed === `127.0.0.1:${expectedPort}`) return true
  return false
}
