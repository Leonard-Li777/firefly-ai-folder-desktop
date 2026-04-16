/**
 * Ollama 服务模块
 * 提供 Ollama 环境的检测、自动安装和模型管理功能
 */

import { spawn, exec } from 'child_process'
import fixPath from 'fix-path'
import { shell, dialog, BrowserWindow, app, clipboard } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { logger, LogCategory } from '@yonuc/shared'
import EventEmitter from 'events'
import { ModelConfigService } from '../analysis/model-config-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in OllamaService:', e);
  }
}

/**
 * Ollama 安装状态
 */
export enum OllamaStatus {
  NOT_INSTALLED = 'not_installed',
  INSTALLING = 'installing',
  INSTALLED = 'installed',
  ERROR = 'error'
}

/**
 * Ollama 事件类型
 */
export enum OllamaEvent {
  STATUS_CHANGED = 'status-changed',
  INSTALL_PROGRESS = 'install-progress',
  INSTALL_COMPLETE = 'install-complete',
  INSTALL_ERROR = 'install-error',
  MODEL_STATUS_CHANGED = 'model-status-changed',
  MODEL_PROGRESS = 'model-progress'
}

/**
 * Ollama 推荐的模型配置
 */
export interface OllamaModelConfig {
  id: string
  name: string
  size: string
  sizeBytes: number
  description: string
  tags: string[]
  isMultiModal: boolean
  minVramGB?: number
}

/**
 * Ollama 服务类
 * 单例模式，提供统一的 Ollama 环境管理接口
 */
export class OllamaService extends EventEmitter {
  private static instance: OllamaService | null = null
  private status: OllamaStatus = OllamaStatus.NOT_INSTALLED
  private installProcess: ReturnType<typeof spawn> | null = null
  private ollamaVersion: string | null = null

  private constructor() {
    super()
  }

  /**
   * 获取单例实例
   */
  static getInstance(): OllamaService {
    if (!OllamaService.instance) {
      OllamaService.instance = new OllamaService()
    }
    return OllamaService.instance
  }

  /**
   * 获取当前安装状态
   */
  getStatus(): OllamaStatus {
    return this.status
  }

  /**
   * 获取 Ollama 版本
   */
  getVersion(): string | null {
    return this.ollamaVersion
  }

