/**
 * Concurrency Controller - 并发请求控制
 */

import { EventEmitter } from 'events';
import {
  IConcurrencyController,
  IConcurrencyConfig
} from '@yonuc/types/llama-server';
import { t } from '@app/languages';

/**
 * 请求任务接口
 */
interface IRequestTask<T> {
  id: string;
  fn: () => Promise<T>;
  priority: number;
  timeout: number;
  createdAt: Date;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * 并发控制器实现
 */
export class ConcurrencyController extends EventEmitter implements IConcurrencyController {
  private config: IConcurrencyConfig;
  private activeRequests = 0;
  private requestQueue: IRequestTask<unknown>[] = [];
  private totalRequests = 0;
  private completedRequests = 0;
  private failedRequests = 0;

  constructor(config: Partial<IConcurrencyConfig> = {}) {
    super();

    // 默认配置
    this.config = {
      maxConcurrentRequests: 5,
      maxQueueLength: 100,
      requestTimeout: 30000,
      enablePriorityQueue: true,
      ...config
    };
  }

  /**
   * 执行请求（带并发控制）
   */
  async execute<T>(
    fn: () => Promise<T>,
    priority = 0,
    timeout?: number
  ): Promise<T> {
    this.totalRequests++;

    // 检查队列长度
    if (this.requestQueue.length >= this.config.maxQueueLength) {
      this.failedRequests++;
      throw new Error(t('请求队列已满'));
    }

    return new Promise<T>((resolve, reject) => {
      const task: IRequestTask<T> = {
        id: this.generateTaskId(),
        fn,
        priority,
        timeout: timeout || this.config.requestTimeout,
        createdAt: new Date(),
        resolve,
        reject
      };

      // 如果有可用的并发槽位，立即执行
      if (this.activeRequests < this.config.maxConcurrentRequests) {
        this.executeTask(task);
      } else {
        // 否则加入队列
        this.requestQueue.push(task as IRequestTask<unknown>);
        
        // 如果启用优先级队列，按优先级排序
        if (this.config.enablePriorityQueue) {
          this.requestQueue.sort((a, b) => b.priority - a.priority);
        }
        
        this.emit('task-queued', { taskId: task.id, queueLength: this.requestQueue.length });
      }
    });
  }

  /**
   * 获取当前并发统计
   */
  getStats(): {
    activeRequests: number;
    queuedRequests: number;
    totalRequests: number;
    completedRequests: number;
    failedRequests: number;
  } {
    return {
      activeRequests: this.activeRequests,
      queuedRequests: this.requestQueue.length,
      totalRequests: this.totalRequests,
      completedRequests: this.completedRequests,
      failedRequests: this.failedRequests
    };
  }

  /**
   * 设置最大并发数
   */
  setMaxConcurrency(maxConcurrency: number): void {
    const oldMax = this.config.maxConcurrentRequests;
    this.config.maxConcurrentRequests = maxConcurrency;
    
    this.emit('concurrency-changed', { oldMax, newMax: maxConcurrency });
    
    // 如果增加了并发数，尝试处理队列中的任务
    if (maxConcurrency > oldMax) {
      this.processQueue();
    }
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    const queueLength = this.requestQueue.length;
    
    // 拒绝所有排队的任务
    for (const task of this.requestQueue) {
      task.reject(new Error(t('队列已清空')));
      this.failedRequests++;
    }
    
    this.requestQueue = [];
    this.emit('queue-cleared', { clearedTasks: queueLength });
  }

  /**
   * 执行任务
   */
  private async executeTask<T>(task: IRequestTask<T>): Promise<void> {
    this.activeRequests++;
    
    const startTime = Date.now();
    let timeoutHandle: NodeJS.Timeout | null = null;
    
    this.emit('task-started', { 
      taskId: task.id, 
      activeRequests: this.activeRequests 
    });

    try {
      // 设置超时
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(t('请求超时 ({timeout}ms)', { timeout: task.timeout })));
        }, task.timeout);
      });

      // 执行任务或超时
      const result = await Promise.race([
        task.fn(),
        timeoutPromise
      ]);

      // 清除超时定时器
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const duration = Date.now() - startTime;
      this.completedRequests++;
      
      this.emit('task-completed', { 
        taskId: task.id, 
        duration,
        activeRequests: this.activeRequests - 1
      });
      
      task.resolve(result);
    } catch (error) {
      // 清除超时定时器
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const duration = Date.now() - startTime;
      this.failedRequests++;
      
      this.emit('task-failed', { 
        taskId: task.id, 
        error,
        duration,
        activeRequests: this.activeRequests - 1
      });
      
      task.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.activeRequests--;
      
      // 处理队列中的下一个任务
      this.processQueue();
    }
  }

  /**
   * 处理队列
   */
  private processQueue(): void {
    // 检查是否有可用的并发槽位和待处理的任务
    while (
      this.activeRequests < this.config.maxConcurrentRequests && 
      this.requestQueue.length > 0
    ) {
      const task = this.requestQueue.shift();
      if (task) {
        // 检查任务是否已超时
        const elapsed = Date.now() - task.createdAt.getTime();
        if (elapsed > task.timeout) {
          this.failedRequests++;
          task.reject(new Error(t('任务在队列中超时')));
          continue;
        }
        
        this.executeTask(task);
      }
    }
  }

  /**
   * 生成任务ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取队列中指定优先级的任务数量
   */
  getQueuedTasksByPriority(priority: number): number {
    return this.requestQueue.filter(task => task.priority === priority).length;
  }

  /**
   * 获取平均等待时间
   */
  getAverageWaitTime(): number {
    if (this.requestQueue.length === 0) {
      return 0;
    }

    const now = Date.now();
    const totalWaitTime = this.requestQueue.reduce((sum, task) => {
      return sum + (now - task.createdAt.getTime());
    }, 0);

    return totalWaitTime / this.requestQueue.length;
  }

  /**
   * 强制终止所有活跃请求
   */
  async forceTerminateAll(): Promise<void> {
    // 清空队列
    this.clearQueue();
    
    // 等待所有活跃请求完成（最多等待5秒）
    const maxWaitTime = 5000;
    const startTime = Date.now();
    
    while (this.activeRequests > 0 && (Date.now() - startTime) < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.emit('force-terminated', { 
      remainingActiveRequests: this.activeRequests 
    });
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.totalRequests = 0;
    this.completedRequests = 0;
    this.failedRequests = 0;
    
    this.emit('stats-reset');
  }
}

/**
 * 单例并发控制器实例
 */
export const concurrencyController = new ConcurrencyController();
