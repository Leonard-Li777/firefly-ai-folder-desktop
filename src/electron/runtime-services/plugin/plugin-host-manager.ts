/**
 * 插件宿主单例管理器 (PluginHostManager)
 *
 * 遵循规格：plugin-runtime-sandbox-and-omni-seams-spec.md §2.1
 * 确立按插件 ID 独占宿主进程，统一调度与全局退出管理
 */

import { PluginManifest, UtilityProcessFactory } from './plugin-types'
import { PluginHost, PluginHostOptions } from './plugin-host'

export class PluginHostManager {
  private static instance: PluginHostManager | null = null

  private readonly hosts = new Map<string, PluginHost>()
  private customUtilityFactory?: UtilityProcessFactory

  private constructor() {}

  public static getInstance(): PluginHostManager {
    if (!PluginHostManager.instance) {
      PluginHostManager.instance = new PluginHostManager()
    }
    return PluginHostManager.instance
  }

  /**
   * 注入自定义进程工厂（主要用于测试 Mock）
   */
  public setUtilityProcessFactory(factory: UtilityProcessFactory | undefined): void {
    this.customUtilityFactory = factory
  }

  /**
   * 获取或注册指定插件的宿主实例
   */
  public getOrCreateHost(
    manifest: PluginManifest,
    options?: Partial<PluginHostOptions>
  ): PluginHost {
    let host = this.hosts.get(manifest.id)
    if (!host) {
      host = new PluginHost({
        manifest,
        utilityProcessFactory: options?.utilityProcessFactory ?? this.customUtilityFactory,
        ...options
      })
      this.hosts.set(manifest.id, host)
    }
    return host
  }

  /**
   * 获取已有宿主实例
   */
  public getHost(pluginId: string): PluginHost | undefined {
    return this.hosts.get(pluginId)
  }

  /**
   * 关闭并移除指定插件宿主
   */
  public async removeHost(pluginId: string): Promise<void> {
    const host = this.hosts.get(pluginId)
    if (host) {
      this.hosts.delete(pluginId)
      await host.retire()
      host.dispose()
    }
  }

  /**
   * 关闭所有插件宿主进程（应用退出时调用）
   */
  public async shutdownAll(): Promise<void> {
    const tasks: Promise<void>[] = []
    for (const host of this.hosts.values()) {
      tasks.push(host.retire().then(() => host.dispose()))
    }
    await Promise.allSettled(tasks)
    this.hosts.clear()
  }

  /**
   * 测试重置单例
   */
  public static resetInstance(): void {
    if (PluginHostManager.instance) {
      for (const host of PluginHostManager.instance.hosts.values()) {
        host.dispose()
      }
      PluginHostManager.instance.hosts.clear()
      PluginHostManager.instance = null
    }
  }
}

export const pluginHostManager = PluginHostManager.getInstance()
