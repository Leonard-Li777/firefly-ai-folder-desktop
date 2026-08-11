/**
 * HTTP Client - 与llama-server进行HTTP通信
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { EventEmitter } from 'events';
import {
  IHttpClient,
  IHttpClientConfig,
  IChatRequest,
  IChatResponse,
  IChatChunk,
  IEmbeddingRequest,
  IEmbeddingResponse,
  IHealthResponse,
  IModelInfo,
  IBatchRequest,
  IBatchResponse
} from '@yonuc/types/llama-server';
import { ConnectionPool } from './connection-pool';
import { BatchProcessor } from './batch-processor';
import { ConcurrencyController } from './concurrency-controller';
import { logger, LogCategory } from '@yonuc/shared';
import { t } from '@app/languages';

/**
 * HTTP客户端实现
 */
export class HttpClient extends EventEmitter implements IHttpClient {
  private axiosInstance: AxiosInstance;
  private config: IHttpClientConfig;
  private connectionPool: ConnectionPool;
  private batchProcessor: BatchProcessor<IChatRequest, IChatResponse>;
  private concurrencyController: ConcurrencyController;

  constructor(config: Partial<IHttpClientConfig> = {}) {
    super();

    // 默认配置
    this.config = {
      baseURL: 'http://localhost:8172',
      timeout: 90000,  // 增加到90秒 (原来30秒)
      maxRetries: 3,
      retryDelay: 1000,
      enableLogging: true,
      ...config
    };

    // 创建连接池
    this.connectionPool = new ConnectionPool({
      maxConnections: 10,
      maxIdleConnections: 5,
      connectionTimeout: this.config.timeout,
      keepAlive: true
    });

    // 创建并发控制器
    this.concurrencyController = new ConcurrencyController({
      maxConcurrentRequests: 5,
      maxQueueLength: 100,
      requestTimeout: this.config.timeout
    });

    // 创建批处理器
    this.batchProcessor = new BatchProcessor<IChatRequest, IChatResponse>(
      {
        batchSize: 5,
        batchTimeout: 1000,
        maxConcurrentBatches: 2
      },
      this.handleBatchRequests.bind(this)
    );

    // 创建axios实例
    this.axiosInstance = axios.create({
      baseURL: this.config.baseURL,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers
      },
      // 使用连接池的HTTP代理
      httpAgent: this.connectionPool.getHttpAgent(),
      httpsAgent: this.connectionPool.getHttpsAgent()
    });

    // 设置请求拦截器
    this.setupRequestInterceptor();
    
