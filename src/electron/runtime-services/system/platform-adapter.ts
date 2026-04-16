/**
 * Platform Adapter - 跨平台适配器服务
 * 处理不同平台的文件路径、权限和性能优化差异
 */

import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import fixPath from 'fix-path';
import { logger, LogCategory } from '@yonuc/shared';
import {
  TPlatform,
  TArchitecture,
  THardwareAcceleration
} from '@yonuc/types/llama-server';

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    // 兼容 ESM 导出：如果 fixPath 是对象则取其 default 属性
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH:', e);
  }
}

const execAsync = promisify(exec);

/**
 * Platform Adapter Configuration
 * Injected from the main process to provide additional runtime functionality
 */
export interface PlatformAdapterConfig {
  openPath?: (path: string) => Promise<void>;
  quit?: () => void;
  exit?: (code: number) => void;
}

/**
 * 平台特定配置接口
 */
export interface IPlatformConfig {
  /** 平台类型 */
  platform: TPlatform;
  /** 架构类型 */
  architecture: TArchitecture;
  /** 路径分隔符 */
  pathSeparator: string;
  /** 可执行文件扩展名 */
  executableExtension: string;
  /** 支持的硬件加速类型 */
  supportedAccelerations: THardwareAcceleration[];
  /** 默认权限模式 */
  defaultPermissions: number;
  /** 是否需要权限管理 */
  requiresPermissionManagement: boolean;
  /** 系统特定的优化参数 */
  optimizations: IPlatformOptimizations;
}

/**
 * 平台优化配置接口
 */
export interface IPlatformOptimizations {
  /** 推荐的线程数倍数 */
  threadMultiplier: number;
  /** 内存使用倍数 */
  memoryMultiplier: number;
  /** I/O缓冲区大小 */
  ioBufferSize: number;
  /** 网络超时时间 */
  networkTimeout: number;
  /** 进程优先级 */
  processPriority: 'low' | 'normal' | 'high';
  /** 是否启用大页内存 */
  enableLargePages: boolean;
  /** 是否启用NUMA优化 */
  enableNUMAOptimization: boolean;
}

/**
 * 路径处理结果接口
 */
export interface IPathProcessingResult {
  /** 标准化后的路径 */
  normalizedPath: string;
  /** 是否为绝对路径 */
  isAbsolute: boolean;
  /** 路径组件 */
  components: string[];
  /** 文件名（如果是文件路径） */
  filename?: string;
  /** 文件扩展名 */
  extension?: string;
  /** 是否为可执行文件 */
  isExecutable: boolean;
}

/**
 * 跨平台适配器服务
 */
export class PlatformAdapter {
  private platformConfig: IPlatformConfig;
  private static instance: PlatformAdapter;
  private config: PlatformAdapterConfig = {};
  private userDataPath: string;
  private appPath: string;
  private resourcesPath: string;
  private isPackaged: boolean;

  constructor() {
    this.platformConfig = this.detectPlatformConfig();
    
    // 直接使用 Electron app API 获取路径信息
    this.userDataPath = app.getPath('userData');
    this.appPath = app.getAppPath();
    this.resourcesPath = process.resourcesPath;
    this.isPackaged = app.isPackaged;
    
    if (logger) {
      logger.info(LogCategory.PLATFORM_ADAPTER, 'PlatformAdapter 已创建', {
        platform: this.platformConfig.platform,
        isPackaged: this.isPackaged,
        userDataPath: this.userDataPath
      });
    }
  }

  /**
   * 获取单例实例
   */
  static getInstance(): PlatformAdapter {
    if (!PlatformAdapter.instance) {
      PlatformAdapter.instance = new PlatformAdapter();
    }
    return PlatformAdapter.instance;
  }

