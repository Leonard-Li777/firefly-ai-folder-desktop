/**
 * Hardware Detection Service - 硬件能力检测服务
 */


import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { t } from '@app/languages';
import {
  IHardwareDetectionService,
  ISystemResources,
  IGPUInfo,
  IHardwareCapability,
  THardwareAcceleration
} from '@yonuc/types';
import { logger, LogCategory } from '@yonuc/shared';

const execAsync = promisify(exec);

/**
 * 硬件检测服务实现
 */
export class HardwareDetectionService implements IHardwareDetectionService {
  private systemResourcesCache: ISystemResources | null = null;
  private cacheTimestamp: number = 0;
  private readonly cacheTimeout = 30000; // 30秒缓存

  /**
   * 检测系统资源
   */
  async detectSystemResources(): Promise<ISystemResources> {
    const now = Date.now();

    // 使用缓存减少系统调用
    if (this.systemResourcesCache && (now - this.cacheTimestamp) < this.cacheTimeout) {
      return this.systemResourcesCache;
    }

    const [cpu, memory, gpus, storage] = await Promise.all([
      this.detectCPU(),
      this.detectMemory(),
      this.detectGPUs(),
      this.detectStorage()
    ]);

    this.systemResourcesCache = {
      cpu,
      memory,
      gpus,
      storage
    };
    this.cacheTimestamp = now;

    return this.systemResourcesCache;
  }

  /**
   * 检测CPU信息
   */
  private async detectCPU(): Promise<ISystemResources['cpu']> {
    const cpus = os.cpus();
    const firstCpu = cpus[0];

    return {
      model: firstCpu.model,
      cores: cpus.length,
      threads: cpus.length, // Node.js中通常cores等于threads
      speed: firstCpu.speed
    };
  }

  /**
   * 检测内存信息
   */
  private async detectMemory(): Promise<ISystemResources['memory']> {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    return {
      total: Math.round(totalMemory / 1024 / 1024), // 转换为MB
      available: Math.round(freeMemory / 1024 / 1024),
      usage: usedMemory / totalMemory
    };
  }

  /**
   * 检测存储信息
   */
  private async detectStorage(): Promise<ISystemResources['storage']> {
    try {
      const platform = process.platform;
      let total = 0;
      let available = 0;

      if (platform === 'win32') {
        // Windows: 优先使用 PowerShell 查询磁盘空间，失败后尝试 wmic
        let stdout = '';
        const psCommand = 'powershell -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_LogicalDisk | Select-Object Size, FreeSpace | ConvertTo-Csv -NoTypeInformation"';
        try {
          const result = await execAsync(psCommand);
          stdout = result.stdout;
        } catch (e) {
          logger.warn(LogCategory.HARDWARE_DETECTION, 'PowerShell 磁盘检测失败，尝试回退 wmic', e);
          const wmicResult = await execAsync('wmic logicaldisk get size,freespace /format:csv');
          stdout = wmicResult.stdout;
        }

        const lines = stdout.split('\n').map(l => l.trim()).filter(l => l && !l.includes('"Size"') && !l.includes('Size,FreeSpace') && !l.startsWith('Node'));
        
        for (const line of lines) {
          // 处理多种可能的 CSV 格式 (带引号或不带引号)
          const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
          
          if (parts.length >= 2) {
            let totalSpace = 0;
            let freeSpace = 0;
            
            if (parts.length === 2) {
              // PowerShell: Size, FreeSpace
              totalSpace = parseInt(parts[0] || '0');
              freeSpace = parseInt(parts[1] || '0');
            } else if (parts.length >= 3) {
              // wmic: Node, FreeSpace, Size
              totalSpace = parseInt(parts[2] || '0');
              freeSpace = parseInt(parts[1] || '0');
            }
            
            if (!isNaN(freeSpace) && !isNaN(totalSpace)) {
              total += totalSpace;
              available += freeSpace;
            }
          }
        }
      } else {
        // Unix系统: 使用df命令
        const { stdout } = await execAsync('df -B1 /');
        const lines = stdout.split('\n');

        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/);
          if (parts.length >= 4) {
            total = parseInt(parts[1]) || 0;
            available = parseInt(parts[3]) || 0;
          }
        }
      }

