/**
 * 配置适配器实现
 * 将配置服务 API 适配到核心引擎
 */

import { IConfigAdapter } from '@firefly/core-engine'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import type { LanguageCode, AppConfig } from '@firefly/types'
import { app } from 'electron'
import path from 'path'
import { logger, LogCategory, ResourceLocator } from '@firefly/shared'

/**
 * 配置适配器
 */
export class ConfigAdapter implements IConfigAdapter {
  get<T extends keyof AppConfig>(key: T): AppConfig[T] | undefined {
    return ConfigOrchestrator.getInstance().getConfig()[key]
  }

  set<T extends keyof AppConfig>(key: T, value: AppConfig[T]): void {
    ConfigOrchestrator.getInstance().updateConfig({ [key]: value })
  }

  getLanguage(): LanguageCode {
    // 优先从统一配置中获取语言设置 (ConfigKey: DEFAULT_LANGUAGE)
    // 这是为了解决首次启动或配置迁移后，Unified Config 已更新但 rendererConfig 仍为默认值的问题
    const unifiedLanguage =
      ConfigOrchestrator.getInstance().getValue<LanguageCode>('DEFAULT_LANGUAGE')
    if (unifiedLanguage) {
      return unifiedLanguage
    }

    try {
      const rendererLanguage = ConfigOrchestrator.getInstance().getConfig().language
      if (rendererLanguage) {
        return rendererLanguage
      }
    } catch (error) {
      logger.warn(LogCategory.CONFIG, '读取renderer语言失败，将回退至默认语言', error)
    }
    return 'zh-CN'
  }

  getResourcesPath(): string {
    return ResourceLocator.getBaseResourceDir()
  }
}

export function getResourcesPath(): string {
  return ResourceLocator.getBaseResourceDir()
}

/**
 * 创建配置适配器实例
 */
export function createConfigAdapter(): IConfigAdapter {
  return new ConfigAdapter()
}
