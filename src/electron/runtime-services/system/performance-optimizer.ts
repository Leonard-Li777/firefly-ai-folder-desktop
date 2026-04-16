/**
 * Performance Optimizer - 性能优化服务
 * 
 * 实现模型预热机制、智能批处理、并发控制和性能监控自动调优功能。
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { memoryManager } from './memory-manager';
// TODO: 实现这些模块
// import { concurrencyController } from './concurrency-controller';
// import { configService } from './config-service';
import { loggingService } from './logging-service';
import { IChatRequest } from '@yonuc/types/llama-server';
import { logger, LogCategory } from '@yonuc/shared';

// 临时占位符 - TODO: 实现 concurrencyController
const concurrencyController = {
  getStats: () => ({ activeRequests: 0, queueLength: 0, maxConcurrency: 4 }),
  updateMaxConcurrency: (_: number) => {},
  reset: () => {}
} as any;

/**
 * 性能指标接口
 */
export interface IPerformanceMetrics {
  /** 请求延迟（毫秒） */
  requestLatency: number;
  /** 吞吐量（请求/秒） */
  throughput: number;
  /** 内存使用率（0-1） */
  memoryUsage: number;
  /** CPU使用率（0-1） */
  cpuUsage: number;
  /** GPU使用率（0-1，可选） */
  gpuUsage?: number;
  /** 错误率（0-1） */
  errorRate: number;
  /** 队列长度 */
  queueLength: number;
  /** 活跃请求数 */
  activeRequests: number;
  /** 时间戳 */
  timestamp: Date;
}

/**
 * 性能阈值配置接口
 */
export interface IPerformanceThresholds {
  /** 最大延迟阈值（毫秒） */
  maxLatency: number;
  /** 最小吞吐量阈值（请求/秒） */
  minThroughput: number;
  /** 最大内存使用率阈值（0-1） */
  maxMemoryUsage: number;
  /** 最大CPU使用率阈值（0-1） */
  maxCpuUsage: number;
  /** 最大错误率阈值（0-1） */
  maxErrorRate: number;
  /** 最大队列长度阈值 */
  maxQueueLength: number;
}

/**
 * 预热配置接口
 */
export interface IWarmupConfig {
  /** 是否启用预热 */
  enabled: boolean;
  /** 预热请求数量 */
  requestCount: number;
  /** 预热请求间隔（毫秒） */
  requestInterval: number;
  /** 预热超时时间（毫秒） */
  timeout: number;
  /** 预热请求模板 */
  requestTemplate: IChatRequest;
}

/**
 * 批处理优化配置接口
 */
export interface IBatchOptimizationConfig {
  /** 是否启用智能批处理 */
  enabled: boolean;
  /** 动态批处理大小 */
  dynamicBatchSize: boolean;
  /** 最小批处理大小 */
  minBatchSize: number;
  /** 最大批处理大小 */
  maxBatchSize: number;
  /** 批处理超时时间（毫秒） */
  batchTimeout: number;
  /** 相似度阈值（用于请求分组） */
  similarityThreshold: number;
}

/**
 * 并发优化配置接口
 */
export interface IConcurrencyOptimizationConfig {
  /** 是否启用动态并发控制 */
  enabled: boolean;
  /** 最小并发数 */
  minConcurrency: number;
  /** 最大并发数 */
  maxConcurrency: number;
  /** 并发调整步长 */
  adjustmentStep: number;
  /** 性能评估窗口大小 */
  evaluationWindow: number;
  /** 调整间隔（毫秒） */
  adjustmentInterval: number;
}

/**
 * 性能优化策略接口
 */
