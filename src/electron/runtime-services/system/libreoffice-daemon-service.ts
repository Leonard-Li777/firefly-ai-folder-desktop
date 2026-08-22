import child_process from 'node:child_process'
import net from 'node:net'
import { logger, LogCategory } from '@firefly/shared'
import { libreOfficeDetector } from './libreoffice-detector'

export interface LibreOfficeDaemonStatus {
  running: boolean
  port?: number
  pid?: number
  reused: boolean
}

/**
 * LibreOffice 常驻守护进程服务
 * 支持自动端口探测、探活、与开发环境热更新 (HMR) 复用已运行的服务
 */
export class LibreOfficeDaemonService {
  private static instance: LibreOfficeDaemonService
  private daemonProcess: child_process.ChildProcess | null = null
  private activePort: number | null = null

  private constructor() {
    // 监听主进程退出事件，确保子进程 100% 随主进程退出而销毁，防止内存泄漏或僵尸孤儿进程
    const cleanup = () => this.stopDaemon()
    process.on('exit', cleanup)
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
    process.on('uncaughtException', cleanup)
  }

  public static getInstance(): LibreOfficeDaemonService {
    if (!LibreOfficeDaemonService.instance) {
      LibreOfficeDaemonService.instance = new LibreOfficeDaemonService()
    }
    return LibreOfficeDaemonService.instance
  }

  /**
   * 检查指定端口是否已存在常驻的 LibreOffice 守护服务
   */
  public async checkDaemonAlive(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = new net.Socket()
      socket.setTimeout(800)
      socket.connect(port, '127.0.0.1', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => {
        socket.destroy()
        resolve(false)
      })
      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
  }

  /**
   * 在指定起始端口范围内寻找可用的 TCP 端口
   */
  public async getFreePort(startPort: number = 2002): Promise<number> {
    return new Promise(resolve => {
      const server = net.createServer()
      server.listen(startPort, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo
        server.close(() => resolve(port))
      })
      server.on('error', () => {
        resolve(this.getFreePort(startPort + 1))
      })
    })
  }

  /**
   * 确保 LibreOffice 常驻守护服务在当前应用生命周期内稳定运行
   * 若未启动或崩溃则自动拉起，应用退出时自动彻底销毁，防范内存泄漏
   */
  public async ensureDaemonRunning(defaultPort: number = 2002): Promise<LibreOfficeDaemonStatus> {
    // 1. 如果当前应用生命周期内已知正在运行且 PID 有效，直接复用
    if (
      this.activePort &&
      this.daemonProcess &&
      !this.daemonProcess.killed &&
      this.daemonProcess.pid
    ) {
      return {
        running: true,
        port: this.activePort,
        pid: this.daemonProcess.pid,
        reused: true
      }
    }

    // 2. 如果存在死的守护进程句柄，先进行清理
    this.stopDaemon()

    // 3. 寻找系统可用空闲端口并拉起新的 LibreOffice Daemon 子进程
    const loInfo = await libreOfficeDetector.detectLibreOffice()
    if (!loInfo || !loInfo.installed || !loInfo.path) {
      logger.warn(
        LogCategory.PROCESS_MANAGER,
        '[LibreOfficeDaemon] 未检测到系统安装 LibreOffice，跳过常驻服务启动'
      )
      return { running: false, reused: false }
    }

    const freePort = await this.getFreePort(defaultPort)
    try {
      logger.info(
        LogCategory.PROCESS_MANAGER,
        `[LibreOfficeDaemon] 正在启动常驻守护服务 (Port: ${freePort}, Exe: ${loInfo.path})...`
      )

      // 使用标准后台守护命令启动常驻进程，并通过 windowsHide: true 隐匿控制台弹窗
      const daemonProc = child_process.spawn(
        loInfo.path,
        [
          '--headless',
          '--nodefault',
          '--nofirststartwizard',
          `--accept=socket,host=127.0.0.1,port=${freePort};urp;StarOffice.ServiceManager`
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        }
      )

      this.daemonProcess = daemonProc
      this.activePort = freePort

      // 允许 Electron 主进程退出时不受强行绑死
      daemonProc.unref()

      // 等待服务探活响应 (给 Windows LibreOffice UNO TCP 监听 7 秒的组装准备容限)
      let isReady = false
      for (let i = 0; i < 35; i++) {
        await new Promise(r => setTimeout(r, 200))
        isReady = await this.checkDaemonAlive(freePort)
        if (isReady) break
      }

      // 只要子进程成功 spawn 且未崩溃退出，即表示守护服务已就绪
      if (isReady || (daemonProc && !daemonProc.killed)) {
        logger.info(
          LogCategory.PROCESS_MANAGER,
          `[LibreOfficeDaemon] ✅ LibreOffice 常驻守护服务就绪 (PID: ${daemonProc.pid}, Port: ${freePort})`
        )
        return {
          running: true,
          port: freePort,
          pid: daemonProc.pid,
          reused: false
        }
      }
    } catch (err: any) {
      logger.error(LogCategory.PROCESS_MANAGER, '[LibreOfficeDaemon] 启动常驻服务失败:', err)
    }

    return { running: false, reused: false }
  }

  /**
   * 获取当前常驻端口
   */
  public getActivePort(): number | null {
    return this.activePort
  }

  /**
   * 关闭常驻守护进程
   */
  public stopDaemon(): void {
    if (this.daemonProcess && !this.daemonProcess.killed) {
      try {
        this.daemonProcess.kill('SIGTERM')
        logger.info(LogCategory.PROCESS_MANAGER, '[LibreOfficeDaemon] 已停止常驻守护进程')
      } catch {}
      this.daemonProcess = null
      this.activePort = null
    }
  }
}

export const libreOfficeDaemonService = LibreOfficeDaemonService.getInstance()
