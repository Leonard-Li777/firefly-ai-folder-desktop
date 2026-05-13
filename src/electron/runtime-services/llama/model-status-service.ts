/**
 * Model Status Service - 管理模型状态显示和状态栏信息
 */

import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import {
  TModelCapabilityType
} from '@yonuc/types';
import {
  IModelCapabilityStatus,
} from './model-capability-detector';

import { ModelCapabilityDetector } from './model-capability-detector';
import { getLlamaModelConfig } from '../../model';
import { logger, LogCategory } from '@yonuc/shared';
import { t } from '@app/languages';

/**
 * 状态栏信息接口
 */
export interface IStatusBarInfo {
  /** 当前模型ID */
  currentModelId?: string;
  /** 模型名称 */
  modelName?: string;
  /** 模型状态 */
  status: 'idle' | 'loading' | 'ready' | 'error' | 'not-loaded';
  /** 支持的能力 */
  capabilities: TModelCapabilityType[];
  /** 能力限制摘要 */
  limitationsSummary: string[];
  /** 性能指标 */
  performance: {
    /** 内存使用百分比 */
    memoryUsage: number;
    /** 平均响应时间 */
    avgResponseTime: number;
    /** 当前负载 */
    currentLoad: number;
  };
  /** 警告信息 */
  warnings: string[];
  /** 最后更新时间 */
  lastUpdated: Date;
}

/**
 * 模型状态变更事件
 */
export interface IModelStatusChangeEvent {
  /** 模型ID */
  modelId: string;
  /** 旧状态 */
  oldStatus: IModelCapabilityStatus['status'];
  /** 新状态 */
  newStatus: IModelCapabilityStatus['status'];
  /** 变更时间 */
  timestamp: Date;
}

/**
 * 能力限制警告
 */
export interface ICapabilityWarning {
  /** 警告类型 */
  type: 'memory' | 'performance' | 'compatibility' | 'limitation';
  /** 警告级别 */
  level: 'info' | 'warning' | 'error';
  /** 警告消息 */
  message: string;
  /** 相关能力类型 */
  capabilityType?: TModelCapabilityType;
  /** 建议操作 */
  suggestedAction?: string;
}

/**
 * 模型状态服务
 */
export class ModelStatusService extends EventEmitter {
  private static instance: ModelStatusService;
  private currentModelId: string | null = null;
  private statusBarInfo: IStatusBarInfo | null = null;
  private statusUpdateInterval: NodeJS.Timeout | null = null;
  private performanceMetrics = {
    memoryUsage: 0,
    avgResponseTime: 0,
    currentLoad: 0,
    requestCount: 0,
    errorCount: 0
  };

  public static getInstance(): ModelStatusService {
    if (!ModelStatusService.instance) {
      ModelStatusService.instance = new ModelStatusService();
    }
    return ModelStatusService.instance;
  }

  private constructor() {
    super();
    this.initializeStatusUpdates();
  }

  /**
   * 设置当前模型
   */
  async setCurrentModel(modelId: string): Promise<void> {
    const oldModelId = this.currentModelId;
    this.currentModelId = modelId;

    try {
      // 获取模型状态
      const status = await ModelCapabilityDetector.getInstance().getModelStatus(modelId);

      // 更新状态栏信息
      await this.updateStatusBarInfo();

      // 发出模型变更事件
      this.emit('model-changed', {
        oldModelId,
        newModelId: modelId,
        timestamp: new Date()
      });

      logger.info(LogCategory.MODEL_STATUS, `[ModelStatusService] 当前模型已设置为: ${modelId}`);
    } catch (error) {
      logger.error(LogCategory.MODEL_STATUS, `[ModelStatusService] 设置当前模型失败:`, error);
      throw error;
    }
  }

  /**
   * 获取当前模型ID
   */
  getCurrentModelId(): string | null {
    return this.currentModelId;
  }

  /**
   * 获取状态栏信息
   */
  getStatusBarInfo(): IStatusBarInfo | null {
    return this.statusBarInfo;
  }

  /**
   * 更新性能指标
   */
  updatePerformanceMetrics(metrics: Partial<typeof this.performanceMetrics>): void {
    this.performanceMetrics = {
      ...this.performanceMetrics,
      ...metrics
    };

    // 触发状态栏更新
    this.updateStatusBarInfo().catch(error => {
      logger.error(LogCategory.MODEL_STATUS, '[ModelStatusService] 更新状态栏信息失败:', error);
    });
  }

