// 由 preload.ts 按领域分片（工单 01 preload IPC 桥拆分）。正文为原 electronAPI 区间逐字节等价搬运、零行为改动、零顶层 key 增删。

import type { CloudModelConfig, ProviderModel } from '@firefly/types'
import { ipcRenderer } from 'electron'
import { logger } from './shared-context'

export const mediaAiApi = {
  // 云端模型配置相关
  cloudModelConfig: {
    // 获取所有云端配置
    getConfigs: async (): Promise<CloudModelConfig[]> => {
      const result = await ipcRenderer.invoke('cloud-model-config:get-configs')
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 获取指定索引的配置
    getConfig: async (index: number): Promise<CloudModelConfig | null> => {
      const result = await ipcRenderer.invoke('cloud-model-config:get-config', index)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 添加新配置
    addConfig: async (config: CloudModelConfig): Promise<void> => {
      const result = await ipcRenderer.invoke('cloud-model-config:add-config', config)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 更新配置
    updateConfig: async (index: number, config: CloudModelConfig): Promise<void> => {
      const result = await ipcRenderer.invoke('cloud-model-config:update-config', index, config)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 删除配置
    deleteConfig: async (index: number): Promise<void> => {
      const result = await ipcRenderer.invoke('cloud-model-config:delete-config', index)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 获取当前选中的配置索引
    getSelectedIndex: async (): Promise<number> => {
      const result = await ipcRenderer.invoke('cloud-model-config:get-selected-index')
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 设置当前选中的配置索引
    setSelectedIndex: async (index: number): Promise<void> => {
      const result = await ipcRenderer.invoke('cloud-model-config:set-selected-index', index)
      if (!result.success) throw new Error(result.error || 'Unknown error')
    },

    // 测试配置有效性
    testConfig: async (config: CloudModelConfig): Promise<boolean> => {
      const result = await ipcRenderer.invoke('cloud-model-config:test-config', config)
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 获取指定服务商的模型列表
    getProviderModels: async (
      provider: string,
      apiKey: string,
      baseUrl?: string,
      throwOnError = false
    ): Promise<ProviderModel[]> => {
      const result = await ipcRenderer.invoke(
        'cloud-model-config:get-provider-models',
        provider,
        apiKey,
        baseUrl,
        throwOnError
      )
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    },

    // 获取云端提供商配置
    getCloudProvidersConfig: async (language: string): Promise<any[]> => {
      const result = await ipcRenderer.invoke(
        'cloud-model-config:get-cloud-providers-config',
        language
      )
      if (result.success) return result.data
      throw new Error(result.error || 'Unknown error')
    }
  },

  // 本地模型下载 IPC（model-download-manager:*）已随内置推理链清退：
  // 模型下载/部署归 Tier 2 firefly-ai-engine，桌面端仅经 engineBridge 探活与引导配置。

  // Ollama 内置推理 IPC（ollama:*）已随 PRD-0042 清退（主进程 ollama-ipc-handler 已删）：
  // 残留 AI_ENGINE=ollama 配置由 startup/get-flags 强制回落为 llama.cpp（Tier 2 桥接）。

  // FFmpeg 相关 API
  /*
  ffmpeg: {
    // 检查 FFmpeg 安装状态
    checkInstallation: async (): Promise<{ installed: boolean; path?: string; downloading: boolean }> => {
      return await ipcRenderer.invoke('ffmpeg:check-installation')
    },

    // 安装 FFmpeg
    install: async (): Promise<{ success: boolean; error?: string }> => {
      try {
        return await ipcRenderer.invoke('ffmpeg:install')
      } catch (error) {
        return { 
          success: false, 
          error: error instanceof Error ? error.message : String(error) 
        }
      }
    }
  },
  */

  // Ollama 事件监听器已随 ollama-ipc-handler 清退（PRD-0042）：
  // onOllamaInstallProgress / onOllamaInstallComplete / onOllamaInstallError /
  // onOllamaStatusChanged / onOllamaModelStatusChanged / onOllamaModelProgress。

  onApplyOrganizePlan: (
    callback: (payload: { name: string; strategy: string; perspective?: string }) => void
  ) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('organize:apply-plan', handler)
    return () => ipcRenderer.removeListener('organize:apply-plan', handler)
  },

  // 获取 Omni 引擎版本号
  getOmniVersion: (): Promise<string> => ipcRenderer.invoke('omni/getVersion'),

  // 获取基础AI引擎（Omni）状态：running = 进程探活成功，version = 引擎版本号
  getOmniStatus: (): Promise<{ running: boolean; version: string | null }> =>
    ipcRenderer.invoke('omni/getStatus'),

  // 订阅基础AI引擎（Omni）状态主动推送（omni:status-changed），返回取消订阅函数
  onOmniStatusChanged: (
    callback: (status: { running: boolean; version: string | null }) => void
  ): (() => void) => {
    const handler = (_event: any, status: { running: boolean; version: string | null }) =>
      callback(status)
    ipcRenderer.on('omni:status-changed', handler)
    return () => ipcRenderer.removeListener('omni:status-changed', handler)
  },

  // 获取当前 Worktree 环境信息
  getWorktreeInfo: (): Promise<{
    worktreeName: string
    region: string
    isProd: boolean
    appName: string
    userDataDir: string
  }> => ipcRenderer.invoke('app:getWorktreeInfo')
}