  /**
   * Initialize the adapter with additional runtime configuration (optional)
   */
  initialize(config?: PlatformAdapterConfig) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    logger.info(LogCategory.PLATFORM_ADAPTER, 'PlatformAdapter 已初始化额外配置', {
      hasOpenPath: !!this.config.openPath,
      hasQuit: !!this.config.quit,
      hasExit: !!this.config.exit
    });
  }

  /**
   * 检测平台配置
   */
  private detectPlatformConfig(): IPlatformConfig {
    const platform = process.platform as TPlatform;
    const architecture = process.arch as TArchitecture;

    switch (platform) {
      case 'win32':
        return {
          platform,
          architecture,
          pathSeparator: '\\',
          executableExtension: '.exe',
          supportedAccelerations: ['cuda', 'vulkan', 'cpu'],
          defaultPermissions: 0o755, // 虽然Windows不使用，但保持一致性
          requiresPermissionManagement: false,
          optimizations: {
            threadMultiplier: 1.0,
            memoryMultiplier: 1.0,
            ioBufferSize: 65536,
            networkTimeout: 30000,
            processPriority: 'normal',
            enableLargePages: true,
            enableNUMAOptimization: true
          }
        };

      case 'darwin':
        return {
          platform,
          architecture,
          pathSeparator: '/',
          executableExtension: '',
          supportedAccelerations: ['cpu'], // macOS主要使用Metal，但llama-server通常是CPU
          defaultPermissions: 0o755,
          requiresPermissionManagement: true,
          optimizations: {
            threadMultiplier: 0.8, // macOS对多线程的调度较保守
            memoryMultiplier: 0.9, // 为系统保留更多内存
            ioBufferSize: 32768,
            networkTimeout: 25000,
            processPriority: 'normal',
            enableLargePages: false, // macOS不支持用户空间大页
            enableNUMAOptimization: false // macOS通常是UMA架构
          }
        };

      case 'linux':
        return {
          platform,
          architecture,
          pathSeparator: '/',
          executableExtension: '',
          supportedAccelerations: ['cuda', 'vulkan', 'cpu'],
          defaultPermissions: 0o755,
          requiresPermissionManagement: true,
          optimizations: {
            threadMultiplier: 1.2, // Linux对多线程支持较好
            memoryMultiplier: 1.1,
            ioBufferSize: 4072,
            networkTimeout: 30000,
            processPriority: 'normal',
            enableLargePages: true,
            enableNUMAOptimization: true
          }
        };

      default:
        throw new Error(`不支持的平台: ${platform}`);
    }
  }

  /**
   * 获取平台配置
   */
  getPlatformConfig(): IPlatformConfig {
    return { ...this.platformConfig };
  }

  /**
   * 标准化文件路径
   */
  normalizePath(inputPath: string): string {
    // 使用Node.js的path.normalize处理跨平台路径
    let normalizedPath = path.normalize(inputPath);
    
    // 在Windows上，确保使用正确的路径分隔符
    if (this.platformConfig.platform === 'win32') {
      normalizedPath = normalizedPath.replace(/\//g, '\\');
    } else {
      normalizedPath = normalizedPath.replace(/\\/g, '/');
    }
    
    return normalizedPath;
  }

  /**
   * 处理路径信息
   */
  processPath(inputPath: string): IPathProcessingResult {
    const normalizedPath = this.normalizePath(inputPath);
    const isAbsolute = path.isAbsolute(normalizedPath);
    const components = normalizedPath.split(this.platformConfig.pathSeparator).filter(Boolean);
    
    const filename = path.basename(normalizedPath);
    const extension = path.extname(normalizedPath);
    
    // 判断是否为可执行文件
    let isExecutable = false;
    if (this.platformConfig.platform === 'win32') {
      isExecutable = extension.toLowerCase() === '.exe';
    } else {
      // Unix系统上，无扩展名的文件可能是可执行文件
      isExecutable = extension === '' && filename !== '' && !filename.includes('.');
    }
    
    return {
      normalizedPath,
      isAbsolute,
      components,
      filename: filename || undefined,
      extension: extension || undefined,
      isExecutable
    };
  }

  /**
   * 构建平台特定的可执行文件路径
   */
  buildExecutablePath(basePath: string, executableName: string): string {
    const fullName = executableName + this.platformConfig.executableExtension;
    return this.normalizePath(path.join(basePath, fullName));
  }

  /**
   * 获取应用数据目录
   */
  getAppDataPath(): string {
    return this.normalizePath(this.userDataPath);
  }

  /**
   * 获取临时目录
   */
  getTempPath(): string {
    return this.normalizePath(os.tmpdir());
  }

  /**
   * 获取用户主目录
   */
  getHomePath(): string {
    return this.normalizePath(os.homedir());
  }

  /**
   * 获取extraResources目录路径
   */
  getExtraResourcesPath(): string {
    if (this.isPackaged) {
      // 注意：在打包模式下，forge.config.ts 的 extraResource 配置会将 build/extraResources/* 的内容
      // 直接复制到 resources/ 根目录，而不是 resources/extraResources/ 子目录
      return this.normalizePath(this.resourcesPath);
    } else {
      // 在开发模式下，直接进入 build/extraResources
      return this.normalizePath(path.join(this.appPath, 'build/extraResources'));
    }
  }

  /**
   * 获取平台特定的二进制文件目录
   */
  getBinaryDirectory(binaryName: string): string {
    const extraResourcesPath = this.getExtraResourcesPath();
    return this.normalizePath(path.join(extraResourcesPath, 'llama', binaryName));
  }

  /**
   * 获取推荐的线程数
   */
  getRecommendedThreadCount(): number {
    const cpuCount = os.cpus().length;
    const multiplier = this.platformConfig.optimizations.threadMultiplier;
    return Math.max(1, Math.floor(cpuCount * multiplier));
  }

  /**
   * 获取推荐的内存限制
   */
  getRecommendedMemoryLimit(): number {
    const totalMemory = os.totalmem();
    const multiplier = this.platformConfig.optimizations.memoryMultiplier;
    return Math.floor(totalMemory * multiplier);
  }

  /**
   * 获取平台特定的环境变量
   */
  getPlatformEnvironmentVariables(): Record<string, string> {
    const env: Record<string, string> = {};
    
    switch (this.platformConfig.platform) {
      case 'win32':
        // Windows特定环境变量
        env['CUDA_VISIBLE_DEVICES'] = '0'; // 默认使用第一个GPU
        env['OMP_NUM_THREADS'] = this.getRecommendedThreadCount().toString();
        break;
        
      case 'darwin':
        // macOS特定环境变量
        env['OMP_NUM_THREADS'] = this.getRecommendedThreadCount().toString();
        env['VECLIB_MAXIMUM_THREADS'] = this.getRecommendedThreadCount().toString();
        break;
        
      case 'linux':
        // Linux特定环境变量
        env['CUDA_VISIBLE_DEVICES'] = '0';
        env['OMP_NUM_THREADS'] = this.getRecommendedThreadCount().toString();
        env['MKL_NUM_THREADS'] = this.getRecommendedThreadCount().toString();
        
        // 启用大页内存（如果支持）
        if (this.platformConfig.optimizations.enableLargePages) {
          env['MALLOC_MMAP_THRESHOLD_'] = '4072';
        }
        break;
    }
    
    return env;
  }

  /**
   * 获取平台特定的启动参数
   */
  getPlatformSpecificArgs(): string[] {
    const args: string[] = [];
    
    switch (this.platformConfig.platform) {
      case 'win32':
        // Windows特定参数
        if (this.platformConfig.optimizations.enableLargePages) {
          args.push('--mlock'); // 锁定内存页
        }
        break;
        
      case 'darwin':
        // macOS特定参数
        args.push('--numa', 'false'); // macOS通常不需要NUMA优化
        break;
        
      case 'linux':
        // Linux特定参数
        if (this.platformConfig.optimizations.enableNUMAOptimization) {
          args.push('--numa', 'true');
        }
        if (this.platformConfig.optimizations.enableLargePages) {
          args.push('--mlock');
        }
        break;
    }
    
    return args;
  }

  /**
   * 检查平台特定的依赖
   */
  async checkPlatformDependencies(): Promise<{
    available: boolean;
    missing: string[];
    warnings: string[];
  }> {
    const missing: string[] = [];
    const warnings: string[] = [];
    
    try {
      switch (this.platformConfig.platform) {
        case 'win32':
          await this.checkWindowsDependencies(missing, warnings);
          break;
          
        case 'darwin':
          await this.checkMacOSDependencies(missing, warnings);
          break;
          
        case 'linux':
          await this.checkLinuxDependencies(missing, warnings);
          break;
      }
    } catch (error) {
      warnings.push(`依赖检查失败: ${error}`);
    }
    
    return {
      available: missing.length === 0,
      missing,
      warnings
    };
  }

  /**
   * 检查Windows依赖
   */
  private async checkWindowsDependencies(missing: string[], warnings: string[]): Promise<void> {
    try {
      // 检查Visual C++ Redistributable
      await execAsync('reg query "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64" /v Version');
    } catch {
      warnings.push('未检测到Visual C++ Redistributable，可能影响CUDA加速');
    }
    
    try {
      // 检查CUDA工具包（如果需要CUDA支持）
      await execAsync('nvcc --version');
    } catch {
      warnings.push('未检测到CUDA工具包，无法使用CUDA加速');
    }
  }

  /**
   * 检查macOS依赖
   */
  private async checkMacOSDependencies(missing: string[], warnings: string[]): Promise<void> {
    try {
      // 检查Xcode Command Line Tools
      await execAsync('xcode-select -p');
    } catch {
      warnings.push('未安装Xcode Command Line Tools，可能影响编译');
    }
    
    try {
      // 检查Homebrew（可选）
      await execAsync('brew --version');
    } catch {
      warnings.push('未安装Homebrew，建议安装以便管理依赖');
    }
  }

  /**
   * 检查Linux依赖
   */
  private async checkLinuxDependencies(missing: string[], warnings: string[]): Promise<void> {
    // 检查基础库
    const requiredLibs = ['libc6', 'libstdc++6'];
    
    for (const lib of requiredLibs) {
      try {
        await execAsync(`ldconfig -p | grep ${lib}`);
      } catch {
        missing.push(lib);
      }
    }
    
    try {
      // 检查CUDA驱动（如果需要CUDA支持）
      await execAsync('nvidia-smi');
    } catch {
      warnings.push('未检测到NVIDIA驱动，无法使用CUDA加速');
    }
    
    try {
      // 检查Vulkan支持
      await execAsync('vulkaninfo');
    } catch {
      warnings.push('未检测到Vulkan支持，无法使用Vulkan加速');
    }
  }

  /**
   * 获取平台特定的性能监控命令
   */
  getPerformanceMonitoringCommands(): {
    cpu: string;
    memory: string;
    gpu?: string;
  } {
    switch (this.platformConfig.platform) {
      case 'win32':
        // 优先使用 PowerShell (Get-CimInstance) 替代已弃用的 wmic
        return {
          cpu: 'powershell -Command "try { (Get-CimInstance Win32_Processor).LoadPercentage } catch { (wmic cpu get loadpercentage /value | findstr LoadPercentage).Split(\'=\')[1] }"',
          memory: 'powershell -Command "try { Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory | ConvertTo-Json } catch { $total = (wmic os get totalvisiblememorysize /value | findstr TotalVisibleMemorySize).Split(\'=\')[1]; $free = (wmic os get freephysicalmemory /value | findstr FreePhysicalMemory).Split(\'=\')[1]; @{TotalVisibleMemorySize=[int64]$total; FreePhysicalMemory=[int64]$free} | ConvertTo-Json }"',
          gpu: 'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits'
        };
        
      case 'darwin':
        return {
          cpu: 'top -l 1 -n 0 | grep "CPU usage"',
          memory: 'vm_stat'
        };
        
      case 'linux':
        return {
          cpu: 'cat /proc/loadavg',
          memory: 'cat /proc/meminfo',
          gpu: 'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits'
        };
        
      default:
        return {
          cpu: 'echo "unsupported"',
          memory: 'echo "unsupported"'
        };
    }
  }

  /**
   * 应用平台特定的进程优化
   */
  async applyProcessOptimizations(pid: number): Promise<void> {
    if (!pid || pid <= 0) return;
    
    try {
      switch (this.platformConfig.platform) {
        case 'win32':
          await this.applyWindowsOptimizations(pid);
          break;
          
        case 'darwin':
          await this.applyMacOSOptimizations(pid);
          break;
          
        case 'linux':
          await this.applyLinuxOptimizations(pid);
          break;
      }
    } catch (error) {
      logger.warn(LogCategory.PLATFORM_ADAPTER, `应用进程优化失败: ${error}`);
    }
  }

  /**
   * 应用Windows进程优化
   */
  private async applyWindowsOptimizations(pid: number): Promise<void> {
    const priority = this.platformConfig.optimizations.processPriority;
    
    try {
      // 优先使用 PowerShell 设置进程优先级
      let psPriority = 'Normal';
      let wmicPriority = 'NORMAL_PRIORITY_CLASS';

      switch (priority) {
        case 'high':
          psPriority = 'High';
          wmicPriority = 'HIGH_PRIORITY_CLASS';
          break;
        case 'low':
          psPriority = 'BelowNormal';
          wmicPriority = 'BELOW_NORMAL_PRIORITY_CLASS';
          break;
      }

      try {
        const psCommand = `powershell -ExecutionPolicy Bypass -Command "$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p) { $p.PriorityClass = '${psPriority}' }"`;
        await execAsync(psCommand);
      } catch (e) {
        logger.warn(LogCategory.PLATFORM_ADAPTER, 'PowerShell 设置优先级失败，尝试回退 wmic', e);
        // Fallback to wmic
        await execAsync(`wmic process where processid=${pid} CALL setpriority "${wmicPriority}"`);
      }
    } catch (error) {
      logger.warn(LogCategory.PLATFORM_ADAPTER, `设置Windows进程优先级失败 (PowerShell & wmic): ${error}`);
    }
  }

  /**
   * 应用macOS进程优化
   */
  private async applyMacOSOptimizations(pid: number): Promise<void> {
    const priority = this.platformConfig.optimizations.processPriority;
    
    // 设置进程nice值
    let niceValue = 0;
    switch (priority) {
      case 'high':
        niceValue = -5;
        break;
      case 'low':
        niceValue = 5;
        break;
    }
    
    if (niceValue !== 0) {
      try {
        await execAsync(`renice ${niceValue} ${pid}`);
      } catch (error) {
        logger.warn(LogCategory.PLATFORM_ADAPTER, `设置macOS进程优先级失败: ${error}`);
      }
    }
  }

  /**
   * 应用Linux进程优化
   */
  private async applyLinuxOptimizations(pid: number): Promise<void> {
    const priority = this.platformConfig.optimizations.processPriority;
    
    // 设置进程nice值
    let niceValue = 0;
    switch (priority) {
      case 'high':
        niceValue = -10;
        break;
      case 'low':
        niceValue = 10;
        break;
    }
    
    if (niceValue !== 0) {
      try {
        await execAsync(`renice ${niceValue} ${pid}`);
      } catch (error) {
        logger.warn(LogCategory.PLATFORM_ADAPTER, `设置Linux进程优先级失败: ${error}`);
      }
    }
    
    // 设置CPU亲和性（如果支持NUMA）
    if (this.platformConfig.optimizations.enableNUMAOptimization) {
      try {
        // 将进程绑定到第一个NUMA节点
        await execAsync(`numactl --cpunodebind=0 --membind=0 --pid=${pid}`);
      } catch (error) {
        logger.warn(LogCategory.PLATFORM_ADAPTER, `设置NUMA优化失败: ${error}`);
      }
    }
  }

  /**
   * Open a path using the system's default application
   * Uses injected handler if available, otherwise falls back to basic command line
   */
  async openPath(path: string): Promise<void> {
    if (this.config?.openPath) {
      return this.config.openPath(path);
    }

    // Fallback implementation
    const cmd = this.platformConfig.platform === 'win32' ? 'start ""' :
                this.platformConfig.platform === 'darwin' ? 'open' : 'xdg-open';
    
    try {
      await execAsync(`${cmd} "${path}"`);
    } catch (error) {
      logger.error(LogCategory.PLATFORM_ADAPTER, `Failed to open path: ${path}`, error);
      throw error;
    }
  }

  /**
   * Quit the application
   */
  quit(): void {
    if (this.config?.quit) {
      this.config.quit();
    } else {
      process.exit(0);
    }
  }

  /**
   * Exit the application with a specific code
   */
  exit(code: number): void {
    if (this.config?.exit) {
      this.config.exit(code);
    } else {
      process.exit(code);
    }
  }

  /**
   * 获取平台信息摘要
   */
  getPlatformSummary(): {
    platform: string;
    architecture: string;
    nodeVersion: string;
    electronVersion: string;
    supportedAccelerations: THardwareAcceleration[];
    optimizations: string[];
  } {
    const optimizations: string[] = [];
    
    if (this.platformConfig.optimizations.enableLargePages) {
      optimizations.push('大页内存');
    }
    
    if (this.platformConfig.optimizations.enableNUMAOptimization) {
      optimizations.push('NUMA优化');
    }
    
    optimizations.push(`线程倍数: ${this.platformConfig.optimizations.threadMultiplier}`);
    optimizations.push(`内存倍数: ${this.platformConfig.optimizations.memoryMultiplier}`);
    
    return {
      platform: this.platformConfig.platform,
      architecture: this.platformConfig.architecture,
      nodeVersion: process.version,
      electronVersion: process.versions.electron || 'unknown',
      supportedAccelerations: this.platformConfig.supportedAccelerations,
      optimizations
    };
  }
}

/**
 * 导出单例实例
 */
export const platformAdapter = PlatformAdapter.getInstance();