    // 设置响应拦截器
    this.setupResponseInterceptor();
  }

  /**
   * 发送聊天请求
   */
  async chatCompletion(request: IChatRequest): Promise<IChatResponse> {
    // 使用并发控制器执行请求
    return this.concurrencyController.execute(async () => {
      try {
        this.log('info', `发送聊天请求: ${request.messages.length} 条消息`);
        
        const startTime = Date.now();
        const response = await this.axiosInstance.post<IChatResponse>('/v1/chat/completions', {
          ...request,
          stream: false // 确保非流式响应
        });

        const responseTime = Date.now() - startTime;
        this.connectionPool.recordSuccess(responseTime);

        this.log('info', `聊天请求成功，响应长度: ${response.data.choices[0]?.message?.content?.length || 0}, 耗时: ${responseTime}ms`);
        return response.data;
      } catch (error) {
        this.connectionPool.recordFailure();
        this.log('error', `聊天请求失败: ${this.getErrorMessage(error)}`);
        throw this.handleError(error);
      }
    }, 1); // 优先级为1
  }

  /**
   * 发送批量聊天请求
   */
  async chatCompletionBatch(request: IChatRequest): Promise<IChatResponse> {
    const batchRequest: IBatchRequest<IChatRequest> = {
      id: this.generateRequestId(),
      data: request,
      priority: 1,
      createdAt: new Date()
    };

    const response = await this.batchProcessor.addRequest(batchRequest);
    
    if (response.error) {
      throw response.error;
    }
    
    if (!response.data) {
      throw new Error(t('批处理响应数据为空'));
    }
    return response.data;
  }

  /**
   * 发送流式聊天请求
   */
  async* chatCompletionStream(request: IChatRequest): AsyncIterable<IChatChunk> {
    try {
      this.log('info', `发送流式聊天请求: ${request.messages.length} 条消息`);
      
      const isOllama = this.config.baseURL.includes(':11434');
      const maxTokens = (request as any).max_tokens || (request as any).maxTokens;

      const requestData: any = {
        ...request,
        max_tokens: maxTokens,
        stream: true
      };

      // 针对 Ollama 注入特殊控制参数
      if (isOllama) {
        // 注入 options 对象 (Ollama 原生参数存放地)
        requestData.options = { 
          ...(requestData.options || {}), 
          num_predict: maxTokens // Ollama 的 max_tokens 对应 num_predict
        };

        this.log('debug', requestData);
      }

      const response = await this.axiosInstance.post('/v1/chat/completions', requestData, {
        responseType: 'stream',
        timeout: 0 // 流式请求不设置超时
      });

      const stream = response.data;
      let buffer = '';

      for await (const chunk of this.readStream(stream)) {
        buffer += chunk;
        
        // 处理服务器发送事件（SSE）格式
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后一个不完整的行

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            
            if (data === '[DONE]') {
              this.log('info', '流式聊天请求完成');
              return;
            }

            try {
              const chunk: IChatChunk = JSON.parse(data);
              yield chunk;
            } catch (parseError) {
              this.log('warn', `解析流式数据失败: ${parseError}`);
            }
          }
        }
      }
    } catch (error) {
      this.log('error', `流式聊天请求失败: ${this.getErrorMessage(error)}`);
      throw this.handleError(error);
    }
  }

  /**
   * 生成嵌入向量
   */
  async embeddings(request: IEmbeddingRequest): Promise<IEmbeddingResponse> {
    return this.concurrencyController.execute(async () => {
      try {
        this.log('info', `发送嵌入请求: ${Array.isArray(request.input) ? request.input.length : 1} 个输入`);
        
        const startTime = Date.now();
        const response = await this.axiosInstance.post<IEmbeddingResponse>('/v1/embeddings', request);

        const responseTime = Date.now() - startTime;
        this.connectionPool.recordSuccess(responseTime);

        this.log('info', `嵌入请求成功，返回 ${response.data.data.length} 个向量, 耗时: ${responseTime}ms`);
        
        return response.data;
      } catch (error) {
        this.connectionPool.recordFailure();
        this.log('error', `嵌入请求失败: ${this.getErrorMessage(error)}`);
        throw this.handleError(error);
      }
    }, 2); // 优先级为2
  }

  /**
   * 健康检查
   */
  async health(): Promise<IHealthResponse> {
    try {
      const response = await this.axiosInstance.get<IHealthResponse>('/health');
      
      this.log('debug', `健康检查成功: ${response.data.status}`);
      
      return response.data;
    } catch (error) {
      this.log('error', `健康检查失败: ${this.getErrorMessage(error)}`);
      throw this.handleError(error);
    }
  }

  /**
   * 获取模型信息
   */
  async getModels(): Promise<IModelInfo[]> {
    try {
      const response = await this.axiosInstance.get<{ data: IModelInfo[] }>('/v1/models');
      
      this.log('info', `获取模型列表成功: ${response.data.data.length} 个模型`);
      
      return response.data.data;
    } catch (error) {
      this.log('error', `获取模型列表失败: ${this.getErrorMessage(error)}`);
      throw this.handleError(error);
    }
  }

  /**
   * 获取特定模型信息
   */
  async getModel(modelId: string): Promise<IModelInfo> {
    try {
      const response = await this.axiosInstance.get<IModelInfo>(`/v1/models/${modelId}`);
      
      this.log('info', `获取模型信息成功: ${modelId}`);
      
      return response.data;
    } catch (error) {
      this.log('error', `获取模型信息失败: ${this.getErrorMessage(error)}`);
      throw this.handleError(error);
    }
  }

  /**
   * 设置配置
   */
  setConfig(config: Partial<IHttpClientConfig>): void {
    this.config = { ...this.config, ...config };
    
    // 更新axios实例配置
    this.axiosInstance.defaults.baseURL = this.config.baseURL;
    this.axiosInstance.defaults.timeout = this.config.timeout;
    
    if (this.config.headers) {
      this.axiosInstance.defaults.headers = {
        ...this.axiosInstance.defaults.headers,
        ...this.config.headers
      };
    }

    this.log('info', `HTTP客户端配置已更新: ${this.config.baseURL}`);
  }

  /**
   * 获取配置
   */
  getConfig(): IHttpClientConfig {
    return { ...this.config };
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.health();
      return true;
    } catch (error) {
      this.log('warn', `连接测试失败: ${this.getErrorMessage(error)}`);
      return false;
    }
  }

  /**
   * 设置请求拦截器
   */
  private setupRequestInterceptor(): void {
    this.axiosInstance.interceptors.request.use(
      (config) => {
        if (this.config.enableLogging) {
          this.log('debug', `发送请求: ${config.method?.toUpperCase()} ${config.url}`);
        }
        
        // 添加请求时间戳
        (config as unknown as Record<string, unknown>).metadata = { startTime: Date.now() };
        
        return config;
      },
      (error) => {
        this.log('error', `请求拦截器错误: ${error}`);
        return Promise.reject(error);
      }
    );
  }

  /**
   * 设置响应拦截器
   */
  private setupResponseInterceptor(): void {
    this.axiosInstance.interceptors.response.use(
      (response) => {
        if (this.config.enableLogging) {
          const duration = Date.now() - (((response.config as unknown as Record<string, unknown>).metadata as { startTime: number })?.startTime || 0);
          this.log('debug', `响应成功: ${response.status} (${duration}ms)`);
        }
        
        return response;
      },
      async (error) => {
        const originalRequest = error.config;
        
        // 如果是网络错误或5xx错误，尝试重试
        if (this.shouldRetry(error) && !originalRequest._retry) {
          originalRequest._retry = true;
          originalRequest._retryCount = (originalRequest._retryCount || 0) + 1;
          
          if (originalRequest._retryCount <= this.config.maxRetries) {
            this.log('warn', `请求失败，第 ${originalRequest._retryCount} 次重试: ${error.message}`);
            
            // 等待重试延迟
            await this.delay(this.config.retryDelay * originalRequest._retryCount);
            
            return this.axiosInstance(originalRequest);
          }
        }
        
        return Promise.reject(error);
      }
    );
  }

  /**
   * 判断是否应该重试
   */
  private shouldRetry(error: AxiosError): boolean {
    // 网络错误
    if (!error.response) {
      return true;
    }
    
    // 5xx服务器错误
    if (error.response.status >= 500) {
      return true;
    }
    
    // 429 请求过多
    if (error.response.status === 429) {
      return true;
    }
    
    return false;
  }

  /**
   * 处理错误
   */
  private handleError(error: unknown): Error {
    if (error instanceof AxiosError) {
      if (error.response) {
        // 服务器响应错误
        const status = error.response.status;
        const data = error.response.data;
        
        let message = `HTTP ${status}`;
        if (data?.error?.message) {
          message += `: ${data.error.message}`;
        } else if (data?.message) {
          message += `: ${data.message}`;
        } else {
          message += `: ${error.message}`;
        }
        
        return new Error(message);
      } else if (error.request) {
        // 网络错误
        return new Error(t('网络连接失败: {message}', { message: error.message }));
      }
    }
    
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * 获取错误消息
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof AxiosError) {
      if (error.response) {
        return `HTTP ${error.response.status}: ${error.response.data?.message || error.message}`;
      } else if (error.request) {
        return t('网络错误: {message}', { message: error.message });
      }
    }
    
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 读取流数据
   */
  private async* readStream(stream: NodeJS.ReadableStream): AsyncIterable<string> {
    let buffer = '';
    
    for await (const chunk of stream) {
      buffer += chunk.toString();
      
      // 按行分割
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一个不完整的行
      
      for (const line of lines) {
        if (line.trim()) {
          yield line + '\n';
        }
      }
    }
    
    // 处理剩余的buffer
    if (buffer.trim()) {
      yield buffer;
    }
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 记录日志
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (this.config.enableLogging) {
      const timestamp = new Date().toISOString();
      logger.info(LogCategory.HTTP_CLIENT, `[${timestamp}] [HTTP-Client] [${level.toUpperCase()}] ${message}`);
      
      // 发出日志事件
      this.emit('log', { level, message, timestamp });
    }
  }

  /**
   * 处理批量请求
   */
  private async handleBatchRequests(requests: IBatchRequest<IChatRequest>[]): Promise<IBatchResponse<IChatResponse>[]> {

    
    // 并行处理批次中的所有请求
    const promises = requests.map(async (request) => {
      const startTime = Date.now();
      
      try {
        const response = await this.axiosInstance.post<IChatResponse>('/v1/chat/completions', {
          ...request.data,
          stream: false
        });
        
        const processingTime = Date.now() - startTime;
        this.connectionPool.recordSuccess(processingTime);
        
        return {
          id: request.id,
          data: response.data,
          processingTime
        };
      } catch (error) {
        this.connectionPool.recordFailure();
        
        return {
          id: request.id,
          error: this.handleError(error),
          processingTime: Date.now() - startTime
        };
      }
    });
    
    return Promise.all(promises);
  }

  /**
   * 生成请求ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取连接池统计信息
   */
  getConnectionPoolStats() {
    return this.connectionPool.getStats();
  }

  /**
   * 获取并发控制统计信息
   */
  getConcurrencyStats() {
    return this.concurrencyController.getStats();
  }

  /**
   * 获取批处理统计信息
   */
  getBatchProcessorStats() {
    return this.batchProcessor.getQueueStats();
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    // 停止批处理器
    await this.batchProcessor.stop();
    
    // 强制终止所有并发请求
    await this.concurrencyController.forceTerminateAll();
    
    // 关闭连接池
    await this.connectionPool.close();
    
    this.removeAllListeners();
  }
}

/**
 * 创建HTTP客户端实例
 */
export function createHttpClient(config?: Partial<IHttpClientConfig>): HttpClient {
  return new HttpClient(config);
}

/**
 * 默认HTTP客户端实例
 */
export const httpClient = new HttpClient();