  /**
   * 检测 Ollama 是否已安装
   * 通过执行 ollama --version 命令
   */
  async checkInstallation(): Promise<{ installed: boolean; version?: string; error?: string }> {
    try {
      logger.info(LogCategory.AI_SERVICE, '正在检测 Ollama 安装状态...')

      return await new Promise((resolve) => {
        exec('ollama --version', { timeout: 10000 }, (error, stdout, stderr) => {
          // 合并 stdout 和 stderr，因为 Ollama 未启动时版本信息输出在 stderr
          const output = (stdout + stderr).trim()
          
          // 从输出中提取版本号，匹配 "version is X.X.X" 格式
          const versionMatch = output.match(/version is ([\d.]+)/i)
          if (versionMatch) {
            const version = versionMatch[1]
            this.ollamaVersion = version
            this.status = OllamaStatus.INSTALLED
            
            logger.info(LogCategory.AI_SERVICE, `Ollama 已安装，版本: ${version}`)
            resolve({ installed: true, version })
            return
          }

          // 未匹配到版本信息，说明未安装
          const errorMsg = error?.message || output || 'Ollama 未安装'
          logger.info(LogCategory.AI_SERVICE, 'Ollama 未安装:', errorMsg)
          resolve({ installed: false, error: errorMsg })
        })
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.warn(LogCategory.AI_SERVICE, '检测 Ollama 安装失败:', error)
      return { installed: false, error: errorMsg }
    }
  }

  /**
   * 获取 Ollama 可执行文件路径
   */
  getOllamaPath(): string | null {
    // 根据平台返回可能的路径
    switch (process.platform) {
      case 'win32':
        // Windows: 检查常见安装路径
        const windowsPaths = [
          path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
          'C:\\Program Files\\Ollama\\ollama.exe',
          'C:\\Program Files (x86)\\Ollama\\ollama.exe'
        ]
        for (const p of windowsPaths) {
          if (fs.existsSync(p)) return p
        }
        return null

      case 'darwin':
        // macOS
        const macPath = '/usr/local/bin/ollama'
        if (fs.existsSync(macPath)) return macPath
        return null

      case 'linux':
        // Linux
        const linuxPath = '/usr/local/bin/ollama'
        if (fs.existsSync(linuxPath)) return linuxPath
        return null

      default:
        return null
    }
  }

  /**
   * 获取 Ollama 模型存储路径
   */
  getOllamaModelsPath(): string {
    // 1. 优先检查环境变量（用户可能自定义了路径）
    if (process.env.OLLAMA_MODELS) {
      return process.env.OLLAMA_MODELS
    }

    const homeDir = os.homedir()

    // 2. 根据操作系统返回默认路径
    switch (process.platform) {
      case 'win32':
        // Windows 默认路径
        return path.join(homeDir, '.ollama', 'models')

      case 'darwin':
        // macOS 默认路径
        return path.join(homeDir, '.ollama', 'models')

      case 'linux':
        // Linux 默认路径通常在 /usr/share/ollama 或用户目录下
        // 注意：如果是通过 systemd 安装的，通常在 /usr/share/ollama/.ollama/models
        return '/usr/share/ollama/.ollama/models'

      default:
        return path.join(homeDir, '.ollama', 'models')
    }
  }

  /**
   * 根据平台执行自动安装
   */
  async install(): Promise<boolean> {
    if (this.status === OllamaStatus.INSTALLING) {
      logger.warn(LogCategory.AI_SERVICE, 'Ollama 安装已在进行中')
      return true
    }

    this.status = OllamaStatus.INSTALLING
    this.emit(OllamaEvent.STATUS_CHANGED, { status: this.status })

    try {
      const platform = process.platform
      logger.info(LogCategory.AI_SERVICE, `开始安装 Ollama (平台: ${platform})`)

      let success = false

      switch (platform) {
        case 'win32':
          success = await this.installOnWindows()
          break
        case 'darwin':
          success = await this.installOnMac()
          break
        case 'linux':
          success = await this.installOnLinux()
          break
        default:
          throw new Error(`不支持的平台: ${platform}`)
      }

      if (success) {
        this.status = OllamaStatus.INSTALLED
        this.emit(OllamaEvent.STATUS_CHANGED, { status: this.status })
        this.emit(OllamaEvent.INSTALL_COMPLETE, {})
        
        // 不再由后端主动弹出重启提示，改由前端根据 INSTALL_COMPLETE 事件决定处理方式
      } else {
        this.status = OllamaStatus.NOT_INSTALLED
        this.emit(OllamaEvent.STATUS_CHANGED, { status: this.status })
      }

      return success
    } catch (error) {
      this.status = OllamaStatus.ERROR
      const errorMsg = error instanceof Error ? error.message : String(error)
      
      logger.error(LogCategory.AI_SERVICE, 'Ollama 安装失败:', error)
      this.emit(OllamaEvent.INSTALL_ERROR, { error: errorMsg })
      this.emit(OllamaEvent.STATUS_CHANGED, { status: this.status })
      
      // 显示错误并引导用户手动下载
      this.showManualInstallPrompt(errorMsg)
      
      return false
    }
  }

  /**
   * Windows 平台安装
   */
  private async installOnWindows(): Promise<boolean> {
    logger.info(LogCategory.AI_SERVICE, '准备安装 Ollama，正在清理潜在冲突进程...')
    this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '正在检查环境并清理旧进程...' })

    // 尝试杀掉可能存在的冲突进程
    try {
      await new Promise((resolve) => {
        exec('taskkill /F /IM ollama* /T /IM winget* /T', () => {
          // 忽略错误，因为进程可能本身就不存在
          resolve(true)
        })
      })
    } catch (e) {
      // ignore
    }

    logger.info(LogCategory.AI_SERVICE, '使用 WinGet 安装 Ollama...')

    return new Promise((resolve) => {
      // 移除 --silent 参数以显示进度，同时设置 windowsHide: false 允许显示控制台窗口
      const installProcess = spawn('winget', [
        'install', 'Ollama.Ollama', 
        '--accept-package-agreements', 
        '--accept-source-agreements',
        '--force'
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false // 显示窗口，让用户能看到 winget 的原始输出
      })

      this.installProcess = installProcess
      let stdout = ''
      let stderr = ''
      let lastOutputTime = Date.now()

      // 发出初始进度消息
      this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '正在启动 WinGet 安装 Ollama，请稍候...' })

      // 添加定时检查，如果长时间没输出，发送“仍在安装中”的提示，避免用户误认为卡死
      const heartbeatInterval = setInterval(() => {
        const now = Date.now()
        if (now - lastOutputTime > 20000) { // 20秒无响应
          this.emit(OllamaEvent.INSTALL_PROGRESS, { 
            message: '安装正在后台进行中（正在下载或进行系统配置），请耐心等待，这可能需要几分钟...' 
          })
          lastOutputTime = now
        }
      }, 20000)

      installProcess.stdout?.on('data', (data) => {
        const chunk = data.toString()
        process.stdout.write(chunk) // 同步输出到控制台
        stdout += chunk
        lastOutputTime = Date.now()
        this.emit(OllamaEvent.INSTALL_PROGRESS, { message: chunk })
      })

      installProcess.stderr?.on('data', (data) => {
        const chunk = data.toString()
        process.stderr.write(chunk) // 同步输出到控制台
        stderr += chunk
        lastOutputTime = Date.now()
        this.emit(OllamaEvent.INSTALL_PROGRESS, { message: chunk })
      })

      installProcess.on('error', (error) => {
        logger.error(LogCategory.AI_SERVICE, 'WinGet 安装进程错误:', error)
        this.emit(OllamaEvent.INSTALL_PROGRESS, { message: `安装进程错误: ${error.message}` })
      })

      // 设置超时：15分钟 (Ollama 安装包约 600MB，视网络情况可能耗时较长)
      const timeout = setTimeout(() => {
        installProcess.kill()
        logger.warn(LogCategory.AI_SERVICE, 'WinGet 安装超时')
        this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '安装超时，正在尝试备用方案...' })
      }, 15 * 60 * 1000)

      installProcess.on('close', (code) => {
        this.installProcess = null
        clearInterval(heartbeatInterval)
        clearTimeout(timeout)
        
        if (code === 0) {
          logger.info(LogCategory.AI_SERVICE, 'WinGet 安装成功')
          resolve(true)
        } else {
          // 如果 winget 失败，尝试其他方法
          logger.warn(LogCategory.AI_SERVICE, `WinGet 安装失败，退出码: ${code}，尝试备用方案...`)
          
          // 备用方案：直接下载安装
          this.fallbackInstallWindows().then(resolve).catch(() => {
            resolve(false)
          })
        }
      })
    })
  }

  /**
   * Windows 备用安装方案
   */
  private async fallbackInstallWindows(): Promise<boolean> {
    // 显示手动安装提示
    dialog.showMessageBox({
      type: 'info',
      title: '安装 Ollama',
      message: '自动安装失败',
      detail: '请手动下载并安装 Ollama，然后重启本应用。\n\n点击"确定"将打开 Ollama 官网下载页面。',
      buttons: ['确定', '取消']
    }).then(({ response }) => {
      if (response === 0) {
        shell.openExternal('https://ollama.com/download')
      }
    })
    
    return false
  }

  /**
   * macOS 平台安装
   */
  private async installOnMac(): Promise<boolean> {
    logger.info(LogCategory.AI_SERVICE, '使用 Homebrew 安装 Ollama...')

    return new Promise((resolve) => {
      // 检查是否安装了 Homebrew
      exec('which brew', (brewError) => {
        if (brewError) {
          logger.warn(LogCategory.AI_SERVICE, '未检测到 Homebrew，显示手动安装提示')
          this.showManualInstallPrompt('未安装 Homebrew')
          resolve(false)
          return
        }

        const installProcess = spawn('brew', ['install', 'ollama'], {
          stdio: ['ignore', 'pipe', 'pipe']
        })

        this.installProcess = installProcess
        let lastOutputTime = Date.now()

        // 发出初始进度消息
        this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '正在通过 Homebrew 安装 Ollama，请稍候...' })

        // 添加心跳进度提示
        const heartbeatInterval = setInterval(() => {
          const now = Date.now()
          if (now - lastOutputTime > 20000) {
            this.emit(OllamaEvent.INSTALL_PROGRESS, { 
              message: 'Homebrew 正在后台安装中，请耐心等待...' 
            })
            lastOutputTime = now
          }
        }, 20000)

        installProcess.stdout?.on('data', (data) => {
          process.stdout.write(data) // 同步输出到控制台
          lastOutputTime = Date.now()
          this.emit(OllamaEvent.INSTALL_PROGRESS, { message: data.toString() })
        })

        installProcess.stderr?.on('data', (data) => {
          process.stderr.write(data) // 同步输出到控制台
          lastOutputTime = Date.now()
          this.emit(OllamaEvent.INSTALL_PROGRESS, { message: data.toString() })
        })

        // 设置超时：15分钟
        const timeout = setTimeout(() => {
          installProcess.kill()
          logger.warn(LogCategory.AI_SERVICE, 'Homebrew 安装超时')
        }, 15 * 60 * 1000)

        installProcess.on('close', (code) => {
          this.installProcess = null
          clearInterval(heartbeatInterval)
          clearTimeout(timeout)
          
          if (code === 0) {
            logger.info(LogCategory.AI_SERVICE, 'Homebrew 安装成功')
            resolve(true)
          } else {
            logger.error(LogCategory.AI_SERVICE, `Homebrew 安装失败，退出码: ${code}`)
            this.showManualInstallPrompt(`安装失败，退出码: ${code}`)
            resolve(false)
          }
        })
      })
    })
  }

  /**
   * Linux 平台安装
   */
  private async installOnLinux(): Promise<boolean> {
    logger.info(LogCategory.AI_SERVICE, '使用官方脚本安装 Ollama (通过 pkexec)...')

    return new Promise((resolve) => {
      // 使用 pkexec 运行官方安装脚本，以获取图形化密码提示
      const installCmd = 'curl -fsSL https://ollama.com/install.sh | sh'

      const installProcess = spawn('pkexec', ['sh', '-c', installCmd], {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      // 标志位：是否检测到文本模式的密码请求
      let detectedTextAuth = false
      let stderrBuffer = '' // 用于累积 stderr 输出，防止关键字被截断

      // 辅助函数：去除 ANSI 转义码
      const stripAnsi = (str: string) => {
        return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
      }
      this.installProcess = installProcess
      let lastOutputTime = Date.now()

      // 发出初始进度消息
      this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '系统正在请求安装权限，请在弹出的对话框中输入密码...' })

      // 添加心跳进度提示
      const heartbeatInterval = setInterval(() => {
        const now = Date.now()
        if (now - lastOutputTime > 20000) {
          this.emit(OllamaEvent.INSTALL_PROGRESS, { 
            message: '安装正在后台进行中，请确保已在授权对话框中输入密码...' 
          })
          lastOutputTime = now
        }
      }, 20000)

      installProcess.stdout?.on('data', (data) => {
        process.stdout.write(data) // 同步输出到控制台
        lastOutputTime = Date.now()
        this.emit(OllamaEvent.INSTALL_PROGRESS, { message: data.toString() })
      })

      installProcess.stderr?.on('data', (data) => {
        const chunk = data.toString()
        process.stderr.write(data) // 同步输出到控制台
        this.emit(OllamaEvent.INSTALL_PROGRESS, { message: chunk })
        const message = data.toString()
        lastOutputTime = Date.now()
        this.emit(OllamaEvent.INSTALL_PROGRESS, { message })
        
        // 累积缓冲区并去除 ANSI 码
        stderrBuffer += chunk
        const cleanChunk = stripAnsi(chunk)
        const cleanTotal = stripAnsi(stderrBuffer)
        
        logger.debug(LogCategory.AI_SERVICE, `pkexec stderr chunk (clean): ${JSON.stringify(cleanChunk)}`)

        // 检测是否需要管理员权限
        if (cleanChunk.includes('pkexec') || cleanChunk.includes('permission')) {
          logger.info(LogCategory.AI_SERVICE, '安装脚本请求管理员权限')
        }

        // 检测是否回退到了文本模式的密码输入
        // 只要出现这些特征字符，就说明 pkexec 正在尝试在终端进行交互式认证
        const keywords = [
          'Password:',
          'Authentication is needed',
          'AUTHENTICATING FOR',
          'Authenticating as'
        ]

        if (keywords.some(k => cleanTotal.includes(k) || cleanChunk.includes(k))) {
          if (!detectedTextAuth) { // 只触发一次
            logger.warn(LogCategory.AI_SERVICE, '检测到文本模式认证请求，正在终止进程...')
            detectedTextAuth = true
            try {
              installProcess.kill('SIGKILL')
              logger.info(LogCategory.AI_SERVICE, '已发送 SIGKILL 信号')
            } catch (e) {
              logger.error(LogCategory.AI_SERVICE, '终止进程失败:', e)
            }
          }
        }
      })

      // 设置超时：15分钟
      const timeout = setTimeout(() => {
        installProcess.kill()
        logger.warn(LogCategory.AI_SERVICE, '安装脚本超时')
      }, 15 * 60 * 1000)

      installProcess.on('close', (code) => {
        this.installProcess = null
        clearInterval(heartbeatInterval)
        clearTimeout(timeout)
        
        if (code === 0) {
          logger.info(LogCategory.AI_SERVICE, '安装脚本执行成功')
          resolve(true)
        } else {
          logger.error(LogCategory.AI_SERVICE, `安装脚本失败，退出码: ${code}`)
          
          // 如果是因为检测到文本认证而终止，或者其他非正常退出
          if (detectedTextAuth || code === null || code === 1) {
             this.showLinuxManualInstallPrompt()
          } else {
             this.showManualInstallPrompt(`安装失败，退出码: ${code}`)
          }
          resolve(false)
        }
      })

      installProcess.on('error', (error) => {
        logger.error(LogCategory.AI_SERVICE, '安装进程错误:', error)
        this.installProcess = null
        clearInterval(heartbeatInterval)
        clearTimeout(timeout)
        resolve(false)
      })
    })
  }

  /**
   * 显示 Linux 手动安装提示（带复制命令功能）
   */
  private showLinuxManualInstallPrompt(): void {
    const command = 'curl -fsSL https://ollama.com/install.sh | sh'
    
    dialog.showMessageBox({
      type: 'warning',
      title: '需要手动安装',
      message: '无法弹出管理员密码输入框',
      detail: '您的系统环境不支持图形化提权（如 WSL 或无桌面环境）。\n\n请点击“复制命令”，然后在终端中粘贴并运行以完成安装。',
      buttons: ['复制命令', '关闭'],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) {
        clipboard.writeText(command)
        dialog.showMessageBox({
          type: 'info',
          title: '已复制',
          message: '安装命令已复制到剪贴板',
          detail: '请打开终端 (Terminal)，粘贴并运行该命令。'
        })
      }
    })
  }

  /**
   * 显示手动安装提示
   */
  private showManualInstallPrompt(error: string): void {
    dialog.showMessageBox({
      type: 'warning',
      title: '安装失败',
      message: '自动安装 Ollama 失败',
      detail: `错误信息: ${error}

请手动下载并安装 Ollama，安装后重启本应用。

点击"确定"将打开 Ollama 官网。`,
      buttons: ['打开官网', '关闭']
    }).then(({ response }) => {
      if (response === 0) {
        shell.openExternal('https://ollama.com/')
      }
    })
  }

  /**
   * 拉取 Ollama 模型
   */
  async pullModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    if (this.status !== OllamaStatus.INSTALLED) {
      return { success: false, error: 'Ollama 未安装' }
    }

    logger.info(LogCategory.AI_SERVICE, `正在拉取模型: ${modelId}`)
    
    // 发送初始进度
    this.emit(OllamaEvent.MODEL_PROGRESS, { modelId, message: `开始准备下载模型: ${modelId}...` })

    return new Promise((resolve) => {
      // 增加交互式环境变量，有时可以强制 Ollama 输出更多进度信息
      const pullProcess = spawn('ollama', ['pull', modelId], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, "NO_COLOR": "1" } // 尝试请求非彩色输出(更易处理)
      })

      let lastMessage = ''
      
      const extractPercent = (str: string): number | undefined => {
        const match = str.match(/(\d+)%/)
        if (match) {
          return parseInt(match[1], 10)
        }
        return undefined
      }

      const handleData = (data: Buffer) => {
        // 清理 ANSI 控制字符 (Ollama 使用这些字符在终端画进度条)
        // 这一步非常重要，否则前端会显示乱码
        const rawMessage = data.toString()
        const cleanMessage = rawMessage
          .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-z]/g, '')
          .replace(/\r/g, '\n') // 将回车换为换行
          .trim()

        if (cleanMessage && cleanMessage !== lastMessage) {
          lastMessage = cleanMessage
          const percent = extractPercent(cleanMessage)
          
          // 实时推送到前端
          this.emit(OllamaEvent.MODEL_PROGRESS, { 
            modelId, 
            message: cleanMessage,
            percent
          })
          logger.debug(LogCategory.AI_SERVICE, `[${modelId}] ${cleanMessage}`)
        }
      }

      pullProcess.stdout?.on('data', handleData)
      pullProcess.stderr?.on('data', handleData)

      pullProcess.on('close', (code) => {
        if (code === 0) {
          logger.info(LogCategory.AI_SERVICE, `模型 ${modelId} 拉取成功`)
          this.emit(OllamaEvent.MODEL_STATUS_CHANGED, { modelId, status: 'downloaded' })
          this.emit(OllamaEvent.MODEL_PROGRESS, { modelId, message: '完成下载！' })
          resolve({ success: true })
        } else {
          const error = `拉取失败，退出码: ${code}`
          logger.error(LogCategory.AI_SERVICE, error)
          this.emit(OllamaEvent.MODEL_STATUS_CHANGED, { modelId, status: 'error' })
          resolve({ success: false, error })
        }
      })

      pullProcess.on('error', (error) => {
        const errorMsg = error.message
        logger.error(LogCategory.AI_SERVICE, `拉取模型失败: ${errorMsg}`)
        this.emit(OllamaEvent.MODEL_PROGRESS, { modelId, message: `下载遇到错误: ${errorMsg}` })
        resolve({ success: false, error: errorMsg })
      })
    })
  }

  /**
   * 检查模型是否已安装
   */
  async checkModelInstalled(modelId: string): Promise<boolean> {
    if (this.status !== OllamaStatus.INSTALLED) {
      const checkResult = await this.checkInstallation()
      if (!checkResult.installed) {
        return false
      }
    }

    return new Promise((resolve) => {
      exec(`ollama list`, { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve(false)
          return
        }

        // 检查输出中是否包含目标模型
        const lines = stdout.toString().split('\n').filter(l => l.trim())
        // 跳过表头
        if (lines.length > 0 && lines[0].includes('NAME') && lines[0].includes('ID')) {
          lines.shift()
        }

        const installed = lines.some(line => {
          const parts = line.trim().split(/\s+/)
          if (parts.length === 0 || !parts[0]) return false
          
          const fullName = parts[0]
          
          // 场景1：完全匹配 (如 "llama2-uncensored" === "llama2-uncensored")
          if (fullName === modelId) return true
          
          // 场景2：包含默认标签 (如 "llama2-uncensored:latest" matches "llama2-uncensored")
          if (!modelId.includes(':') && fullName === `${modelId}:latest`) return true
          
          return false
        })
        
        resolve(installed)
      })
    })
  }

  /**
   * 获取已安装的模型列表
   */
  async listInstalledModels(): Promise<string[]> {
    if (this.status !== OllamaStatus.INSTALLED) {
      return []
    }

    return new Promise((resolve) => {
      exec('ollama list', { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve([])
          return
        }

        const lines = stdout.toString().split('\n')
        const models: string[] = []
        
        for (const line of lines) {
          const parts = line.trim().split(/\s+/)
          if (parts.length > 0 && parts[0]) {
            models.push(parts[0])
          }
        }

        resolve(models)
      })
    })
  }

  /**
   * 获取推荐的模型配置列表
   */
  getRecommendedModels(): any[] {
    const language = ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
    // Explicitly load Ollama models regardless of current platform setting
    const models = ModelConfigService.getInstance().loadOllamaModelConfig(language)
    
    return models
  }

  /**
   * 检查应用启动时是否需要引导安装 Ollama
   * 返回 true 表示需要显示安装引导
   */
  async needsOllamaSetup(): Promise<boolean> {
    const { installed } = await this.checkInstallation()
    return !installed
  }
}

// 导出便捷函数
export const ollamaService = OllamaService.getInstance()