export interface IOptimizationStrategy {
  /** 策略名称 */
  name: string;
  /** 策略描述 */
  description: string;
  /** 触发条件 */
  trigger: (metrics: IPerformanceMetrics) => boolean;
  /** 执行动作 */
  action: () => Promise<boolean>;
  /** 优先级（数字越小优先级越高） */
  priority: number;
  /** 冷却时间（毫秒） */
  cooldown: number;
  /** 最后执行时间 */
  lastExecuted: number;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * 性能统计信息接口
 */
export interface IPerformanceStatistics {
  /** 平均延迟（毫秒） */
  avgLatency: number;
  /** 最小延迟（毫秒） */
  minLatency: number;
  /** 最大延迟（毫秒） */
  maxLatency: number;
  /** 平均吞吐量（请求/秒） */
  avgThroughput: number;
  /** 峰值吞吐量（请求/秒） */
  peakThroughput: number;
  /** 总请求数 */
  totalRequests: number;
  /** 成功请求数 */
  successfulRequests: number;
  /** 失败请求数 */
  failedRequests: number;
  /** 优化执行次数 */
  optimizationCount: number;
  /** 统计开始时间 */
  startTime: Date;
  /** 最后更新时间 */
  lastUpdate: Date;
}

/**
 * 预热结果接口
 */
export interface IWarmupResult {
  /** 是否成功 */
  success: boolean;
  /** 执行时间（毫秒） */
  duration: number;
  /** 预热请求数 */
  requestCount: number;
  /** 成功请求数 */
  successfulRequests: number;
  /** 失败请求数 */
  failedRequests: number;
  /** 平均响应时间（毫秒） */
  avgResponseTime: number;
  /** 错误信息 */
  errors: string[];
}

/**
 * 性能优化服务
 */
export class PerformanceOptimizer extends EventEmitter {
  private performanceThresholds: IPerformanceThresholds;
  private warmupConfig: IWarmupConfig;
  private batchOptimizationConfig: IBatchOptimizationConfig;
  private concurrencyOptimizationConfig: IConcurrencyOptimizationConfig;
  private optimizationStrategies: IOptimizationStrategy[];
  private metricsHistory: IPerformanceMetrics[] = [];
  private statistics: IPerformanceStatistics;
  private monitoringTimer: NodeJS.Timeout | null = null;
  private isOptimizing = false;
  private isWarmedUp = false;
  private lastCpuUsage = process.cpuUsage();
  private requestTimes: number[] = [];
  private requestStartTimes: Map<string, number> = new Map();

  constructor() {
    super();

    // 初始化默认配置
    this.performanceThresholds = {
      maxLatency: 5000,        // 5秒
      minThroughput: 1,        // 1请求/秒
      maxMemoryUsage: 0.8,     // 80%
      maxCpuUsage: 0.8,        // 80%
      maxErrorRate: 0.1,       // 10%
      maxQueueLength: 50       // 50个请求
    };

    this.warmupConfig = {
      enabled: true,
      requestCount: 5,
      requestInterval: 1000,   // 1秒
      timeout: 30000,          // 30秒
      requestTemplate: {
        model: 'default',
        messages: [
          {
            role: 'user',
            content: 'Hello, this is a warmup request.'
          }
        ],
        temperature: 0.1,
        maxTokens: 50
      }
    };

    this.batchOptimizationConfig = {
      enabled: true,
      dynamicBatchSize: true,
      minBatchSize: 2,
      maxBatchSize: 10,
      batchTimeout: 100,       // 100毫秒
      similarityThreshold: 0.8
    };

    this.concurrencyOptimizationConfig = {
      enabled: true,
      minConcurrency: 1,
      maxConcurrency: 10,
      adjustmentStep: 1,
      evaluationWindow: 10,
      adjustmentInterval: 30000 // 30秒
    };

    this.optimizationStrategies = [
      {
        name: 'reduce-concurrency',
        description: '降低并发数以减少延迟',
        trigger: (metrics) => metrics.requestLatency > this.performanceThresholds.maxLatency,
        action: async () => this.reduceConcurrency(),
        priority: 1,
        cooldown: 30000,
        lastExecuted: 0,
        enabled: true
      },
      {
        name: 'increase-concurrency',
        description: '增加并发数以提高吞吐量',
        trigger: (metrics) => 
          metrics.throughput < this.performanceThresholds.minThroughput &&
          metrics.requestLatency < this.performanceThresholds.maxLatency * 0.5,
        action: async () => this.increaseConcurrency(),
        priority: 2,
        cooldown: 30000,
        lastExecuted: 0,
        enabled: true
      },
      {
        name: 'optimize-memory',
        description: '优化内存使用',
        trigger: (metrics) => metrics.memoryUsage > this.performanceThresholds.maxMemoryUsage,
        action: async () => this.optimizeMemory(),
        priority: 3,
        cooldown: 60000,
        lastExecuted: 0,
        enabled: true
      },
      {
        name: 'clear-queue',
        description: '清理过长的请求队列',
        trigger: (metrics) => metrics.queueLength > this.performanceThresholds.maxQueueLength,
        action: async () => this.clearQueue(),
        priority: 4,
        cooldown: 10000,
        lastExecuted: 0,
        enabled: true
      }
    ];

    this.statistics = {
      avgLatency: 0,
      minLatency: Infinity,
      maxLatency: 0,
      avgThroughput: 0,
      peakThroughput: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      optimizationCount: 0,
      startTime: new Date(),
      lastUpdate: new Date()
    };

    this.initializeService();
  }

