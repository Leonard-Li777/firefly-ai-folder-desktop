/**
 * Hardware Detection Service - 硬件能力检测服务
 * 使用 fastfetch 进行高性能、全平台的精准硬件检测
 * 移除所有 fallback 支持，完全依赖 fastfetch
 */

import * as path from 'path';
import * as fs from 'fs';

import {
  IGPUInfo,
  IHardwareCapability,
  IHardwareDetectionService,
  ISystemResources,
  THardwareAcceleration
} from '@yonuc/types';
import { LogCategory, logger } from '@yonuc/shared';

import { ConfigOrchestrator } from '../../config/config-orchestrator';
import { OllamaService } from '../ai/ollama-service';
import { execFile } from 'child_process';
import { platformAdapter } from '@yonuc/electron-llamaIndex-service';
import { promisify } from 'util';
import { t } from '@app/languages';

const execFileAsync = promisify(execFile);

/**
 * Fastfetch JSON 输出的部分类型定义
 */
interface IFastfetchOutput {
  type: string;
  result?: any;
  error?: string;
}

/**
 * 硬件检测服务实现
 */
export class HardwareDetectionService implements IHardwareDetectionService {
  private systemResourcesCache: ISystemResources | null = null;
  private cacheTimestamp: number = 0;
  private readonly cacheTimeout = 30000; // 30秒缓存

  /**
   * 获取真实的硬件架构 (处理 macOS Rosetta 2 情况)
   */
  private getRealArch(): string {
    const arch = process.arch;
    if (process.platform === 'darwin' && arch === 'x64') {
      try {
        const { execSync } = require('child_process');
        const isArm = execSync('sysctl -n hw.optional.arm64', { encoding: 'utf-8' }).trim() === '1';
        if (isArm) return 'arm64';
      } catch (e) {
        // 忽略错误，回退到 process.arch
      }
    }
    return arch;
  }

