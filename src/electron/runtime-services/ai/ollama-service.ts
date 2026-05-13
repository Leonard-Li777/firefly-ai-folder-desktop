/**
 * Ollama 服务模块
 * 提供 Ollama 环境的检测、自动安装和模型 management 功能
 */

import { spawn, ChildProcess } from 'child_process'
import fixPath from 'fix-path'
import { shell, dialog, app, clipboard } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { logger, LogCategory } from '@yonuc/shared'
import EventEmitter from 'events'
import { ModelConfigService } from '../analysis/model-config-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { fileDownloadService } from '../system/file-download-service'

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
 * 获取标准化环境变量（强制 UTF-8 并尝试抑制弹窗相关行为）
 */
const getStandardizedEnv = (extraEnv = {}) => ({
  ...process.env,
  // 1. 强制 Python 使用 UTF-8 (解决模型调用常见问题)
  "PYTHONIOENCODING": "utf-8",
  // 2. 强制类 Unix 工具使用 UTF-8
  "LANG": "en_US.UTF-8",
  "LC_ALL": "en_US.UTF-8",
  // 3. 尝试强制 Windows 控制台代码页为 UTF-8
  "CHCP": "65001",
  // 针对 Ollama 的特殊标识
  "OLLAMA_ORIGINS": "*",
  ...extraEnv
});

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
  vramRequiredGB?: number
}

/**
 * Ollama 服务类
 * 单例模式，提供统一的 Ollama 环境管理接口
 */
export class OllamaService extends EventEmitter {
  private static instance: OllamaService | null = null
  private status: OllamaStatus = OllamaStatus.NOT_INSTALLED
  private installProcess: ChildProcess | null = null
  private ollamaVersion: string | null = null
  private ollamaPath: string = 'ollama'
  private pullingModels = new Map<string, { percent: number; message: string }>()

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
   * 获取当前生效的 Ollama 可执行路径
   */
  getWorkingPath(): string {
    return this.ollamaPath
  }