      return {
        total: Math.round(total / 1024 / 1024), // 转换为MB
        available: Math.round(available / 1024 / 1024),
        usage: total > 0 ? (total - available) / total : 0
      };
    } catch (error) {
      logger.warn(LogCategory.HARDWARE_DETECTION, '存储检测失败', { error });
      return {
        total: 0,
        available: 0,
        usage: 0
      };
    }
  }

  /**
   * 检测GPU信息
   */
  async detectGPUs(): Promise<IGPUInfo[]> {
    const platform = process.platform;

    try {
      if (platform === 'win32') {
        return await this.detectWindowsGPUs();
      } else if (platform === 'linux') {
        return await this.detectLinuxGPUs();
      } else if (platform === 'darwin') {
        return await this.detectMacOSGPUs();
      }
    } catch (error) {
      logger.warn(LogCategory.HARDWARE_DETECTION, 'GPU检测失败', { error, platform });
    }

    return [];
  }

  /**
   * 检测Windows GPU信息
   */
  private async detectWindowsGPUs(): Promise<IGPUInfo[]> {
    try {
      // Windows: 优先使用 PowerShell 查询，失败后尝试 wmic
      let stdout = '';
      const psCommand = 'powershell -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, PNPDeviceID | ConvertTo-Csv -NoTypeInformation"';
      try {
        const result = await execAsync(psCommand);
        stdout = result.stdout;
      } catch (e) {
        logger.warn(LogCategory.HARDWARE_DETECTION, 'PowerShell GPU检测失败，尝试回退 wmic', e);
        const wmicResult = await execAsync('wmic path win32_VideoController get Name,AdapterRAM,PNPDeviceID /format:csv');
        stdout = wmicResult.stdout;
      }

      const lines = stdout.split('\n').map(l => l.trim()).filter(l => l && !l.includes('"Name"') && !l.includes('Name,AdapterRAM') && !l.startsWith('Node'));
      const gpus: IGPUInfo[] = [];
      
      for (const line of lines) {
        const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
        
        if (parts.length >= 2) {
          let name = '';
          let memoryStr = '0';
          let deviceId = '';
          
          if (parts.length === 3) {
            // PowerShell: Name, AdapterRAM, PNPDeviceID
            name = parts[0];
            memoryStr = parts[1];
            deviceId = parts[2];
          } else if (parts.length >= 4) {
            // wmic: Node, AdapterRAM, Name, PNPDeviceID (顺序可能变动，简单启发式)
            if (parts[1] && !isNaN(parseInt(parts[1]))) {
              memoryStr = parts[1];
              name = parts[2];
              deviceId = parts[3];
            } else {
              name = parts[1];
              memoryStr = parts[2];
              deviceId = parts[3];
            }
          }
          
          if (name && name.toLowerCase() !== 'name') {
            const vendor = this.detectVendor(name, deviceId);
            const memory = parseInt(memoryStr);
            
            gpus.push({
              name,
              memory: memory > 0 ? Math.round(memory / 1024 / 1024) : 0, // 转换为MB
              supportsCUDA: vendor === 'nvidia',
              supportsVulkan: vendor !== 'unknown',
              vendor
            });
          }
        }
      }
      
      return gpus;
    } catch (error) {
      logger.warn(LogCategory.HARDWARE_DETECTION, 'Windows GPU检测失败', { error });
      return [];
    }
  }

  /**
   * 检测Linux GPU信息
   */
  private async detectLinuxGPUs(): Promise<IGPUInfo[]> {
    try {
      const { stdout } = await execAsync('lspci -v | grep -A 10 -i vga');
      const gpuBlocks = stdout.split('\n\n');

      const gpus: IGPUInfo[] = [];

      for (const block of gpuBlocks) {
        const lines = block.split('\n');
        const firstLine = lines[0];

        if (firstLine && firstLine.includes('VGA')) {
          const name = firstLine.split(': ')[1] || firstLine;
          const vendor = this.detectVendor(name, '');

          // 尝试从nvidia-smi获取显存信息
          let memory = 0;
          if (vendor === 'nvidia') {
            try {
              const { stdout: nvidiaSmi } = await execAsync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits');
              const memoryLines = nvidiaSmi.trim().split('\n');
              if (memoryLines.length > 0) {
                memory = parseInt(memoryLines[0]) || 0;
              }
            } catch {
              // nvidia-smi不可用
            }
          }

          gpus.push({
            name,
            memory,
            supportsCUDA: vendor === 'nvidia',
            supportsVulkan: vendor !== 'unknown',
            vendor
          });
        }
      }

      return gpus;
    } catch (error) {
      logger.warn(LogCategory.HARDWARE_DETECTION, 'Linux GPU检测失败', { error });
      return [];
    }
  }

  /**
   * 检测macOS GPU信息
   */
  private async detectMacOSGPUs(): Promise<IGPUInfo[]> {
    try {
      const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json');
      const data = JSON.parse(stdout);

      const gpus: IGPUInfo[] = [];

      if (data.SPDisplaysDataType) {
        for (const display of data.SPDisplaysDataType) {
          const name = display.sppci_model || display._name || t('未知GPU');
          const memoryStr = display.sppci_vram || display.spdisplays_vram || '0';
          const memory = this.parseMemoryString(memoryStr);

          gpus.push({
            name,
            memory,
            supportsCUDA: false, // macOS不支持CUDA
            supportsVulkan: false, // macOS使用Metal
            vendor: this.detectVendor(name, '')
          });
        }
      }

      return gpus;
    } catch (error) {
      logger.warn(LogCategory.HARDWARE_DETECTION, 'macOS GPU检测失败', { error });
      return [];
    }
  }

  /**
   * 检测GPU厂商
   */
  private detectVendor(name: string, deviceId: string): IGPUInfo['vendor'] {
    const lowerName = name.toLowerCase();
    const lowerDeviceId = deviceId.toLowerCase();

    if (lowerName.includes('nvidia') || lowerName.includes('geforce') || lowerName.includes('quadro') || lowerDeviceId.includes('nvidia')) {
      return 'nvidia';
    }

    if (lowerName.includes('amd') || lowerName.includes('radeon') || lowerDeviceId.includes('amd')) {
      return 'amd';
    }

    if (lowerName.includes('intel') || lowerDeviceId.includes('intel')) {
      return 'intel';
    }

    return 'unknown';
  }

  /**
   * 解析内存字符串
   */
  private parseMemoryString(memoryStr: string): number {
    const match = memoryStr.match(/(\d+)\s*(MB|GB|TB)?/i);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2]?.toUpperCase() || 'MB';

      switch (unit) {
        case 'GB':
          return value * 1024;
        case 'TB':
          return value * 1024 * 1024;
        default:
          return value;
      }
    }
    return 0;
  }

  /**
   * 评估硬件能力
   */
  async evaluateCapability(): Promise<IHardwareCapability> {
    const resources = await this.detectSystemResources();

    // 计算各项评分
    const cpuScore = this.calculateCPUScore(resources.cpu);
    const memoryScore = this.calculateMemoryScore(resources.memory);
    const gpuScore = this.calculateGPUScore(resources.gpus);
    const storageScore = this.calculateStorageScore(resources.storage);

    // 计算综合性能评分
    const performanceScore = Math.round(
      cpuScore * 0.3 +
      memoryScore * 0.3 +
      gpuScore * 0.3 +
      storageScore * 0.1
    );

    // 根据评分推荐配置
    const recommendations: string[] = [];
    let recommendedModelSize: IHardwareCapability['recommendedModelSize'] = 'small';
    let recommendedAcceleration: THardwareAcceleration = 'cpu';
    let maxConcurrentInferences = 1;
    let recommendedContextLength = 2048;

    // 根据GPU情况推荐加速类型
    const hasNvidiaGPU = resources.gpus.some(gpu => gpu.vendor === 'nvidia');
    const hasVulkanGPU = resources.gpus.some(gpu => gpu.supportsVulkan);
    const maxGPUMemory = Math.max(...resources.gpus.map(gpu => gpu.memory), 0);

    if (hasNvidiaGPU && maxGPUMemory >= 4096) {
      recommendedAcceleration = 'cuda';
      recommendations.push(t('检测到NVIDIA GPU，推荐使用CUDA加速'));
    } else if (hasVulkanGPU && maxGPUMemory >= 2048) {
      recommendedAcceleration = 'vulkan';
      recommendations.push(t('检测到支持Vulkan的GPU，推荐使用Vulkan加速'));
    } else {
      recommendedAcceleration = 'cpu';
      recommendations.push(t('未检测到合适的GPU，使用CPU模式'));
    }

    // 根据内存推荐模型大小
    if (resources.memory.total >= 32768) { // 32GB+
      recommendedModelSize = 'xlarge';
      maxConcurrentInferences = 4;
      recommendedContextLength = 8192;
      recommendations.push(t('内存充足，可以运行大型模型'));
    } else if (resources.memory.total >= 16384) { // 16GB+
      recommendedModelSize = 'large';
      maxConcurrentInferences = 2;
      recommendedContextLength = 4096;
      recommendations.push(t('内存较充足，推荐使用大型模型'));
    } else if (resources.memory.total >= 8192) { // 8GB+
      recommendedModelSize = 'medium';
      maxConcurrentInferences = 1;
      recommendedContextLength = 2048;
      recommendations.push(t('内存适中，推荐使用中型模型'));
    } else {
      recommendedModelSize = 'small';
      maxConcurrentInferences = 1;
      recommendedContextLength = 1024;
      recommendations.push(t('内存较少，建议使用小型模型'));
    }

    // 添加性能建议
    if (resources.cpu.cores < 4) {
      recommendations.push(t('CPU核心数较少，可能影响推理速度'));
    }

    if (resources.memory.usage > 0.8) {
      recommendations.push(t('当前内存使用率较高，建议关闭其他应用'));
    }

    if (resources.storage.available < 10240) { // 小于10GB
      recommendations.push(t('可用存储空间不足，可能影响模型下载'));
    }

    return {
      recommendedModelSize,
      recommendedAcceleration,
      maxConcurrentInferences,
      recommendedContextLength,
      performanceScore,
      details: {
        cpuScore,
        memoryScore,
        gpuScore,
        storageScore
      },
      recommendations
    };
  }

  /**
   * 计算CPU评分
   */
  private calculateCPUScore(cpu: ISystemResources['cpu']): number {
    let score = 0;

    // 核心数评分 (0-40分)
    if (cpu.cores >= 16) score += 40;
    else if (cpu.cores >= 8) score += 30;
    else if (cpu.cores >= 4) score += 20;
    else score += 10;

    // 频率评分 (0-30分)
    if (cpu.speed >= 3500) score += 30;
    else if (cpu.speed >= 3000) score += 25;
    else if (cpu.speed >= 2500) score += 20;
    else score += 10;

    // 架构评分 (0-30分) - 基于CPU型号简单判断
    const model = cpu.model.toLowerCase();
    if (model.includes('i9') || model.includes('ryzen 9') || model.includes('m1') || model.includes('m2')) {
      score += 30;
    } else if (model.includes('i7') || model.includes('ryzen 7')) {
      score += 25;
    } else if (model.includes('i5') || model.includes('ryzen 5')) {
      score += 20;
    } else {
      score += 15;
    }

    return Math.min(score, 100);
  }

  /**
   * 计算内存评分
   */
  private calculateMemoryScore(memory: ISystemResources['memory']): number {
    let score = 0;

    // 总内存评分 (0-70分)
    if (memory.total >= 32768) score += 70; // 32GB+
    else if (memory.total >= 16384) score += 60; // 16GB+
    else if (memory.total >= 8192) score += 40; // 8GB+
    else if (memory.total >= 4096) score += 20; // 4GB+
    else score += 10;

    // 可用内存评分 (0-30分)
    const availableRatio = memory.available / memory.total;
    if (availableRatio >= 0.7) score += 30;
    else if (availableRatio >= 0.5) score += 20;
    else if (availableRatio >= 0.3) score += 10;
    else score += 5;

    return Math.min(score, 100);
  }

  /**
   * 计算GPU评分
   */
  private calculateGPUScore(gpus: IGPUInfo[]): number {
    if (gpus.length === 0) return 0;

    let maxScore = 0;

    for (const gpu of gpus) {
      let score = 0;

      // 显存评分 (0-50分)
      if (gpu.memory >= 16384) score += 50; // 16GB+
      else if (gpu.memory >= 8192) score += 40; // 8GB+
      else if (gpu.memory >= 4096) score += 30; // 4GB+
      else if (gpu.memory >= 2048) score += 20; // 2GB+
      else score += 10;

      // 厂商和加速支持评分 (0-50分)
      if (gpu.supportsCUDA) {
        score += 50; // NVIDIA CUDA
      } else if (gpu.supportsVulkan) {
        if (gpu.vendor === 'amd') score += 35; // AMD Vulkan
        else if (gpu.vendor === 'intel') score += 25; // Intel Vulkan
        else score += 30; // 其他Vulkan
      } else {
        score += 10; // 基础GPU
      }

      maxScore = Math.max(maxScore, score);
    }

    return Math.min(maxScore, 100);
  }

  /**
   * 计算存储评分
   */
  private calculateStorageScore(storage: ISystemResources['storage']): number {
    let score = 0;

    // 可用空间评分 (0-60分)
    if (storage.available >= 102400) score += 60; // 100GB+
    else if (storage.available >= 51200) score += 50; // 50GB+
    else if (storage.available >= 20480) score += 40; // 20GB+
    else if (storage.available >= 10240) score += 30; // 10GB+
    else score += 10;

    // 使用率评分 (0-40分)
    if (storage.usage <= 0.5) score += 40; // 使用率50%以下
    else if (storage.usage <= 0.7) score += 30; // 使用率70%以下
    else if (storage.usage <= 0.9) score += 20; // 使用率90%以下
    else score += 10;

    return Math.min(score, 100);
  }

  /**
   * 获取推荐配置
   */
  async getRecommendedConfig(): Promise<{
    modelSize: string;
    acceleration: THardwareAcceleration;
    contextLength: number;
    batchSize: number;
    threads: number;
    gpuLayers?: number;
  }> {
    const capability = await this.evaluateCapability();
    const resources = await this.detectSystemResources();

    // 根据硬件能力计算推荐配置
    const threads = Math.max(1, Math.floor(resources.cpu.cores * 0.75));
    let batchSize = 512;
    let gpuLayers: number | undefined;

    // 根据加速类型调整配置
    if (capability.recommendedAcceleration === 'cuda' || capability.recommendedAcceleration === 'vulkan') {
      const maxGPUMemory = Math.max(...resources.gpus.map(gpu => gpu.memory), 0);

      if (maxGPUMemory >= 8192) {
        gpuLayers = 35; // 大部分层使用GPU
        batchSize = 1024;
      } else if (maxGPUMemory >= 4096) {
        gpuLayers = 25; // 部分层使用GPU
        batchSize = 512;
      } else {
        gpuLayers = 15; // 少量层使用GPU
        batchSize = 256;
      }
    }

    return {
      modelSize: capability.recommendedModelSize,
      acceleration: capability.recommendedAcceleration,
      contextLength: capability.recommendedContextLength,
      batchSize,
      threads,
      gpuLayers
    };
  }

  /**
   * 监控系统资源使用情况
   */
  async monitorResources(): Promise<{
    cpu: number;
    memory: number;
    gpu?: number;
  }> {
    const resources = await this.detectSystemResources();

    // CPU使用率需要通过loadavg计算（Unix系统）或其他方式
    let cpuUsage = 0;
    try {
      if (process.platform !== 'win32') {
        const loadavg = os.loadavg();
        cpuUsage = Math.min(loadavg[0] / resources.cpu.cores, 1);
      } else {
        // Windows系统: 优先使用 PowerShell，失败后回退 wmic
        try {
          const { stdout } = await execAsync('powershell -Command "(Get-CimInstance Win32_Processor).LoadPercentage"');
          const load = parseInt(stdout.trim());
          if (!isNaN(load)) {
            cpuUsage = load / 100;
          }
        } catch (e) {
          logger.debug(LogCategory.HARDWARE_DETECTION, 'PowerShell CPU usage detection failed, falling back to wmic:', e);
          try {
            const { stdout } = await execAsync('wmic cpu get loadpercentage /value');
            const match = stdout.match(/LoadPercentage=(\d+)/);
            if (match) {
              cpuUsage = parseInt(match[1]) / 100;
            }
          } catch (wmicError) {
            logger.warn(LogCategory.HARDWARE_DETECTION, 'WMIC CPU usage detection failed:', wmicError);
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.HARDWARE_DETECTION, 'CPU使用率检测失败:', error);
    }

    return {
      cpu: cpuUsage,
      memory: resources.memory.usage,
      // GPU使用率检测较复杂，暂时不实现
    };
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.systemResourcesCache = null;
    this.cacheTimestamp = 0;
  }
}

/**
 * 单例实例
 */
export const hardwareDetectionService = new HardwareDetectionService();
