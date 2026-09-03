import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { spawnSync } from 'child_process'
import { logger, LogCategory } from '@firefly/shared'

interface PidRecord {
  pid: number
  name: string
  createdAt: number
}

/**
 * 全局进程守护与精准防孤儿清理器 (ProcessReaper)
 * 负责记录本 worktree 实例名下的子进程 PID，并在退出/启动前定向清理，杜绝孤儿进程与跨 worktree 误杀
 */
export class ProcessReaper {
  private static instance: ProcessReaper
  private pids: Map<number, PidRecord> = new Map()
  private lockFilePath = ''
  private isCleanedUp = false

  private constructor() {
    try {
      const userData = app.getPath('userData')
      this.lockFilePath = path.join(userData, 'runtime-pids.json')
      this.loadExistingPids()
      this.registerExitHooks()
    } catch (err) {
      // ignore in test
    }
  }

  public static getInstance(): ProcessReaper {
    if (!ProcessReaper.instance) {
      ProcessReaper.instance = new ProcessReaper()
    }
    return ProcessReaper.instance
  }

  /**
   * 注册受保护的子进程 PID
   */
  public registerChild(pid: number | undefined, name: string): void {
    if (!pid || pid <= 0) return
    this.pids.set(pid, {
      pid,
      name,
      createdAt: Date.now()
    })
    this.persistPids()
    logger.info(LogCategory.SYSTEM, `[ProcessReaper] 已登记子进程: ${name} (PID: ${pid})`)
  }

  /**
   * 注销已正常退出的子进程
   */
  public unregisterChild(pid: number | undefined): void {
    if (!pid) return
    if (this.pids.delete(pid)) {
      this.persistPids()
    }
  }

  /**
   * 清理属于本 Worktree 实例的所有子进程
   */
  public cleanup(): void {
    if (this.isCleanedUp) return
    this.isCleanedUp = true

    logger.info(LogCategory.SYSTEM, '[ProcessReaper] 正在执行子进程资源回收...')

    for (const [pid, record] of this.pids.entries()) {
      this.killPid(pid, record.name)
    }
    this.pids.clear()
    this.persistPids()
  }

  /**
   * 启动前回收本 Worktree 历史遗留的僵尸子进程
   */
  public cleanupStaleProcesses(): void {
    if (!this.lockFilePath || !fs.existsSync(this.lockFilePath)) return
    try {
      const content = fs.readFileSync(this.lockFilePath, 'utf-8')
      const records: PidRecord[] = JSON.parse(content)
      if (Array.isArray(records) && records.length > 0) {
        logger.info(
          LogCategory.SYSTEM,
          `[ProcessReaper] 发现上一次异常退出遗留的 ${records.length} 个子进程，正在定向清理...`
        )
        for (const record of records) {
          this.killPid(record.pid, record.name)
        }
      }
      fs.writeFileSync(this.lockFilePath, '[]', 'utf-8')
    } catch {}
  }

  private killPid(pid: number, name: string): void {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } else {
        process.kill(pid, 'SIGKILL')
      }
      logger.info(LogCategory.SYSTEM, `[ProcessReaper] ✅ 已销毁遗留子进程: ${name} (PID: ${pid})`)
    } catch {
      // 进程可能已经退出，静默忽略
    }
  }

  private loadExistingPids(): void {
    if (!this.lockFilePath || !fs.existsSync(this.lockFilePath)) return
    try {
      const content = fs.readFileSync(this.lockFilePath, 'utf-8')
      const records: PidRecord[] = JSON.parse(content)
      if (Array.isArray(records)) {
        for (const r of records) {
          this.pids.set(r.pid, r)
        }
      }
    } catch {}
  }

  private persistPids(): void {
    if (!this.lockFilePath) return
    try {
      const records = Array.from(this.pids.values())
      fs.writeFileSync(this.lockFilePath, JSON.stringify(records, null, 2), 'utf-8')
    } catch {}
  }

  private registerExitHooks(): void {
    const onExit = () => {
      this.cleanup()
    }

    process.once('exit', onExit)
    process.once('SIGINT', onExit)
    process.once('SIGTERM', onExit)
    process.once('SIGHUP', onExit)

    app.once('before-quit', onExit)
    app.once('will-quit', onExit)
  }
}

export const processReaper = ProcessReaper.getInstance()