  /**
   * 检测系统中是否存在 Ollama
   */
  async checkInstallation(): Promise<{ installed: boolean; version?: string; error?: string }> {
    try {
      logger.info(LogCategory.AI_SERVICE, '正在检测 Ollama 安装状态...')
      // 1. 首先尝试通过命令行执行 (依赖 PATH)
      const result = await this.tryExecOllama('ollama');
      if (result.installed) {
        this.ollamaPath = 'ollama';
        return result;
      }

      // 2. 如果失败，尝试通过已知常见的安装路径直接检测 (不依赖 PATH)
      const knownPath = this.getOllamaPath();
      if (knownPath) {
        logger.info(LogCategory.AI_SERVICE, `通过已知路径检测到 Ollama: ${knownPath}，正在验证版本...`);
        const pathResult = await this.tryExecOllama(knownPath);
        if (pathResult.installed) {
          this.ollamaPath = knownPath;
          return pathResult;
        }
      }

      logger.info(LogCategory.AI_SERVICE, '未检测到 Ollama 安装。');
      return { installed: false, error: result.error || 'Ollama 未安装' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(LogCategory.AI_SERVICE, '检测 Ollama 安装异常:', error);
      return { installed: false, error: errorMsg };
    }
  }

  /**
   * 尝试通过指定命令/路径执行并获取版本信息
   */
  private async tryExecOllama(cmd: string): Promise<{ installed: boolean; version?: string; error?: string }> {
    return new Promise((resolve) => {
      // 关键修复：对包含空格的路径进行引号包裹，特别是使用 shell: true 时
      const finalCmd = cmd.includes(' ') && !cmd.startsWith('"') ? `"${cmd}"` : cmd;
      
      // 使用 spawn 配合 shell: true 以解决 Windows 路径搜索问题
      const child = spawn(finalCmd, ['--version'], { 
        shell: true,
        windowsHide: true,
        env: getStandardizedEnv()
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout?.on('data', (data) => stdout += data.toString());
      child.stderr?.on('data', (data) => stderr += data.toString());
      
      child.on('close', (code) => {
        const output = (stdout + stderr).trim();
        // 增强正则表达式以支持更多 Ollama 版本输出格式
        const versionMatch = output.match(/(?:version is\s+|ollama\s+version\s+is\s+|v)?([\d.]+)/i);
        
        if (versionMatch) {
          const version = versionMatch[1];
          this.ollamaVersion = version;
          this.status = OllamaStatus.INSTALLED;
          resolve({ installed: true, version });
        } else if (code === 0 && output.length > 0 && output.length < 30) {
          // 如果退出码为 0 且输出较短，即使正则没匹配到也认为是版本号
          this.ollamaVersion = output;
          this.status = OllamaStatus.INSTALLED;
          resolve({ installed: true, version: output });
        } else {
          resolve({ installed: false, error: output || `Exit code: ${code}` });
        }
      });

      child.on('error', (err) => {
        resolve({ installed: false, error: err.message });
      });
    });
  }

  /**
   * 获取 Ollama 可执行文件路径
   */
  getOllamaPath(): string | null {
    switch (process.platform) {
      case 'win32':
        // 优先检查环境变量
        if (process.env.OLLAMA_EXECUTABLE_PATH && fs.existsSync(process.env.OLLAMA_EXECUTABLE_PATH)) {
          return process.env.OLLAMA_EXECUTABLE_PATH
        }

        const windowsPaths = [
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
          path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
          'C:\\Program Files\\Ollama\\ollama.exe',
          'C:\\Program Files (x86)\\Ollama\\ollama.exe',
        ]
        for (const p of windowsPaths) {
          if (fs.existsSync(p)) return p
        }
        return null

      case 'darwin':
        const macPaths = ['/usr/local/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama']
        for (const p of macPaths) {
          if (fs.existsSync(p)) return p
        }
        return null

      case 'linux':
        const linuxPaths = ['/usr/local/bin/ollama', '/usr/bin/ollama']
        for (const p of linuxPaths) {
          if (fs.existsSync(p)) return p
        }
        return null

      default:
        return null
    }
  }

  /**
   * 获取 Ollama 模型存储路径
   */
  getOllamaModelsPath(): string {
    if (process.env.OLLAMA_MODELS) {
      return process.env.OLLAMA_MODELS
    }

    const homeDir = os.homedir()

    switch (process.platform) {
      case 'win32':
        return path.join(homeDir, '.ollama', 'models')
      case 'darwin':
        return path.join(homeDir, '.ollama', 'models')
      case 'linux':
        return '/usr/share/ollama/.ollama/models'
      default:
        return path.join(homeDir, '.ollama', 'models')
    }
  }

  /**
   * 取消安装过程
   */
  async cancelInstall(): Promise<void> {
    logger.info(LogCategory.AI_SERVICE, '正在取消 Ollama 安装...')
    fileDownloadService.cancel('ollama-install')

    if (this.installProcess) {
      try {
        this.installProcess.kill()
        this.installProcess = null
      } catch (err) {
        logger.error(LogCategory.AI_SERVICE, '终止安装进程失败:', err)
      }
    }

    this.status = OllamaStatus.NOT_INSTALLED
    this.emit(OllamaEvent.STATUS_CHANGED, { status: this.status })
    this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '安装已取消' })
  }

  /**
   * 根据平台执行自动安装
   */
  async install(): Promise<boolean> {
    if (this.status === OllamaStatus.INSTALLING) {
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
        if (platform === 'win32' || platform === 'darwin') {
          this.status = OllamaStatus.NOT_INSTALLED
          this.emit(OllamaEvent.STATUS_CHANGED, { status: this.status })
          this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '安装程序已启动，请在弹出窗口中完成安装。完成后请重启本应用。' })
          this.emit(OllamaEvent.INSTALL_COMPLETE, {})
        } else {
          this.status = OllamaStatus.INSTALLED
          this.emit(OllamaEvent.STATUS_CHANGED, { status: this.status })
          this.emit(OllamaEvent.INSTALL_COMPLETE, {})
        }
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
      this.showManualInstallPrompt(errorMsg)
      return false
    }
  }

  /**
   * Windows platform 安装
   */
  private async installOnWindows(): Promise<boolean> {
    this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '正在初始化下载...' })

    const mirror = ConfigOrchestrator.getInstance().getValue<'cn' | 'global'>('DOWNLOAD_MIRROR') || 'cn'
    const downloadUrl = mirror === 'cn'
      ? 'https://cnb.cool/hex/ollama/-/releases/latest/download/OllamaSetup.exe'
      : 'https://ollama.com/download/OllamaSetup.exe'
    
    logger.info(LogCategory.AI_SERVICE, `使用 [${mirror === 'cn' ? '国内加速' : '官方原版'}] 下载 Windows 安装程序`)
    this.emit(OllamaEvent.INSTALL_PROGRESS, { message: `正在启动下载 (${mirror === 'cn' ? '加速源' : '官方源'})...` })

    const tempPath = path.join(os.tmpdir(), 'OllamaSetup.exe')

    const success = await fileDownloadService.download({
      taskId: 'ollama-install',
      url: downloadUrl,
      destPath: tempPath,
      onProgress: (p) => {
        this.emit(OllamaEvent.INSTALL_PROGRESS, { 
          message: `正在下载: ${p.percent}%`,
          percent: p.percent,
          speed: p.speed,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes
        })
      }
    })
    
    if (!success) return false

    this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '下载完成，正在启动安装程序...' })

    return new Promise((resolve) => {
      // 关键修复：对包含空格的路径进行引号包裹，特别是使用 shell: true 时
      const finalPath = tempPath.includes(' ') && !tempPath.startsWith('"') ? `"${tempPath}"` : tempPath;
      
      // 使用 spawn 配合 shell: true 以更好地处理 Windows 路径
      const installProcess = spawn(finalPath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: true,
        env: getStandardizedEnv()
      })
      installProcess.unref()
      resolve(true)
    })
  }

  /**
   * macOS 平台安装
   */
  private async installOnMac(): Promise<boolean> {
    this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '正在初始化下载...' })

    const mirror = ConfigOrchestrator.getInstance().getValue<'cn' | 'global'>('DOWNLOAD_MIRROR') || 'cn'
    const downloadUrl = mirror === 'cn'
      ? 'https://cnb.cool/hex/ollama/-/releases/latest/download/Ollama.dmg'
      : 'https://ollama.com/download/Ollama.dmg'
    
    logger.info(LogCategory.AI_SERVICE, `使用 [${mirror === 'cn' ? '国内加速' : '官方原版'}] 下载 macOS 安装程序`)
    this.emit(OllamaEvent.INSTALL_PROGRESS, { message: `正在启动下载 (${mirror === 'cn' ? '加速源' : '官方源'})...` })

    const tempPath = path.join(os.tmpdir(), 'Ollama.dmg')

    const success = await fileDownloadService.download({
      taskId: 'ollama-install',
      url: downloadUrl,
      destPath: tempPath,
      onProgress: (p) => {
        this.emit(OllamaEvent.INSTALL_PROGRESS, { 
          message: `正在下载: ${p.percent}%`,
          percent: p.percent,
          speed: p.speed,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes
        })
      }
    })
    
    if (!success) return false

    this.emit(OllamaEvent.INSTALL_PROGRESS, { message: '下载完成，正在打开磁盘映像...' })

    return new Promise((resolve) => {
      const installProcess = spawn('open', [tempPath], { 
        stdio: 'ignore', 
        shell: true, 
        windowsHide: true,
        env: getStandardizedEnv()
      })
      installProcess.on('close', (code) => {
        resolve(code === 0)
      })
    })
  }

  /**
   * Linux 平台安装
   */
  private async installOnLinux(): Promise<boolean> {
    const mirror = ConfigOrchestrator.getInstance().getValue<'cn' | 'global'>('DOWNLOAD_MIRROR') || 'cn'
    const installCmd = mirror === 'cn'
      ? 'curl -fsSL https://cnb.cool/hex/ollama/-/git/raw/main/install.sh | sh'
      : 'curl -fsSL https://ollama.com/install.sh | sh'

    logger.info(LogCategory.AI_SERVICE, `使用 [${mirror === 'cn' ? '国内加速' : '官方原版'}] 安装脚本`)
    this.emit(OllamaEvent.INSTALL_PROGRESS, { message: `正在启动安装脚本 (${mirror === 'cn' ? '加速源' : '官方源'})...` })

    return new Promise((resolve) => {
      const installProcess = spawn('pkexec', ['sh', '-c', installCmd], { 
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true, 
        windowsHide: true,
        env: getStandardizedEnv()
      })
      this.installProcess = installProcess
      
      installProcess.stdout?.on('data', (data) => this.emit(OllamaEvent.INSTALL_PROGRESS, { message: data.toString() }))
      installProcess.stderr?.on('data', (data) => this.emit(OllamaEvent.INSTALL_PROGRESS, { message: data.toString() }))

      installProcess.on('close', (code) => {
        this.installProcess = null
        resolve(code === 0)
      })
    })
  }

  private showManualInstallPrompt(error: string): void {
    dialog.showMessageBox({
      type: 'warning',
      title: '安装失败',
      message: '自动安装 Ollama 失败',
      detail: `错误信息: ${error}\n\n请手动下载并安装 Ollama，安装后重启本应用。`,
      buttons: ['打开下载页面', '关闭']
    }).then(({ response }) => {
      if (response === 0) {
        const downloadUrl = process.platform === 'win32' 
          ? 'https://cnb.cool/hex/ollama/-/releases/latest/download/OllamaSetup.exe'
          : process.platform === 'darwin'
            ? 'https://cnb.cool/hex/ollama/-/releases/latest/download/Ollama.dmg'
            : 'https://cnb.cool/hex/ollama/-/git/raw/main/install.sh'
        
        shell.openExternal(downloadUrl).catch((err: any) => {
          logger.error(LogCategory.AI_SERVICE, '手动打开下载页面失败:', err)
          // 尝试将链接复制到剪贴板作为备选方案
          clipboard.writeText(downloadUrl)
          dialog.showErrorBox(
            '无法打开链接',
            `由于系统限制，无法自动打开浏览器。\n\n下载链接已复制到剪贴板，请手动粘贴到浏览器访问：\n${downloadUrl}`
          )
        })
      }
    })
  }

  /**
   * 拉取 Ollama 模型
   */
  async pullModel(modelId: string): Promise<{ success: boolean; error?: string }> {
    // 自动重试机制：如果当前状态是未安装，尝试重新检测一次
    // 解决用户刚刚安装完 Ollama 立即点击下载导致的“状态过时”问题
    if (this.status !== OllamaStatus.INSTALLED) {
      logger.info(LogCategory.AI_SERVICE, '检测到 Ollama 状态为未安装，尝试在下载前重新检测...')
      const checkResult = await this.checkInstallation()
      if (!checkResult.installed) {
        return { success: false, error: 'Ollama 未安装' }
      }
    }

    logger.info(LogCategory.AI_SERVICE, `正在拉取模型: ${modelId}`)
    
    // 发送初始进度
    this.emit(OllamaEvent.MODEL_PROGRESS, { modelId, message: `开始准备下载模型: ${modelId}...` })

    return new Promise((resolve) => {
      // 关键修复：使用检测到的路径并处理空格
      const workingPath = this.getWorkingPath();
      const finalCmd = workingPath.includes(' ') && !workingPath.startsWith('"') ? `"${workingPath}"` : workingPath;

      const pullProcess = spawn(finalCmd, ['pull', modelId], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { 
          ...getStandardizedEnv(),
          "NO_COLOR": "1"
        },
        shell: true,
        windowsHide: true
      })

      let lastError = ''
      const handleData = (data: Buffer) => {
        const rawMessage = data.toString()
        const cleanMessage = rawMessage.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-z]/g, '').trim()
        
        if (!cleanMessage) return

        // 尝试解析百分比 (Ollama 输出通常包含 "XX%")
        const percentMatch = cleanMessage.match(/(\d+)%/)
        const percent = percentMatch ? parseInt(percentMatch[1], 10) : undefined

        // 更新拉取进度缓存
        if (percent !== undefined) {
          this.pullingModels.set(modelId, { percent, message: cleanMessage });
        }

        this.emit(OllamaEvent.MODEL_PROGRESS, { 
          modelId, 
          message: cleanMessage,
          percent 
        })

        // 如果包含 "error"，记录下来
        if (cleanMessage.toLowerCase().includes('error')) {
          lastError = cleanMessage
        }
      }

      pullProcess.stdout?.on('data', handleData)
      pullProcess.stderr?.on('data', handleData)

      pullProcess.on('error', (err) => {
        logger.error(LogCategory.AI_SERVICE, `启动 Ollama 拉取进程失败: ${err.message}`)
        this.pullingModels.delete(modelId);
        resolve({ success: false, error: `启动失败: ${err.message}` })
      })

      pullProcess.on('close', async (code) => {
        if (code === 0) {
          logger.info(LogCategory.AI_SERVICE, `模型拉取进程结束: ${modelId}，开始验证安装状态...`)
          
          // 验证安装状态，最多重试 3 次，给 Ollama 后台同步一点时间
          let isVerified = false;
          for (let i = 0; i < 3; i++) {
            isVerified = await this.checkModelInstalled(modelId);
            if (isVerified) break;
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          this.pullingModels.delete(modelId);
          
          if (isVerified) {
            logger.info(LogCategory.AI_SERVICE, `模型验证成功: ${modelId}`)
            this.emit(OllamaEvent.MODEL_STATUS_CHANGED, { modelId, status: 'downloaded' })
          } else {
            // 即使验证失败（可能是因为 tag 匹配问题），进程 code 0 理论上也是成功的
            logger.warn(LogCategory.AI_SERVICE, `模型拉取进程 code 0 但验证失败: ${modelId}`)
            this.emit(OllamaEvent.MODEL_STATUS_CHANGED, { modelId, status: 'downloaded' })
          }
          resolve({ success: true })
        } else {
          this.pullingModels.delete(modelId);
          const errorMsg = lastError || `进程退出，错误码: ${code}`
          logger.error(LogCategory.AI_SERVICE, `模型拉取失败 [${modelId}]: ${errorMsg}`)
          this.emit(OllamaEvent.MODEL_STATUS_CHANGED, { modelId, status: 'error', error: errorMsg })
          resolve({ success: false, error: errorMsg })
        }
      })
    })
  }

  async checkModelInstalled(modelId: string): Promise<boolean> {
    return new Promise((resolve) => {
      // 关键修复：使用检测到的路径并处理空格
      const workingPath = this.getWorkingPath();
      const finalCmd = workingPath.includes(' ') && !workingPath.startsWith('"') ? `"${workingPath}"` : workingPath;

      const child = spawn(finalCmd, ['list'], { 
        shell: true, 
        windowsHide: true, 
        timeout: 10000,
        env: getStandardizedEnv()
      });
      let stdout = '';
      child.stdout?.on('data', (data) => stdout += data.toString());
      child.on('close', () => {
        const lines = stdout.split('\n').filter(l => l.trim())
        // 关键修复：Ollama list 结果可能包含标签（如 :latest）
        // 我们需要同时检查原始 ID 和带标签的 ID
        const installed = lines.some(line => {
          const name = line.trim().split(/\s+/)[0];
          if (!name) return false;
          
          return name === modelId || 
                 name === `${modelId}:latest` || 
                 (name.includes(':') && name.split(':')[0] === modelId);
        });
        resolve(installed)
      });
      child.on('error', () => resolve(false));
    })
  }

  async listInstalledModels(): Promise<string[]> {
    return new Promise((resolve) => {
      // 关键修复：使用检测到的路径并处理空格
      const workingPath = this.getWorkingPath();
      const finalCmd = workingPath.includes(' ') && !workingPath.startsWith('"') ? `"${workingPath}"` : workingPath;

      const child = spawn(finalCmd, ['list'], { 
        shell: true, 
        windowsHide: true, 
        timeout: 10000,
        env: getStandardizedEnv()
      });
      let stdout = '';
      child.stdout?.on('data', (data) => stdout += data.toString());
      child.on('close', () => {
        const lines = stdout.split('\n')
        // 提取模型名称，并保留原始名称（包含标签）
        const models = lines.slice(1)
          .map(l => l.trim().split(/\s+/)[0])
          .filter(Boolean);
        
        // 同时返回不带标签的基础名称，方便匹配
        const baseModels = models.map(m => m.includes(':') ? m.split(':')[0] : m);
        
        resolve([...new Set([...models, ...baseModels])]);
      });
      child.on('error', () => resolve([]));
    })
  }

  getRecommendedModels(): any[] {
    const language = ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
    return ModelConfigService.getInstance().loadOllamaModelConfig(language)
  }

  /**
   * 获取当前正在拉取的模型进度
   */
  getPullingModels(): Map<string, { percent: number; message: string }> {
    return this.pullingModels;
  }

  async needsOllamaSetup(): Promise<boolean> {
    const { installed } = await this.checkInstallation()
    return !installed
  }
}

export const ollamaService = OllamaService.getInstance()
