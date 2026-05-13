import { session } from 'electron';
import { LogCategory, logger } from '@yonuc/shared';
import { LicenseService } from '../runtime-services/system/license-service';

/**
 * 网络拦截服务
 * 负责在企业模式下实施严格的网络访问控制
 */
export class NetworkInterceptorService {
  private static instance: NetworkInterceptorService | null = null;

  private constructor() {}

  static getInstance(): NetworkInterceptorService {
    if (!NetworkInterceptorService.instance) {
      NetworkInterceptorService.instance = new NetworkInterceptorService();
    }
    return NetworkInterceptorService.instance;
  }

  /**
   * 初始化拦截逻辑
   */
  async initialize(): Promise<void> {
    try {
      const status = await LicenseService.getInstance().checkLicenseStatus();

      // 如果是企业授权，实施拦截
      if (status.type === 'ENTERPRISE_OFFLINE') {
        this.setupEnterpriseInterception();
      } else {
        this.clearInterception();
      }
    } catch (e) {
      logger.error(LogCategory.SYSTEM, 'Network Interceptor: 初始化失败', e);
    }
  }

  /**
   * 设置企业级拦截：仅拦截 *.iocn.cn 域名，开放其它所有请求
   */
  private setupEnterpriseInterception(): void {
    // 移除旧的拦截（如果有）
    this.clearInterception();

    const filter = {
      urls: ['*://*.iocn.cn/*']
    };

    session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
      // 记录拦截日志
      logger.warn(LogCategory.SYSTEM, `Network Interceptor: Blocked request to ${details.url}`);
      callback({ cancel: true });
    });

    logger.info(LogCategory.SYSTEM, 'Network Interceptor: 企业授权拦截模式已启动（拦截 *.iocn.cn）');
  }

  /**
   * 清除拦截规则
   */
  private clearInterception(): void {
    session.defaultSession.webRequest.onBeforeRequest(null);
  }
}

export const networkInterceptorService = NetworkInterceptorService.getInstance();