  /**
   * 获取 fastfetch 二进制文件路径
   */
  private getFastfetchPath(): string {
    const extraResourcesPath = platformAdapter.getExtraResourcesPath();
    const platform = process.platform;
    const arch = this.getRealArch(); // 使用真实架构检测

    let platformDir = '';
    let executable = 'fastfetch';

    if (platform === 'win32') {
      platformDir = 'win32-x64';
      executable = 'fastfetch.exe';
    } else if (platform === 'darwin') {
      platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    } else if (platform === 'linux') {
      platformDir = 'linux-x64';
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    return path.join(extraResourcesPath, 'bin', platformDir, executable);
  }

  /**
   * 执行 fastfetch 并获取 JSON 结果
   */
  private async runFastfetch(): Promise<IFastfetchOutput[]> {
    const fastfetchPath = this.getFastfetchPath();

    // 在非 Windows 平台，尝试确保二进制文件具有可执行权限
    if (process.platform !== 'win32' && fs.existsSync(fastfetchPath)) {
      try {
        const stats = fs.statSync(fastfetchPath);
        // 检查是否缺少可执行权限 (0o111 是 --x--x--x)
        if (!(stats.mode & 0o111)) {
          logger.info(LogCategory.HARDWARE_DETECTION, `检测到 fastfetch 缺少可执行权限，正在尝试修复: ${fastfetchPath}`);
          fs.chmodSync(fastfetchPath, 0o755);
        }
      } catch (error) {
        // 仅在调试时记录，因为在只读文件系统上可能会失败，我们还是会尝试运行
        logger.debug(LogCategory.HARDWARE_DETECTION, `尝试修复 fastfetch 权限失败 (可能在只读文件系统中):`, error);
      }
    }

    try {
      const { stdout } = await execFileAsync(fastfetchPath, ['--format', 'json'], {
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });
      return JSON.parse(stdout);
    } catch (error) {
      logger.error(LogCategory.HARDWARE_DETECTION, '执行 fastfetch 失败:', error);
      throw new Error(`Failed to execute fastfetch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 检测系统资源
   * @param forceRefresh 是否强制重新检测，而不使用缓存或配置值
   */
  async detectSystemResources(forceRefresh = false): Promise<ISystemResources> {
    const now = Date.now();
    
    // 1. 优先使用内存中的运行时缓存 (TTL 内)
    if (!forceRefresh && this.systemResourcesCache && (now - this.cacheTimestamp) < this.cacheTimeout) {
      return this.systemResourcesCache;
    }

    // 2. 尝试从统一配置读取 (如果内存缓存为空)
    if (!forceRefresh) {
      try {
        const config = ConfigOrchestrator.getInstance();
        
        const cpu = config.getValue('HARDWARE_CPU_INFO');
        const memory = config.getValue('HARDWARE_MEMORY_INFO');
        const gpus = config.getValue('HARDWARE_GPU_INFO');
        const storage = config.getValue('HARDWARE_STORAGE_INFO');

        if (cpu && memory && gpus && storage) {
          logger.debug(LogCategory.SYSTEM_HEALTH, '硬件资源检测: 从统一配置加载缓存');
          this.systemResourcesCache = { cpu, memory, gpus, storage };
          this.cacheTimestamp = now;
          return this.systemResourcesCache;
        }
      } catch (e) { }
    }

    // 3. 执行实时检测
    logger.info(LogCategory.SYSTEM_HEALTH, '硬件资源检测: 使用 fastfetch 执行实时系统扫描...');
    
    let targetPath: string | undefined;
    try {
      const config = ConfigOrchestrator.getInstance();
      const mode = config.getValue('AI_SERVICE_MODE');
      const platform = config.getValue<string>('AI_ENGINE');

      if (mode === 'local') {
        if (platform === 'ollama') {
          targetPath = OllamaService.getInstance().getOllamaModelsPath();
        } else {
          targetPath = config.getValue('MODEL_STORAGE_PATH');
        }
      }
    } catch (e) {
      targetPath = OllamaService.getInstance().getOllamaModelsPath();
    }

    const fastfetchData = await this.runFastfetch();
    
    const cpu = this.parseCPU(fastfetchData);
    const memory = this.parseMemory(fastfetchData);
    const gpus = this.parseGPUs(fastfetchData);
    const storage = this.parseStorage(fastfetchData, targetPath);

    this.systemResourcesCache = {
      cpu,
      memory,
      gpus,
      storage
    };
    this.cacheTimestamp = now;

    // 4. 持久化到统一配置，确保其他服务（如 model-service）能读取到最新数据
    try {
      const config = ConfigOrchestrator.getInstance();
      config.updateValues({
        'HARDWARE_CPU_INFO': cpu,
        'HARDWARE_MEMORY_INFO': memory,
        'HARDWARE_GPU_INFO': gpus,
        'HARDWARE_STORAGE_INFO': storage
      }, { source: 'runtime' });
      logger.info(LogCategory.SYSTEM_HEALTH, '硬件资源检测: 已同步最新硬件信息到统一配置');
    } catch (e) {
      logger.warn(LogCategory.SYSTEM_HEALTH, '硬件资源检测: 同步配置失败:', e);
    }

    return this.systemResourcesCache;
  }

  /**
   * 解析 CPU 信息
   */
  private parseCPU(data: IFastfetchOutput[]): ISystemResources['cpu'] {
    const cpuModule = data.find(m => m.type === 'CPU');
    if (!cpuModule || !cpuModule.result) {
      return { model: 'Unknown CPU', cores: 1, threads: 1, speed: 0 };
    }

    const result = cpuModule.result;
    return {
      model: result.cpu || 'Unknown CPU',
      cores: result.cores?.physical || 1,
      threads: result.cores?.logical || 1,
      speed: result.frequency?.base || 0
    };
  }

  /**
   * 解析内存信息
   */
  private parseMemory(data: IFastfetchOutput[]): ISystemResources['memory'] {
    const memModule = data.find(m => m.type === 'Memory');
    if (!memModule || !memModule.result) {
      return { total: 0, available: 0, usage: 0 };
    }

    const result = memModule.result;
    const total = Math.round(result.total / 1024 / 1024); // Bytes to MB
    const used = Math.round(result.used / 1024 / 1024); // Bytes to MB
    const available = total - used;
    
    return {
      total,
      available,
      usage: total > 0 ? used / total : 0
    };
  }

  /**
   * 解析 GPU 信息
   */
  private parseGPUs(data: IFastfetchOutput[]): IGPUInfo[] {
    const gpuModule = data.find(m => m.type === 'GPU');
    if (!gpuModule || !gpuModule.result || !Array.isArray(gpuModule.result)) {
      logger.debug(LogCategory.HARDWARE_DETECTION, '未在 fastfetch 输出中找到 GPU 信息');
      return [];
    }

    const rawGpus: IGPUInfo[] = [];

    // 第一步：初步解析所有条目
    gpuModule.result.forEach((g: any, index: number) => {
      const vendor = this.detectVendor(g.name || '', g.vendor || '');
      const name = (g.name || '').trim();
      
      let vram = 0;
      if (g.memory?.dedicated?.total) {
        vram = Math.round(g.memory.dedicated.total / 1024 / 1024);
      } else if (g.memory?.total) {
        vram = Math.round(g.memory.total / 1024 / 1024);
      }

      rawGpus.push({
        name,
        memory: vram,
        supportsCUDA: vendor === 'nvidia',
        supportsVulkan: !!g.platformApi?.includes('Vulkan') || vendor !== 'unknown',
        vendor
      });
    });

    // 第二步：智能去重
    // 逻辑：如果多个条目的 vendor 和 VRAM 相同，优先保留有具体名称的条目
    const finalGpus: IGPUInfo[] = [];
    
    // 按名称长度降序排列，确保有具体型号的条目排在前面
    const sortedRaw = [...rawGpus].sort((a, b) => b.name.length - a.name.length);

    sortedRaw.forEach(gpu => {
      // 检查是否已经存在极其相似的条目（同厂商且显存误差在 10MB 以内）
      const isDuplicate = finalGpus.some(existing => 
        existing.vendor === gpu.vendor && 
        Math.abs(existing.memory - gpu.memory) < 10
      );

      if (!isDuplicate) {
        // 如果是唯一条目或更好的条目，但名称仍为空，则进行兜底命名
        if (!gpu.name) {
          gpu.name = gpu.vendor !== 'unknown' ? `${gpu.vendor.toUpperCase()} GPU` : 'Unknown GPU';
        }
        finalGpus.push(gpu);
      }
    });

    logger.debug(LogCategory.HARDWARE_DETECTION, '解析并去重完成的 GPU 列表:', finalGpus);
    return this.sortGPUs(finalGpus);
  }

  /**
   * 解析存储信息
   */
  private parseStorage(data: IFastfetchOutput[], targetPath?: string): ISystemResources['storage'] {
    const diskModule = data.find(m => m.type === 'Disk');
    if (!diskModule || !diskModule.result || !Array.isArray(diskModule.result)) {
      return { total: 0, available: 0, usage: 0 };
    }

    const disks = diskModule.result;
    const lookupPath = targetPath ? path.resolve(targetPath) : process.cwd();
    
    // 找到与路径最匹配的挂载点
    let bestMatch = disks[0];
    let longestMatch = -1;

    for (const disk of disks) {
      if (disk.mountpoint && lookupPath.toLowerCase().startsWith(disk.mountpoint.toLowerCase()) && disk.mountpoint.length > longestMatch) {
        longestMatch = disk.mountpoint.length;
        bestMatch = disk;
      }
    }

    if (!bestMatch || !bestMatch.bytes) {
      return { total: 0, available: 0, usage: 0 };
    }

    return {
      total: Math.round(bestMatch.bytes.total / 1024 / 1024 / 1024), // Bytes to GB
      available: Math.round(bestMatch.bytes.available / 1024 / 1024 / 1024),
      usage: bestMatch.bytes.total > 0 ? bestMatch.bytes.used / bestMatch.bytes.total : 0
    };
  }

  /**
   * 排序GPU
   */
  private sortGPUs(gpus: IGPUInfo[]): IGPUInfo[] {
    return gpus.sort((a, b) => {
      const score = (g: IGPUInfo) => {
        if (g.vendor === 'nvidia') return 100;
        if (g.vendor === 'amd') return 80;
        if (g.vendor === 'intel') return 60;
        return 0;
      };
      return score(b) - score(a);
    });
  }

  /**
   * 检测GPU厂商
   */
  private detectVendor(name: string, vendorStr: string): IGPUInfo['vendor'] {
    const combined = `${name} ${vendorStr}`.toLowerCase();
    
    if (combined.includes('nvidia') || combined.includes('geforce') || combined.includes('quadro')) {
      return 'nvidia';
    }
    
    if (combined.includes('amd') || combined.includes('radeon')) {
      return 'amd';
    }
    
    if (combined.includes('intel') || combined.includes('arc') || combined.includes('iris')) {
      return 'intel';
    }
    
    return 'unknown';
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
    
    if (resources.storage.available < 10) { // 小于10GB
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
    
    if (cpu.cores >= 16) score += 40;
    else if (cpu.cores >= 8) score += 30;
    else if (cpu.cores >= 4) score += 20;
    else score += 10;
    
    if (cpu.speed >= 3500) score += 30;
    else if (cpu.speed >= 3000) score += 25;
    else if (cpu.speed >= 2500) score += 20;
    else score += 10;
    
    const model = cpu.model.toLowerCase();
    if (model.includes('i9') || model.includes('ryzen 9') || model.includes('m1') || model.includes('m2') || model.includes('m3')) {
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
    
    if (memory.total >= 32768) score += 70;
    else if (memory.total >= 16384) score += 60;
    else if (memory.total >= 8192) score += 40;
    else if (memory.total >= 4096) score += 20;
    else score += 10;
    
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
      
      if (gpu.memory >= 16384) score += 50;
      else if (gpu.memory >= 8192) score += 40;
      else if (gpu.memory >= 4096) score += 30;
      else if (gpu.memory >= 2048) score += 20;
      else score += 10;
      
      if (gpu.supportsCUDA) {
        score += 50;
      } else if (gpu.supportsVulkan) {
        if (gpu.vendor === 'amd') score += 35;
        else if (gpu.vendor === 'intel') score += 25;
        else score += 30;
      } else {
        score += 10;
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
    
    if (storage.available >= 100) score += 60;
    else if (storage.available >= 50) score += 50;
    else if (storage.available >= 20) score += 40;
    else if (storage.available >= 10) score += 30;
    else score += 10;
    
    if (storage.usage <= 0.5) score += 40;
    else if (storage.usage <= 0.7) score += 30;
    else if (storage.usage <= 0.9) score += 20;
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
    
    const threads = Math.max(1, Math.floor(resources.cpu.cores * 0.75));
    let batchSize = 512;
    let gpuLayers: number | undefined;
    
    if (capability.recommendedAcceleration === 'cuda' || capability.recommendedAcceleration === 'vulkan') {
      const maxGPUMemory = Math.max(...resources.gpus.map(gpu => gpu.memory), 0);
      
      if (maxGPUMemory >= 8192) {
        gpuLayers = 35;
        batchSize = 1024;
      } else if (maxGPUMemory >= 4096) {
        gpuLayers = 25;
        batchSize = 512;
      } else {
        gpuLayers = 15;
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
   * 获取最佳硬件加速层级
   */
  async getBestAccelerationTier(): Promise<THardwareAcceleration> {
    const resources = await this.detectSystemResources();
    const hasNvidiaGPU = resources.gpus.some(gpu => gpu.vendor === 'nvidia');
    const hasVulkanGPU = resources.gpus.some(gpu => gpu.supportsVulkan);
    const maxGPUMemory = Math.max(...resources.gpus.map(gpu => gpu.memory), 0);
    
    // macOS Apple Silicon 支持 Metal 加速 (使用真实架构检测)
    if (process.platform === 'darwin' && this.getRealArch() === 'arm64') {
      return 'metal';
    }
    
    if (hasNvidiaGPU && maxGPUMemory >= 2048) {
      return 'cuda';
    } else if (hasVulkanGPU && maxGPUMemory >= 2048) {
      return 'vulkan';
    } else {
      return 'cpu';
    }
  }

  /**
   * 监控系统资源使用情况
   */
  async monitorResources(): Promise<{
    cpu: number;
    memory: number;
    gpu?: number;
  }> {
    const resources = await this.detectSystemResources(true);
    
    return {
      cpu: resources.cpu.speed > 0 ? resources.cpu.speed / 1000 : 0, // 这是一个占位符，fastfetch 主要是静态检测
      memory: resources.memory.usage,
    };
  }

  /**
   * 检测磁盘空间
   * @param targetPath 目标路径
   */
  async detectStorage(targetPath?: string): Promise<ISystemResources['storage']> {
    const data = await this.runFastfetch();
    return this.parseStorage(data, targetPath);
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.systemResourcesCache = null;
    this.cacheTimestamp = 0;
  }

  /**
   * 获取硬件信息 (兼容性支持)
   * 提供旧版 HardwareInfo 格式，并包含 LlamafileAdapter 所需的嵌套结构
   */
  async getHardwareInfo(): Promise<any> {
    const resources = await this.detectSystemResources();
    const primaryGpu = resources.gpus[0];
    
    return {
      osPlatform: process.platform,
      osArch: process.arch,
      totalMemGB: Math.round(resources.memory.total / 1024),
      freeMemGB: Math.round(resources.memory.available / 1024),
      hasGPU: resources.gpus.length > 0,
      gpuModel: primaryGpu?.name || '',
      vramGB: primaryGpu ? Math.round(primaryGpu.memory / 1024) : 0,
      gpuType: primaryGpu ? (primaryGpu.vendor === 'unknown' ? 'none' : 'dedicated') : 'none',
      storageFreeGB: resources.storage.available,
      // 兼容 LlamafileAdapter 的嵌套结构
      gpu: {
        type: primaryGpu?.vendor || 'none',
        memory: primaryGpu?.memory || 0
      },
      cpu: {
        model: resources.cpu.model,
        cores: resources.cpu.cores,
        threads: resources.cpu.threads,
        features: {
          avx2: true // 现代 x64/arm64 CPU 通常支持 AVX2 或同等特性，此处提供兼容性兜底
        }
      }
    };
  }
}

/**
 * 单例实例
 */
export const hardwareDetectionService = new HardwareDetectionService();