  /**
   * 初始化服务
   */
  private async initializeService(): Promise<void> {
    try {
      // 从配置加载设置
      await this.loadConfiguration();

      // 启动性能监控
      this.startPerformanceMonitoring();

      loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, '性能优化服务初始化完成');
      this.emit('service-initialized');
    } catch (error) {
      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '服务初始化失败', error);
      this.emit('service-error', error);
    }
  }

  /**
   * 执行模型预热
   */
  async warmupModel(): Promise<IWarmupResult> {
    if (!this.warmupConfig.enabled) {
      return {
        success: false,
        duration: 0,
        requestCount: 0,
        successfulRequests: 0,
        failedRequests: 0,
        avgResponseTime: 0,
        errors: ['预热功能未启用']
      };
    }

    const startTime = performance.now();
    const errors: string[] = [];
    let successfulRequests = 0;
    let failedRequests = 0;
    const responseTimes: number[] = [];

    try {
      loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, '开始模型预热');
      this.emit('warmup-started');

      for (let i = 0; i < this.warmupConfig.requestCount; i++) {
        try {
          const requestStart = performance.now();
          
          // 发送预热请求
          await this.sendWarmupRequest();
          
          const requestTime = performance.now() - requestStart;
          responseTimes.push(requestTime);
          successfulRequests++;

          loggingService.debug(LogCategory.PERFORMANCE_OPTIMIZER, 
            `预热请求 ${i + 1}/${this.warmupConfig.requestCount} 完成，耗时: ${requestTime.toFixed(2)}ms`
          );

          // 等待间隔
          if (i < this.warmupConfig.requestCount - 1) {
            await new Promise(resolve => setTimeout(resolve, this.warmupConfig.requestInterval));
          }
        } catch (error) {
          failedRequests++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`预热请求 ${i + 1} 失败: ${errorMessage}`);
          
          loggingService.warn(LogCategory.PERFORMANCE_OPTIMIZER, 
            `预热请求 ${i + 1} 失败`, error
          );
        }
      }

      const duration = performance.now() - startTime;
      const avgResponseTime = responseTimes.length > 0 
        ? responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length 
        : 0;

      const result: IWarmupResult = {
        success: successfulRequests > 0,
        duration,
        requestCount: this.warmupConfig.requestCount,
        successfulRequests,
        failedRequests,
        avgResponseTime,
        errors
      };

      if (result.success) {
        this.isWarmedUp = true;
        loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, 
          `模型预热完成，成功: ${successfulRequests}/${this.warmupConfig.requestCount}，平均响应时间: ${avgResponseTime.toFixed(2)}ms`
        );
      } else {
        loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '模型预热失败', { errors });
      }

      this.emit('warmup-completed', result);
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      const result: IWarmupResult = {
        success: false,
        duration,
        requestCount: this.warmupConfig.requestCount,
        successfulRequests,
        failedRequests: this.warmupConfig.requestCount - successfulRequests,
        avgResponseTime: 0,
        errors: [errorMessage]
      };

      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '模型预热异常', error);
      this.emit('warmup-failed', result);
      return result;
    }
  }

  /**
   * 获取当前性能指标
   */
  async getCurrentMetrics(): Promise<IPerformanceMetrics> {
    const startTime = performance.now();

    try {
      // 获取内存信息
      const memoryInfo = await memoryManager.getCurrentMemoryInfo();
      
      // 获取并发统计
      const concurrencyStats = concurrencyController.getStats();
      
      // 计算CPU使用率
      const cpuUsage = this.calculateCpuUsage();
      
      // 计算请求延迟
      const requestLatency = this.calculateAverageLatency();
      
      // 计算吞吐量
      const throughput = this.calculateThroughput();
      
      // 计算错误率
      const errorRate = this.calculateErrorRate();

      const metrics: IPerformanceMetrics = {
        requestLatency,
        throughput,
        memoryUsage: memoryInfo.systemMemoryUsage,
        cpuUsage,
        errorRate,
        queueLength: concurrencyStats.queuedRequests,
        activeRequests: concurrencyStats.activeRequests,
        timestamp: new Date()
      };

      const executionTime = performance.now() - startTime;
      
      loggingService.debug(LogCategory.PERFORMANCE_OPTIMIZER,
        `性能指标获取完成，耗时: ${executionTime.toFixed(2)}ms`, metrics
      );

      return metrics;
    } catch (error) {
      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '获取性能指标失败', error);
      throw error;
    }
  }

  /**
   * 启动性能监控
   */
  startPerformanceMonitoring(): void {
    if (this.monitoringTimer) {
      this.stopPerformanceMonitoring();
    }

    const monitoringInterval = 10000; // 10秒

    this.monitoringTimer = setInterval(async () => {
      try {
        await this.performPerformanceCheck();
      } catch (error) {
        loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '性能检查失败', error);
      }
    }, monitoringInterval);

    loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, 
      `性能监控已启动，间隔: ${monitoringInterval}ms`
    );
    this.emit('monitoring-started');
  }

  /**
   * 停止性能监控
   */
  stopPerformanceMonitoring(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
      
      loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, '性能监控已停止');
      this.emit('monitoring-stopped');
    }
  }

  /**
   * 执行性能优化
   */
  async optimizePerformance(forceOptimization = false): Promise<{
    executed: string[];
    skipped: string[];
    errors: string[];
  }> {
    if (this.isOptimizing && !forceOptimization) {
      throw new Error('性能优化正在进行中');
    }

    this.isOptimizing = true;
    const executed: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    try {
      loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, '开始性能优化');
      this.emit('optimization-started');

      // 获取当前性能指标
      const currentMetrics = await this.getCurrentMetrics();
      
      // 选择适用的优化策略
      const applicableStrategies = this.optimizationStrategies
        .filter(strategy => strategy.enabled && strategy.trigger(currentMetrics))
        .sort((a, b) => a.priority - b.priority);

      if (applicableStrategies.length === 0) {
        loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, '没有需要执行的优化策略');
        return { executed, skipped, errors };
      }

      // 执行优化策略
      for (const strategy of applicableStrategies) {
        const now = Date.now();
        
        // 检查冷却时间
        if (!forceOptimization && now - strategy.lastExecuted < strategy.cooldown) {
          skipped.push(strategy.name);
          loggingService.debug(LogCategory.PERFORMANCE_OPTIMIZER, 
            `跳过策略 ${strategy.name}，仍在冷却期`
          );
          continue;
        }

        try {
          const success = await strategy.action();
          strategy.lastExecuted = now;
          
          if (success) {
            executed.push(strategy.name);
            loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, 
              `优化策略执行成功: ${strategy.name}`
            );
          } else {
            errors.push(`策略 ${strategy.name} 执行失败`);
            loggingService.warn(LogCategory.PERFORMANCE_OPTIMIZER, 
              `优化策略执行失败: ${strategy.name}`
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`策略 ${strategy.name} 执行异常: ${errorMessage}`);
          
          loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, 
            `优化策略执行异常: ${strategy.name}`, error
          );
        }
      }

      // 更新统计信息
      this.statistics.optimizationCount++;
      this.statistics.lastUpdate = new Date();

      loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, 
        `性能优化完成，执行: ${executed.length}，跳过: ${skipped.length}，错误: ${errors.length}`
      );

      this.emit('optimization-completed', { executed, skipped, errors });
      return { executed, skipped, errors };
    } catch (error) {
      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '性能优化失败', error);
      this.emit('optimization-failed', { error });
      throw error;
    } finally {
      this.isOptimizing = false;
    }
  }

  /**
   * 记录请求开始时间
   */
  recordRequestStart(requestId: string): void {
    this.requestStartTimes.set(requestId, performance.now());
  }

  /**
   * 记录请求完成时间
   */
  recordRequestEnd(requestId: string, success: boolean): void {
    const startTime = this.requestStartTimes.get(requestId);
    if (startTime) {
      const duration = performance.now() - startTime;
      this.requestTimes.push(duration);
      this.requestStartTimes.delete(requestId);

      // 保持请求时间数组在合理大小
      if (this.requestTimes.length > 1000) {
        this.requestTimes = this.requestTimes.slice(-1000);
      }

      // 更新统计信息
      this.statistics.totalRequests++;
      if (success) {
        this.statistics.successfulRequests++;
      } else {
        this.statistics.failedRequests++;
      }

      // 更新延迟统计
      if (duration < this.statistics.minLatency) {
        this.statistics.minLatency = duration;
      }
      if (duration > this.statistics.maxLatency) {
        this.statistics.maxLatency = duration;
      }

      this.statistics.lastUpdate = new Date();
    }
  }

  /**
   * 获取性能统计信息
   */
  getPerformanceStatistics(): IPerformanceStatistics {
    // 计算平均延迟
    if (this.requestTimes.length > 0) {
      this.statistics.avgLatency = this.requestTimes.reduce((sum, time) => sum + time, 0) / this.requestTimes.length;
    }

    return { ...this.statistics };
  }

  /**
   * 获取性能历史
   */
  getPerformanceHistory(limit?: number): IPerformanceMetrics[] {
    const history = [...this.metricsHistory];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * 更新性能阈值
   */
  updatePerformanceThresholds(thresholds: Partial<IPerformanceThresholds>): void {
    this.performanceThresholds = { ...this.performanceThresholds, ...thresholds };
    this.saveConfiguration();
    
    loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, '性能阈值已更新', thresholds);
    this.emit('thresholds-updated', this.performanceThresholds);
  }

  /**
   * 更新预热配置
   */
  updateWarmupConfig(config: Partial<IWarmupConfig>): void {
    this.warmupConfig = { ...this.warmupConfig, ...config };
    this.saveConfiguration();
    
    loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, '预热配置已更新', config);
    this.emit('warmup-config-updated', this.warmupConfig);
  }

  /**
   * 获取当前配置
   */
  getConfiguration(): {
    thresholds: IPerformanceThresholds;
    warmup: IWarmupConfig;
    batchOptimization: IBatchOptimizationConfig;
    concurrencyOptimization: IConcurrencyOptimizationConfig;
    strategies: IOptimizationStrategy[];
  } {
    return {
      thresholds: { ...this.performanceThresholds },
      warmup: { ...this.warmupConfig },
      batchOptimization: { ...this.batchOptimizationConfig },
      concurrencyOptimization: { ...this.concurrencyOptimizationConfig },
      strategies: [...this.optimizationStrategies]
    };
  }

  /**
   * 检查是否已预热
   */
  isModelWarmedUp(): boolean {
    return this.isWarmedUp;
  }

  /**
   * 执行性能检查
   */
  private async performPerformanceCheck(): Promise<void> {
    try {
      const metrics = await this.getCurrentMetrics();
      
      // 添加到历史记录
      this.addToHistory(metrics);
      
      // 发送性能指标更新事件
      this.emit('metrics-updated', metrics);
      
      // 检查是否需要自动优化
      if (this.shouldTriggerAutoOptimization(metrics)) {
        try {
          await this.optimizePerformance();
        } catch (error) {
          loggingService.warn(LogCategory.PERFORMANCE_OPTIMIZER, '自动性能优化失败', error);
        }
      }
    } catch (error) {
      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '性能检查执行失败', error);
    }
  }

  /**
   * 发送预热请求
   */
  private async sendWarmupRequest(): Promise<void> {
    // 这里应该调用实际的HTTP客户端发送请求
    // 为了简化，我们模拟一个请求
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
  }

  /**
   * 计算CPU使用率
   */
  private calculateCpuUsage(): number {
    const currentUsage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    
    const totalUsage = currentUsage.user + currentUsage.system;
    const totalTime = 1000000; // 1秒 = 1,000,000微秒
    
    return Math.min(totalUsage / totalTime, 1);
  }

  /**
   * 计算平均延迟
   */
  private calculateAverageLatency(): number {
    if (this.requestTimes.length === 0) return 0;
    
    const recentTimes = this.requestTimes.slice(-10); // 最近10个请求
    return recentTimes.reduce((sum, time) => sum + time, 0) / recentTimes.length;
  }

  /**
   * 计算吞吐量
   */
  private calculateThroughput(): number {
    const now = Date.now();
    const oneMinuteAgo = now - 60000; // 1分钟前
    
    // 计算最近1分钟内完成的请求数
    const recentRequests = this.requestTimes.filter((_, index) => {
      const requestTime = now - (this.requestTimes.length - index) * 1000; // 粗略估算
      return requestTime > oneMinuteAgo;
    });
    
    return recentRequests.length / 60; // 请求/秒
  }

  /**
   * 计算错误率
   */
  private calculateErrorRate(): number {
    if (this.statistics.totalRequests === 0) return 0;
    return this.statistics.failedRequests / this.statistics.totalRequests;
  }

  /**
   * 降低并发数
   */
  private async reduceConcurrency(): Promise<boolean> {
    try {
      const currentMax = this.concurrencyOptimizationConfig.maxConcurrency;
      const newMax = Math.max(
        currentMax - this.concurrencyOptimizationConfig.adjustmentStep,
        this.concurrencyOptimizationConfig.minConcurrency
      );
      
      if (newMax < currentMax) {
        concurrencyController.setMaxConcurrency(newMax);
        this.concurrencyOptimizationConfig.maxConcurrency = newMax;
        
        loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, 
          `并发数已降低: ${currentMax} -> ${newMax}`
        );
        return true;
      }
      
      return false;
    } catch (error) {
      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '降低并发数失败', error);
      return false;
    }
  }

  /**
   * 增加并发数
   */
  private async increaseConcurrency(): Promise<boolean> {
    try {
      const currentMax = this.concurrencyOptimizationConfig.maxConcurrency;
      const newMax = Math.min(
        currentMax + this.concurrencyOptimizationConfig.adjustmentStep,
        this.concurrencyOptimizationConfig.maxConcurrency
      );
      
      if (newMax > currentMax) {
        concurrencyController.setMaxConcurrency(newMax);
        this.concurrencyOptimizationConfig.maxConcurrency = newMax;
        
        loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, 
          `并发数已增加: ${currentMax} -> ${newMax}`
        );
        return true;
      }
      
      return false;
    } catch (error) {
      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '增加并发数失败', error);
      return false;
    }
  }

  /**
   * 优化内存
   */
  private async optimizeMemory(): Promise<boolean> {
    try {
      const result = await (memoryManager as any).optimizeMemory?.() || [];
      const totalMemoryReleased = result.reduce((sum: number, r: any) => 
        sum + (r.success ? r.memoryReleased : 0), 0
      );
      
      loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, 
        `内存优化完成，释放内存: ${totalMemoryReleased}MB`
      );
      
      return totalMemoryReleased > 0;
    } catch (error) {
      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '内存优化失败', error);
      return false;
    }
  }

  /**
   * 清理队列
   */
  private async clearQueue(): Promise<boolean> {
    try {
      const statsBefore = concurrencyController.getStats();
      concurrencyController.clearQueue();
      const statsAfter = concurrencyController.getStats();
      
      const clearedRequests = statsBefore.queuedRequests - statsAfter.queuedRequests;
      
      loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, 
        `队列已清理，清除请求数: ${clearedRequests}`
      );
      
      return clearedRequests > 0;
    } catch (error) {
      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '清理队列失败', error);
      return false;
    }
  }

  /**
   * 判断是否应该触发自动优化
   */
  private shouldTriggerAutoOptimization(metrics: IPerformanceMetrics): boolean {
    return this.optimizationStrategies.some(strategy => 
      strategy.enabled && strategy.trigger(metrics)
    );
  }

  /**
   * 添加到历史记录
   */
  private addToHistory(metrics: IPerformanceMetrics): void {
    this.metricsHistory.push(metrics);
    
    // 保持历史记录在合理大小
    if (this.metricsHistory.length > 1000) {
      this.metricsHistory = this.metricsHistory.slice(-1000);
    }
  }

  /**
   * 加载配置
   */
  private async loadConfiguration(): Promise<void> {
    try {
      // 从配置中加载性能相关设置（如果存在）
      // 这里我们使用默认配置，实际项目中可以扩展AppConfig或使用单独的配置文件
      
      loggingService.debug(LogCategory.PERFORMANCE_OPTIMIZER, '配置加载完成');
    } catch (error) {
      loggingService.warn(LogCategory.PERFORMANCE_OPTIMIZER, '加载配置失败，使用默认配置', error);
    }
  }

  /**
   * 保存配置
   */
  private saveConfiguration(): void {
    try {
      // 这里可以将配置保存到单独的文件或扩展AppConfig
      // 暂时跳过保存，使用内存中的配置
      
      loggingService.debug(LogCategory.PERFORMANCE_OPTIMIZER, '配置保存完成');
    } catch (error) {
      loggingService.error(LogCategory.PERFORMANCE_OPTIMIZER, '保存配置失败', error);
    }
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    this.stopPerformanceMonitoring();
    this.removeAllListeners();
    this.metricsHistory = [];
    this.requestTimes = [];
    this.requestStartTimes.clear();
    
    loggingService.info(LogCategory.PERFORMANCE_OPTIMIZER, '性能优化服务已清理');
  }
}

/**
 * 单例实例
 */
export const performanceOptimizer = new PerformanceOptimizer();