  /**
   * 记录请求
   */
  recordRequest(success: boolean, responseTime: number): void {
    this.performanceMetrics.requestCount++;

    if (!success) {
      this.performanceMetrics.errorCount++;
    }

    // 更新平均响应时间（简单移动平均）
    const alpha = 0.1; // 平滑因子
    this.performanceMetrics.avgResponseTime =
      this.performanceMetrics.avgResponseTime * (1 - alpha) + responseTime * alpha;

    // 计算当前负载（基于最近的请求频率）
    this.updateCurrentLoad();
  }

  /**
   * 检查文件类型兼容性
   */
  async checkFileCompatibility(fileExtension: string): Promise<{
    compatible: boolean;
    warnings: ICapabilityWarning[];
    limitations: string[];
  }> {
    if (!this.currentModelId) {
      return {
        compatible: false,
        warnings: [{
          type: 'limitation',
          level: 'error',
          message: t('未选择模型'),
          suggestedAction: t('请先选择一个AI模型')
        }],
        limitations: [t('未选择模型')]
      };
    }

    try {
      const matchResult = await ModelCapabilityDetector.getInstance().checkFileTypeSupport(
        this.currentModelId,
        fileExtension
      );

      const warnings: ICapabilityWarning[] = [];

      if (!matchResult.supported) {
        warnings.push({
          type: 'compatibility',
          level: 'error',
          message: t('当前模型不支持 .{fileExtension} 文件', { fileExtension }),
          suggestedAction: t('请选择支持此文件类型的模型')
        });
      } else if (matchResult.matchScore < 70) {
        warnings.push({
          type: 'performance',
          level: 'warning',
          message: t('当前模型对 .{fileExtension} 文件的支持有限', { fileExtension }),
          suggestedAction: t('建议使用更适合的模型以获得更好效果')
        });
      }

      // 检查性能限制
      if (matchResult.performanceEstimate.successRate < 0.8) {
        warnings.push({
          type: 'performance',
          level: 'warning',
          message: t('处理成功率可能较低'),
          suggestedAction: t('建议使用更高质量的模型')
        });
      }

      return {
        compatible: matchResult.supported,
        warnings,
        limitations: matchResult.limitations
      };
    } catch (error) {
      return {
        compatible: false,
        warnings: [{
          type: 'limitation',
          level: 'error',
          message: t('检查兼容性时出错：{error}', { error: error instanceof Error ? error.message : String(error) }),
          suggestedAction: t('请检查模型配置')
        }],
        limitations: [t('检查失败')]
      };
    }
  }

  /**
   * 获取模型能力摘要
   */
  async getCapabilitySummary(): Promise<{
    supportedTypes: TModelCapabilityType[];
    limitations: string[];
    recommendations: string[];
  }> {
    if (!this.currentModelId) {
      return {
        supportedTypes: [],
        limitations: [t('未选择模型')],
        recommendations: [t('请先选择一个AI模型')]
      };
    }

    try {
      const modelConfig = getLlamaModelConfig(this.currentModelId);
      if (!modelConfig) {
        throw new Error('模型配置不存在');
      }

      const caps = modelConfig.capabilities || [];
      const supportedTypes = caps.map((cap: any) => typeof cap === 'string' ? cap : cap.type);
      const limitations: string[] = [];
      const recommendations: string[] = [];

      // 分析限制
      for (const capType of supportedTypes) {
        const capLimitations = await ModelCapabilityDetector.getInstance().getCapabilityLimitations(
          this.currentModelId,
          capType
        );
        limitations.push(...capLimitations);
      }

      // 生成建议
      if (modelConfig.vramRequiredGB > 8) {
        recommendations.push(t('建议使用高性能GPU以获得最佳体验'));
      }

      if (modelConfig.performance.speed === 'slow') {
        recommendations.push(t('处理大文件时请耐心等待'));
      }

      if (!modelConfig.isMultiModal && supportedTypes.length === 1) {
        recommendations.push(t('当前模型仅支持文本，考虑使用多模态模型获得更多功能'));
      }

      return {
        supportedTypes,
        limitations: [...new Set(limitations)], // 去重
        recommendations
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        supportedTypes: [],
        limitations: [t('获取能力信息失败：{error}', { error: errorMessage })],
        recommendations: [t('请检查模型配置')]
      };
    }
  }

  /**
   * 启动状态监控
   */
  startStatusMonitoring(intervalMs: number = 60000): void {
    if (this.statusUpdateInterval) {
      clearInterval(this.statusUpdateInterval);
    }

    this.statusUpdateInterval = setInterval(() => {
      this.updateStatusBarInfo().catch(error => {
        logger.error(LogCategory.MODEL_STATUS, '[ModelStatusService] 定期状态更新失败:', error);
      });
    }, intervalMs);

    logger.info(LogCategory.MODEL_STATUS, `[ModelStatusService] 状态监控已启动 (间隔: ${intervalMs / 1000}s)`);
  }

