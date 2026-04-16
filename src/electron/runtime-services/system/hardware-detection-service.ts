/**
 * Hardware Detection Service - 硬件能力检测服务
 * 使用 systeminformation 专业库进行精准检测
 */

import * as os from 'os';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import fixPath from 'fix-path';
import * as si from 'systeminformation';
import {
  IHardwareDetectionService,
  ISystemResources,
  IGPUInfo,
  IHardwareCapability,
  THardwareAcceleration
} from '@yonuc/types/llama-server';

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in SystemHardwareDetectionService:', e);
  }
}

import { logger, LogCategory } from '@yonuc/shared';
import { t } from '../../../languages';

const execAsync = promisify(exec);

import * as path from 'path';
import { OllamaService } from '../ai/ollama-service';
import { app } from 'electron';

/**
 * 硬件检测服务实现
 */
export class HardwareDetectionService implements IHardwareDetectionService {
  private systemResourcesCache: ISystemResources | null = null;
  private cacheTimestamp: number = 0;
  private readonly cacheTimeout = 30000; // 30秒缓存

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
        const { ConfigOrchestrator } = require('../../config/config-orchestrator');
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
    logger.info(LogCategory.SYSTEM_HEALTH, '硬件资源检测: 执行实时系统扫描...');
    
    let targetPath: string | undefined;
    try {
      const { ConfigOrchestrator } = require('../../config/config-orchestrator');
      const config = ConfigOrchestrator.getInstance();
      const mode = config.getValue('AI_SERVICE_MODE');
      const platform = config.getValue('AI_PLATFORM');

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

    const [cpu, memory, gpus, storage] = await Promise.all([
      this.detectCPU(),
      this.detectMemory(),
      this.detectGPUs(),
      this.detectStorage(targetPath)
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
    try {
      const data = await si.cpu();
      return {
        model: `${data.manufacturer} ${data.brand}`.trim(),
        cores: data.physicalCores || os.cpus().length,
        threads: data.cores || os.cpus().length,
        speed: data.speed || (os.cpus()[0]?.speed || 0)
      };
    } catch (error) {
      logger.error(LogCategory.HARDWARE_DETECTION, 'CPU检测失败', error);
      const cpus = os.cpus();
      return {
        model: cpus[0]?.model || 'Unknown CPU',
        cores: cpus.length,
        threads: cpus.length,
        speed: cpus[0]?.speed || 0
      };
    }
  }

  /**
   * 检测内存信息
   */
  private async detectMemory(): Promise<ISystemResources['memory']> {
    try {
      const data = await si.mem();
      return {
        total: Math.round(data.total / 1024 / 1024),
        available: Math.round(data.available / 1024 / 1024),
        usage: (data.total - data.available) / data.total
      };
    } catch (error) {
      const total = os.totalmem();
      const free = os.freemem();
      return {
        total: Math.round(total / 1024 / 1024),
        available: Math.round(free / 1024 / 1024),
        usage: (total - free) / total
      };
    }
  }

  /**
   * 检测GPU信息
   */
  async detectGPUs(): Promise<IGPUInfo[]> {
    const gpus: IGPUInfo[] = [];
    try {
      // 1. 使用 systeminformation 获取显卡基础信息
      const data = await si.graphics();
      
      for (const controller of data.controllers) {
        const name = `${controller.vendor} ${controller.model}`.trim();
        
        // 过滤基础渲染驱动
        if (name.includes('Basic Render Driver') || name.includes('Microsoft')) {
          if (process.platform === 'win32' || process.platform === 'linux') continue;
        }

        const vendor = this.detectVendor(name, '');
        let vram = controller.vram || 0; // si 返回的通常是 MB

        // 2. 对于 NVIDIA 显卡，优先使用 nvidia-smi 补充更准确的显存
        if (vendor === 'nvidia') {
          const smiVram = await this.getVRAMFromNvidiaSmi();
          if (smiVram && smiVram > 0) {
            vram = smiVram;
          }
        }

        gpus.push({
          name,
          memory: vram,
          supportsCUDA: vendor === 'nvidia',
          supportsVulkan: vendor !== 'unknown',
          vendor
        });
      }

      // 3. 兜底策略：如果 si 没找着显卡但 nvidia-smi 能用
      if (gpus.length === 0) {
        const smiGpus = await this.detectGPUsViaNvidiaSmi();
        if (smiGpus.length > 0) return smiGpus;
      }

    } catch (error) {
      logger.error(LogCategory.HARDWARE_DETECTION, 'si GPU检测失败', error);
      // 如果 si 彻底挂了，尝试使用 Electron API 或 原生命令兜底
      return await this.detectGPUsFallback();
    }

    return gpus.length > 0 ? this.sortGPUs(gpus) : await this.detectGPUsFallback();
  }

  /**
   * GPU检测的最后兜底逻辑
   */
  private async detectGPUsFallback(): Promise<IGPUInfo[]> {
    // 这里的逻辑可以保留之前的 detectWindowsGPUs / detectLinuxGPUs 中的核心部分
    // 为了篇幅，先实现一个基础的根据平台调用的逻辑
    const platform = process.platform;
    if (platform === 'win32') return this.detectGPUsViaNvidiaSmi(); // Windows下NVIDIA很常见
    if (platform === 'linux') return this.detectGPUsViaNvidiaSmi();
    return [];
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
   * 从 nvidia-smi 获取显存 (MB)
   */
  private async getVRAMFromNvidiaSmi(): Promise<number | undefined> {
    const smiCmds = [
      'nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits',
      '/usr/bin/nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits',
      '/usr/local/cuda/bin/nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits',
      'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe --query-gpu=memory.total --format=csv,noheader,nounits'
    ];

    for (const cmd of smiCmds) {
      try {
        const { stdout } = await execAsync(`${cmd} || true`, { timeout: 2000 });
        const val = parseInt(stdout.trim().split('\n')[0]);
        if (!isNaN(val) && val > 0) return val;
      } catch { }
    }
    return undefined;
  }

  /**
   * 使用 nvidia-smi 直接检测显卡列表 (作为 si 失败后的兜底)
   */
  private async detectGPUsViaNvidiaSmi(): Promise<IGPUInfo[]> {
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits || true', { timeout: 3000 });
      if (!stdout.trim()) return [];

      const lines = stdout.trim().split('\n');
      return lines.map(line => {
        const [name, mem] = line.split(',').map(s => s.trim());
        return {
          name: name || 'NVIDIA GPU',
          memory: parseInt(mem) || 0,
          supportsCUDA: true,
          supportsVulkan: true,
          vendor: 'nvidia' as const
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * 检测存储空间 (目标路径所在的盘符)
   */
  private async detectStorage(targetPath?: string): Promise<ISystemResources['storage']> {
    try {
      const fsSize = await si.fsSize();
      const lookupPath = targetPath ? path.resolve(targetPath) : process.cwd();
      
      // 找到与路径最匹配的挂载点
      let bestMatch = fsSize[0];
      let longestMatch = -1;

      for (const fs of fsSize) {
        if (lookupPath.startsWith(fs.mount) && fs.mount.length > longestMatch) {
          longestMatch = fs.mount.length;
          bestMatch = fs;
        }
      }

      if (!bestMatch) return { total: 0, available: 0, usage: 0 };

      return {
        total: Math.round(bestMatch.size / 1024 / 1024 / 1024),
        available: Math.round(bestMatch.available / 1024 / 1024 / 1024),
        usage: bestMatch.use / 100
      };
    } catch (error) {
      return { total: 0, available: 0, usage: 0 };
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
    
    if (cpu.cores >= 16) score += 40;
    else if (cpu.cores >= 8) score += 30;
    else if (cpu.cores >= 4) score += 20;
    else score += 10;
    
    if (cpu.speed >= 3500) score += 30;
    else if (cpu.speed >= 3000) score += 25;
    else if (cpu.speed >= 2500) score += 20;
    else score += 10;
    
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
    
    if (storage.available >= 102400) score += 60;
    else if (storage.available >= 51200) score += 50;
    else if (storage.available >= 20480) score += 40;
    else if (storage.available >= 10240) score += 30;
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
   * 监控系统资源使用情况
   */
  async monitorResources(): Promise<{
    cpu: number;
    memory: number;
    gpu?: number;
  }> {
    const resources = await this.detectSystemResources();
    
    let cpuUsage = 0;
    try {
      if (process.platform !== 'win32') {
        const loadavg = os.loadavg();
        cpuUsage = Math.min(loadavg[0] / resources.cpu.cores, 1);
      } else {
        const data = await si.currentLoad();
        cpuUsage = data.currentLoad / 100;
      }
    } catch (error) {
      logger.warn(LogCategory.HARDWARE_DETECTION, 'CPU使用率检测失败:', error);
    }
    
    return {
      cpu: cpuUsage,
      memory: resources.memory.usage,
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
