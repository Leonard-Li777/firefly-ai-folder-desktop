import { IQuotaChecker, QuotaType, QuotaResult } from '@firefly/types'
import { userTierService } from './user-tier-service'

export class QuotaCheckerProxy implements IQuotaChecker {
  async check(type: QuotaType, amount = 1): Promise<QuotaResult> {
    // 渲染进程侧也可以调用，但这里是给主进程其他 service 用的 proxy 吗？
    // 根据需求：apps/desktop/src/electron/runtime-services/user-tier/quota-checker-proxy.ts：渲染进程侧 QuotaChecker 代理
    // 等等，如果是渲染进程侧代理，它应该在 renderer 目录下。
    // 但是提示里写的是 apps/desktop/src/electron/runtime-services/user-tier/quota-checker-proxy.ts
    // 如果是在 electron/runtime-services，那它应该是给主进程其他 service 注入用的。

    // 我们在 file-processor.ts 中需要一个 quotaChecker 实例。

    return userTierService.checkQuota({
      type,
      currentCount: await this.getCurrentCount(type),
      amount
    })
  }

  async consume(type: QuotaType, amount = 1): Promise<QuotaResult> {
    return this.check(type, amount)
  }

  private async getCurrentCount(type: QuotaType): Promise<number> {
    if (type === 'analyze_file') {
      const { virtualDirectoryService } =
        await import('../filesystem/virtual-directory-service/index')
      return await virtualDirectoryService.getAnalyzedFilesCount()
    }
    // 其他类型的计数获取...
    return 0
  }
}

export const quotaChecker = new QuotaCheckerProxy()
