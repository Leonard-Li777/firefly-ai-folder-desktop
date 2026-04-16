/**
 * Batch Processor - 请求批处理管理
 */

import { EventEmitter } from 'events';
import {
  IBatchProcessor,
  IBatchProcessorConfig,
  IBatchRequest,
  IBatchResponse
} from '@yonuc/types/llama-server';

/**
 * 扩展的批处理请求接口
 */
interface IExtendedBatchRequest<T, R = unknown> extends IBatchRequest<T> {
  resolve?: (value: IBatchResponse<R>) => void;
  reject?: (error: Error) => void;
  addedAt?: Date;
}

/**
 * 批处理器实现
 */
export class BatchProcessor<TRequest, TResponse> extends EventEmitter implements IBatchProcessor<TRequest, TResponse> {
  private config: IBatchProcessorConfig;
  private requestQueue: IExtendedBatchRequest<TRequest, TResponse>[] = [];
  private processingBatches = 0;
  private totalProcessed = 0;
  private processingTimes: number[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private isRunning = true;

  constructor(
    config: Partial<IBatchProcessorConfig> = {},
    private batchHandler: (requests: IBatchRequest<TRequest>[]) => Promise<IBatchResponse<TResponse>[]>
  ) {
    super();

    // 默认配置
    this.config = {
      batchSize: 10,
      batchTimeout: 1000,
      maxConcurrentBatches: 3,
      maxQueueLength: 1000,
      enablePrioritySort: true,
      ...config
    };

    // 启动批处理循环
    this.startBatchProcessing();
  }

  /**
   * 添加请求到批处理队列
   */
  async addRequest(request: IBatchRequest<TRequest>): Promise<IBatchResponse<TResponse>> {
    if (!this.isRunning) {
      throw new Error('批处理器已停止');
    }

    if (this.requestQueue.length >= this.config.maxQueueLength) {
      throw new Error('批处理队列已满');
    }

    return new Promise((resolve, reject) => {
      // 添加解析器到请求对象
      const requestWithResolver: IExtendedBatchRequest<TRequest, TResponse> = {
        ...request,
        resolve,
        reject,
        addedAt: new Date()
      };

      this.requestQueue.push(requestWithResolver);

      // 如果启用优先级排序，对队列进行排序
      if (this.config.enablePrioritySort) {
        this.requestQueue.sort((a, b) => b.priority - a.priority);
      }

      this.emit('request-added', request);

      // 如果队列达到批处理大小，立即处理
      if (this.requestQueue.length >= this.config.batchSize) {
        this.processBatchImmediate();
      }
    });
  }

  /**
   * 处理批次
   */
  async processBatch(requests: IBatchRequest<TRequest>[]): Promise<IBatchResponse<TResponse>[]> {
    if (requests.length === 0) {
      return [];
    }

    const startTime = Date.now();
    
    try {
      this.processingBatches++;
      this.emit('batch-start', { batchSize: requests.length });

      // 调用批处理处理器
      const responses = await this.batchHandler(requests);
      
      const processingTime = Date.now() - startTime;
      this.recordProcessingTime(processingTime);
      this.totalProcessed += requests.length;

      this.emit('batch-complete', { 
        batchSize: requests.length, 
        processingTime,
        responses: responses.length
      });

      return responses;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      // 创建错误响应
      const errorResponses: IBatchResponse<TResponse>[] = requests.map(req => ({
        id: req.id,
        error: error instanceof Error ? error : new Error(String(error)),
        processingTime
      }));

      this.emit('batch-error', { 
        batchSize: requests.length, 
        error,
        processingTime
      });

      return errorResponses;
    } finally {
      this.processingBatches--;
    }
  }

  /**
   * 获取队列统计信息
   */
  getQueueStats(): {
    queueLength: number;
    processingBatches: number;
    totalProcessed: number;
    avgProcessingTime: number;
  } {
    const avgProcessingTime = this.processingTimes.length > 0
      ? this.processingTimes.reduce((sum, time) => sum + time, 0) / this.processingTimes.length
      : 0;

    return {
      queueLength: this.requestQueue.length,
      processingBatches: this.processingBatches,
      totalProcessed: this.totalProcessed,
      avgProcessingTime
    };
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    // 拒绝所有等待的请求
    for (const request of this.requestQueue) {
      if (request.reject) {
        request.reject(new Error('队列已清空'));
      }
    }

    this.requestQueue = [];
    this.emit('queue-cleared');
  }

  /**
   * 停止批处理器
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    // 停止批处理定时器
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // 处理剩余的请求
    if (this.requestQueue.length > 0) {
      await this.processBatchImmediate();
    }

    // 等待所有批次处理完成
    while (this.processingBatches > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }

    this.emit('stopped');
  }

  /**
   * 启动批处理循环
   */
  private startBatchProcessing(): void {
    const processBatchCycle = () => {
      if (!this.isRunning) {
        return;
      }

      // 如果有请求且未达到最大并发批次数，处理批次
      if (this.requestQueue.length > 0 && this.processingBatches < this.config.maxConcurrentBatches) {
        this.processBatchImmediate();
      }

      // 设置下一次处理
      this.batchTimer = setTimeout(processBatchCycle, this.config.batchTimeout);
    };

    processBatchCycle();
  }

  /**
   * 立即处理批次
   */
  private processBatchImmediate(): void {
    if (this.requestQueue.length === 0 || this.processingBatches >= this.config.maxConcurrentBatches) {
      return;
    }

    // 提取一个批次的请求
    const batchSize = Math.min(this.config.batchSize, this.requestQueue.length);
    const batch = this.requestQueue.splice(0, batchSize);

    // 检查超时的请求
    const now = Date.now();
    const validRequests: IExtendedBatchRequest<TRequest, TResponse>[] = [];
    
    for (const request of batch) {
      const timeoutMs = request.timeout || 30000; // 默认30秒超时
      const elapsed = now - request.createdAt.getTime();
      
      if (elapsed > timeoutMs) {
        // 请求已超时
        if (request.reject) {
          request.reject(new Error('请求超时'));
        }
      } else {
        validRequests.push(request);
      }
    }

    if (validRequests.length === 0) {
      return;
    }

    // 异步处理批次
    this.processBatch(validRequests).then(responses => {
      // 将响应分发给对应的请求
      for (let i = 0; i < validRequests.length; i++) {
        const request = validRequests[i];
        const response = responses[i];
        
        if (request.resolve) {
          request.resolve(response);
        }
      }
    }).catch((error: Error) => {
      // 处理批次失败，拒绝所有请求
      for (const request of validRequests) {
        if (request.reject) {
          request.reject(error);
        }
      }
    });
  }

  /**
   * 记录处理时间
   */
  private recordProcessingTime(time: number): void {
    this.processingTimes.push(time);
    
    // 保持最近100次的处理时间
    if (this.processingTimes.length > 100) {
      this.processingTimes.shift();
    }
  }
}

/**
 * 创建批处理器
 */
export function createBatchProcessor<TRequest, TResponse>(
  config: Partial<IBatchProcessorConfig>,
  batchHandler: (requests: IBatchRequest<TRequest>[]) => Promise<IBatchResponse<TResponse>[]>
): BatchProcessor<TRequest, TResponse> {
  return new BatchProcessor(config, batchHandler);
}