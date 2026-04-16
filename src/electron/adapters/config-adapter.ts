/**
 * 配置适配器实现
 * 将配置服务 API 适配到核心引擎
 */

import { IConfigAdapter } from '@yonuc/core-engine'
import { configService } from '../runtime-services/config'
import type { LanguageCode, AppConfig } from '@yonuc/types'
import { app } from 'electron'
import path from 'path'
import { logger, LogCategory } from '@yonuc/shared'

/**
 * 配置适配器
 */
export class ConfigAdapter implements IConfigAdapter {
  get<T extends keyof AppConfig>(key: T): AppConfig[T] | undefined {
    return configService.getConfig()[key]
  }

  set<T extends keyof AppConfig>(key: T, value: AppConfig[T]): void {
    configService.updateConfig({ [key]: value })
  }

  getLanguage(): LanguageCode {
    // 优先从统一配置中获取语言设置 (ConfigKey: DEFAULT_LANGUAGE)
    // 这是为了解决首次启动或配置迁移后，Unified Config 已更新但 rendererConfig 仍为默认值的问题
    const unifiedLanguage = configService.getValue<LanguageCode>('DEFAULT_LANGUAGE')
    if (unifiedLanguage) {
      return unifiedLanguage
    }

    try {
      const rendererLanguage = configService.getConfig().language
      if (rendererLanguage) {
        return rendererLanguage
      }
    } catch (error) {
      logger.warn(LogCategory.CONFIG, '读取renderer语言失败，将回退至默认语言', error)
    }
    return 'zh-CN'
  }

  getResourcesPath(): string {
    // 在开发环境和生产环境中获取资源路径
    // 注意：在打包模式下，forge.config.ts 的 extraResource 配置会将 build/extraResources/* 的内容
    // 直接复制到 resources/ 根目录，而不是 resources/extraResources/ 子目录
    // 因此这里直接返回 process.resourcesPath，保持与开发环境相同的相对路径结构
    if (app.isPackaged) {
      return process.resourcesPath
    } else {
      return path.join(app.getAppPath(), 'build', 'extraResources')
    }
  }
}

/**
 * 创建配置适配器实例
 */
export function createConfigAdapter(): IConfigAdapter {
  return new ConfigAdapter()
}
