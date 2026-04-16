/**
 * Connection Pool - HTTP连接池管理
 */

import { EventEmitter } from 'events';
import { Agent } from 'http';
import { Agent as HttpsAgent } from 'https';
import {
  IConnectionPool,
  IConnectionPoolConfig,
  IConnectionInfo,
  IConnectionPoolStats
} from '@yonuc/types/llama-server';
import { t } from '@app/languages';

/**
 * 连接池实现
 */
export class ConnectionPool extends EventEmitter implements IConnectionPool {
  private config: IConnectionPoolConfig;
  private connections: Map<string, IConnectionInfo> = new Map();
  private httpAgent: Agent;
  private httpsAgent: HttpsAgent;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private stats: IConnectionPoolStats;

  constructor(config: Partial<IConnectionPoolConfig> = {}) {
    super();

    // 默认配置
    this.config = {
      maxConnections: 10,
      maxIdleConnections: 5,
      connectionTimeout: 30000,
      idleTimeout: 60000,
      keepAlive: true,
      keepAliveInitialDelay: 1000,
      ...config
    };

    // 初始化统计信息
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      idleConnections: 0,
      queueLength: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0,
      hitRate: 0
    };

    // 创建HTTP代理
    this.httpAgent = new Agent({
      keepAlive: this.config.keepAlive,
      keepAliveMsecs: this.config.keepAliveInitialDelay,
      maxSockets: this.config.maxConnections,
      maxFreeSockets: this.config.maxIdleConnections,
      timeout: this.config.connectionTimeout
    });

    this.httpsAgent = new HttpsAgent({
      keepAlive: this.config.keepAlive,
      keepAliveMsecs: this.config.keepAliveInitialDelay,
      maxSockets: this.config.maxConnections,
      maxFreeSockets: this.config.maxIdleConnections,
      timeout: this.config.connectionTimeout
    });

    // 启动清理定时器
    this.startCleanupTimer();
  }

  /**
   * 获取连接
   */
  async getConnection(): Promise<IConnectionInfo> {
    this.stats.totalRequests++;

    // 查找空闲连接
    const idleConnection = this.findIdleConnection();
    if (idleConnection) {
      this.activateConnection(idleConnection);
      this.stats.hitRate = this.calculateHitRate();
      return idleConnection;
    }

    // 如果没有空闲连接且未达到最大连接数，创建新连接
    if (this.connections.size < this.config.maxConnections) {
      const newConnection = this.createConnection();
      this.connections.set(newConnection.id, newConnection);
      this.updateStats();
      return newConnection;
    }

    // 等待连接可用
    return this.waitForConnection();
  }

  /**
   * 释放连接
   */
  releaseConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    connection.isActive = false;
    connection.isIdle = true;
    connection.lastUsedAt = new Date();

    this.updateStats();
    this.emit('connection-released', connection);
  }

  /**
   * 关闭连接
   */
  closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    this.connections.delete(connectionId);
    this.updateStats();
    this.emit('connection-closed', connection);
  }

  /**
   * 获取连接池统计信息
   */
  getStats(): IConnectionPoolStats {
    return { ...this.stats };
  }

  /**
   * 清理空闲连接
   */
  cleanupIdleConnections(): void {
    const now = new Date();
    const connectionsToClose: string[] = [];

    for (const [id, connection] of this.connections) {
      if (connection.isIdle) {
        const idleTime = now.getTime() - connection.lastUsedAt.getTime();
        if (idleTime > this.config.idleTimeout) {
          connectionsToClose.push(id);
        }
      }
    }

    for (const id of connectionsToClose) {
      this.closeConnection(id);
    }

    if (connectionsToClose.length > 0) {
      this.emit('cleanup', { closedConnections: connectionsToClose.length });
    }
  }

  /**
   * 关闭连接池
   */
  async close(): Promise<void> {
    // 停止清理定时器
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // 关闭所有连接
    const connectionIds = Array.from(this.connections.keys());
    for (const id of connectionIds) {
      this.closeConnection(id);
    }

    // 销毁HTTP代理
    this.httpAgent.destroy();
    this.httpsAgent.destroy();

    this.emit('closed');
  }

  /**
   * 获取HTTP代理
   */
  getHttpAgent(): Agent {
    return this.httpAgent;
  }

  /**
   * 获取HTTPS代理
   */
  getHttpsAgent(): HttpsAgent {
    return this.httpsAgent;
  }

  /**
   * 查找空闲连接
   */
  private findIdleConnection(): IConnectionInfo | null {
    for (const connection of this.connections.values()) {
      if (connection.isIdle && !connection.isActive) {
        return connection;
      }
    }
    return null;
  }

  /**
   * 激活连接
   */
  private activateConnection(connection: IConnectionInfo): void {
    connection.isActive = true;
    connection.isIdle = false;
    connection.lastUsedAt = new Date();
    connection.usageCount++;
    this.updateStats();
  }

  /**
   * 创建新连接
   */
  private createConnection(): IConnectionInfo {
    const connection: IConnectionInfo = {
      id: this.generateConnectionId(),
      createdAt: new Date(),
      lastUsedAt: new Date(),
      usageCount: 1,
      isIdle: false,
      isActive: true
    };

    this.emit('connection-created', connection);
    return connection;
  }

  /**
   * 等待连接可用
   */
  private async waitForConnection(): Promise<IConnectionInfo> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(t('等待连接超时')));
      }, this.config.connectionTimeout);

      const onConnectionReleased = (connection: IConnectionInfo) => {
        clearTimeout(timeout);
        this.off('connection-released', onConnectionReleased);
        this.activateConnection(connection);
        resolve(connection);
      };

      this.on('connection-released', onConnectionReleased);
    });
  }

  /**
   * 更新统计信息
   */
  private updateStats(): void {
    this.stats.totalConnections = this.connections.size;
    this.stats.activeConnections = Array.from(this.connections.values())
      .filter(conn => conn.isActive).length;
    this.stats.idleConnections = Array.from(this.connections.values())
      .filter(conn => conn.isIdle).length;
  }

  /**
   * 计算命中率
   */
  private calculateHitRate(): number {
    if (this.stats.totalRequests === 0) {
      return 0;
    }
    return this.stats.successfulRequests / this.stats.totalRequests;
  }

  /**
   * 生成连接ID
   */
  private generateConnectionId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleConnections();
    }, this.config.idleTimeout / 2); // 每半个空闲超时时间清理一次
  }

  /**
   * 记录成功请求
   */
  recordSuccess(responseTime: number): void {
    this.stats.successfulRequests++;
    this.updateAvgResponseTime(responseTime);
  }

  /**
   * 记录失败请求
   */
  recordFailure(): void {
    this.stats.failedRequests++;
  }

  /**
   * 更新平均响应时间
   */
  private updateAvgResponseTime(responseTime: number): void {
    const totalRequests = this.stats.successfulRequests;
    if (totalRequests === 1) {
      this.stats.avgResponseTime = responseTime;
    } else {
      this.stats.avgResponseTime = 
        (this.stats.avgResponseTime * (totalRequests - 1) + responseTime) / totalRequests;
    }
  }
}

/**
 * 单例连接池实例
 */
export const connectionPool = new ConnectionPool();