  /**
   * 停止状态监控
   */
  stopStatusMonitoring(): void {
    if (this.statusUpdateInterval) {
      clearInterval(this.statusUpdateInterval);
      this.statusUpdateInterval = null;
    }

    logger.info(LogCategory.MODEL_STATUS, '[ModelStatusService] 状态监控已停止');
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.stopStatusMonitoring();
    this.removeAllListeners();
  }

  /**
   * 初始化状态更新
   */
  private initializeStatusUpdates(): void {
    // 监听模型能力检测器的状态更新
    ModelCapabilityDetector.getInstance().on('status-updated', (event) => {
      if (event.modelId === this.currentModelId) {
        this.updateStatusBarInfo().catch(error => {
          logger.error(LogCategory.MODEL_STATUS, '[ModelStatusService] 响应状态更新失败:', error);
        });
      }
    });

    // 启动状态监控
    this.startStatusMonitoring();
  }

  /**
   * 更新状态栏信息
   */
  private async updateStatusBarInfo(): Promise<void> {
    if (!this.currentModelId) {
      this.statusBarInfo = {
        status: 'not-loaded',
        capabilities: [],
        limitationsSummary: [t('未选择模型')],
        performance: {
          memoryUsage: 0,
          avgResponseTime: 0,
          currentLoad: 0
        },
        warnings: [],
        lastUpdated: new Date()
      };
    } else {
      try {
        const modelConfig = getLlamaModelConfig(this.currentModelId);
        const modelStatus = await ModelCapabilityDetector.getInstance().getModelStatus(this.currentModelId);
        const capabilitySummary = await this.getCapabilitySummary();

        // 生成警告
        const warnings: string[] = [];
        if (this.performanceMetrics.errorCount > 0) {
          const errorRate = this.performanceMetrics.errorCount / this.performanceMetrics.requestCount;
          if (errorRate > 0.1) {
            warnings.push(t('错误率较高：{errorRatePercent}%', { errorRatePercent: (errorRate * 100).toFixed(1) }));
          }
        }

        if (this.performanceMetrics.memoryUsage > 90) {
          warnings.push(t('内存使用率过高'));
        }

        this.statusBarInfo = {
          currentModelId: this.currentModelId,
          modelName: modelConfig?.name,
          status: modelStatus.status,
          capabilities: capabilitySummary.supportedTypes,
          limitationsSummary: capabilitySummary.limitations.slice(0, 3), // 只显示前3个限制
          performance: {
            memoryUsage: this.performanceMetrics.memoryUsage,
            avgResponseTime: this.performanceMetrics.avgResponseTime,
            currentLoad: this.performanceMetrics.currentLoad
          },
          warnings,
          lastUpdated: new Date()
        };
      } catch (error) {
        logger.error(LogCategory.MODEL_STATUS, '[ModelStatusService] 更新状态栏信息时出错：', error);

        const errorMessage = error instanceof Error ? error.message : String(error);
        this.statusBarInfo = {
          currentModelId: this.currentModelId,
          status: 'error',
          capabilities: [],
          limitationsSummary: [t('状态更新失败：{error}', { error: errorMessage })],
          performance: {
            memoryUsage: 0,
            avgResponseTime: 0,
            currentLoad: 0
          },
          warnings: [t('状态获取失败')],
          lastUpdated: new Date()
        };
      }
    }

    // 广播状态更新到所有窗口
    this.broadcastStatusUpdate();
  }

  /**
   * 更新当前负载
   */
  private updateCurrentLoad(): void {
    // 基于最近的请求频率计算负载
    // 这里使用简单的算法，实际应用中可能需要更复杂的计算
    const recentRequests = this.performanceMetrics.requestCount;
    this.performanceMetrics.currentLoad = Math.min(100, recentRequests * 2);
  }

  /**
   * 广播状态更新
   */
  private broadcastStatusUpdate(): void {
    const payload = {
      statusBarInfo: this.statusBarInfo,
      timestamp: new Date()
    };

    // 发送到所有窗口
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('model-status-updated', payload);
    });

    // 发出本地事件
    this.emit('status-updated', payload);
  }
}

/**
 * 单例实例
 * 注意：由于可能的循环依赖，建议在方法内部使用 ModelStatusService.getInstance()
 */
export const modelStatusService = ModelStatusService.getInstance();
