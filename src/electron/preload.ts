// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
//
// 工单 01（preload IPC 桥按领域分片）：electronAPI 单一巨型对象已按 IPC 领域拆分为
// preload/<domain>.ts 分片，此处用对象展开组合回单一 electronAPI。
// export type ElectronAPI = typeof electronAPI 签名逐字段不变（渲染进程零改动），
// contextBridge.exposeInMainWorld 暴露面不变，未新增/删除/重命名任何 IPC 通道。

import { contextBridge, ipcRenderer } from 'electron'
import { LogCategory } from '../../pro/packages/shared/src/logger/log-category'
import { logger } from './preload/shared-context'

// 各 IPC 领域分片（正文为原 electronAPI 区间等价搬运）
import { appConfigApi } from './preload/app-config'
import { aiEngineApi } from './preload/ai-engine'
import { analysisApi } from './preload/analysis'
import { filesApi } from './preload/files'
import { workspaceApi } from './preload/workspace'
import { organizeApi } from './preload/organize'
import { mediaAiApi } from './preload/media-ai'
import { systemApi } from './preload/system-api'

// argv/region 派生量（exposeInMainWorld 区段直接使用）
import { appRegion, hasPeerData } from './preload/shared-context'

// 模块化资源与插件中心生命周期桥
import { modularResourcePreloadBridge, hibernationPreloadBridge } from '../preload'

/**
 * 暴露给渲染进程的安全API（由 preload/<domain>.ts 各分片组合）
 */
const electronAPI = {
  ...appConfigApi,
  ...aiEngineApi,
  ...analysisApi,
  ...filesApi,
  ...workspaceApi,
  ...organizeApi,
  ...mediaAiApi,
  ...systemApi
}

// 类型定义
export type ElectronAPI = typeof electronAPI

// E2E 测试环境受控只读监听器注入 (Spec §4.5 build:prod DCE 保证零残留)
if (typeof __FF_E2E__ !== 'undefined' && __FF_E2E__) {
  ;(electronAPI as any).onPluginCrash = (cb: (data: unknown) => void) => {
    ipcRenderer.on('plugin:crashed', (_e, data) => cb(data))
  }
}

// 暴露API到渲染进程
contextBridge.exposeInMainWorld('__APP_REGION__', appRegion)
contextBridge.exposeInMainWorld('__HAS_CROSS_REGION_DATA__', hasPeerData)
contextBridge.exposeInMainWorld('electronAPI', electronAPI)
contextBridge.exposeInMainWorld('modularResource', modularResourcePreloadBridge)
contextBridge.exposeInMainWorld('hibernation', hibernationPreloadBridge)

// 暴露 AI 功能到渲染进程
// 注意：通过 IPC 调用主进程的 llama-server 服务
logger.log(LogCategory.PRELOAD, '设置 AI 功能接口')

contextBridge.exposeInMainWorld('electronLLM', {
  initialized: false, // 初始状态为未初始化

  // 初始化方法，由渲染进程调用
  initialize: async () => {
    try {
      const result = await ipcRenderer.invoke('initialize-ai-service')
      return result
    } catch (error) {
      throw error
    }
  },

  // AI 聊天接口，通过 IPC 调用主进程
  chat: async (options: {
    model: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
    max_tokens?: number
    images?: string[]
    audio?: string[]
  }) => {
    try {
      const result = await ipcRenderer.invoke('ai-chat', options)
      return result
    } catch (error) {
      throw error
    }
  },

  // PRD-0044（S5）：electronLLM.getModelPath 随 'get-model-path' IPC 清退删除

  // 检查 AI 服务状态
  checkStatus: async () => {
    try {
      const status = await ipcRenderer.invoke('get-ai-status')
      return status
    } catch (error) {
      throw error
    }
  }
})

logger.log(LogCategory.PRELOAD, 'AI 功能接口设置完成')

// 手动暴露 electronAi API（通过 llama-server 实现）
contextBridge.exposeInMainWorld('electronAi', {
  // 创建模型实例
  create: async (options: {
    modelAlias: string
    systemPrompt?: string
    initialPrompts?: Array<{ role: string; content: string }>
    topK?: number
    temperature?: number
    requestUUID?: string
  }) => {
    try {
      logger.log(LogCategory.PRELOAD, '创建模型实例', { modelAlias: options.modelAlias })

      // 通过 IPC 调用主进程来创建模型实例
      const result = await ipcRenderer.invoke('electronai-create', options)
      logger.log(LogCategory.PRELOAD, '模型实例创建成功')
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '创建模型实例失败', error)
      throw error
    }
  },

  // 销毁模型实例
  destroy: async () => {
    try {
      logger.log(LogCategory.PRELOAD, '销毁模型实例')
      const result = await ipcRenderer.invoke('electronai-destroy')
      logger.log(LogCategory.PRELOAD, '模型实例销毁成功')
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '销毁模型实例失败', error)
      throw error
    }
  },

  // 发送提示
  prompt: async (
    input: string,
    options?: {
      responseJSONSchema?: any
      signal?: AbortSignal
      timeout?: number
      requestUUID?: string
    }
  ) => {
    try {
      logger.log(LogCategory.PRELOAD, '发送提示', { inputLength: input.length })

      // 通过 IPC 调用主进程
      const result = await ipcRenderer.invoke('electronai-prompt', input, options)
      logger.log(LogCategory.PRELOAD, '提示响应成功', { resultLength: result.length })
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '提示请求失败', error)
      throw error
    }
  },

  // 流式提示
  promptStreaming: async (
    input: string,
    options?: {
      responseJSONSchema?: unknown
      signal?: AbortSignal
      timeout?: number
      requestUUID?: string
    }
  ) => {
    try {
      logger.log(LogCategory.PRELOAD, '发送流式提示', { inputLength: input.length })

      // 通过 IPC 调用主进程
      const result = await ipcRenderer.invoke('electronai-prompt-streaming', input, options)
      logger.log(LogCategory.PRELOAD, '流式提示响应成功')
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '流式提示请求失败', error)
      throw error
    }
  },

  // 中止请求
  abortRequest: async (requestUUID: string) => {
    try {
      logger.log(LogCategory.PRELOAD, '中止请求', { requestUUID })
      const result = await ipcRenderer.invoke('electronai-abort-request', requestUUID)
      logger.log(LogCategory.PRELOAD, '请求中止成功')
      return result
    } catch (error) {
      logger.error(LogCategory.PRELOAD, '中止请求失败', error)
      throw error
    }
  }
})

logger.log(LogCategory.PRELOAD, 'electronAi API 设置完成')

// 暴露一个安全的ipcRenderer版本
contextBridge.exposeInMainWorld('ipcRenderer', {
  send: (channel: string, data: any) => {
    // 将可信通道列入白名单
    const validChannels = ['renderer-error']
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data)
    } else {
      logger.warn(LogCategory.PRELOAD, `ipcRenderer.send called with untrusted channel: ${channel}`)
    }
  },
  on: (channel: string, func: (...args: any[]) => void) => {
    const validChannels: string[] = ['system:log-forward', 'system:log-forward-batch'] // 根据需要添加从主进程到渲染进程的通道
    if (validChannels.includes(channel)) {
      // 刻意剥离 event，因为它包含 'sender'
      ipcRenderer.on(channel, (event, ...args) => func(...args))
    } else {
      logger.warn(LogCategory.PRELOAD, `ipcRenderer.on called with untrusted channel: ${channel}`)
    }
  }
})

// 类型声明已在 apps/desktop/src/shared/types/electron-api.d.ts 中统一定义

// E2E 只读事件监听骨架（Spec §4.5 build:prod DCE 保证零残留）
// build:e2e-packaged: __FF_E2E__ = true，此块保留并打包
// build:prod: __FF_E2E__ = false，编译器 DCE 彻底剥离，产物中零残留
if (typeof __FF_E2E__ !== 'undefined' && __FF_E2E__) {
  contextBridge.exposeInMainWorld('__e2e_probe_bridge', {
    // 监听主进程插件崩溃事件（供 L2b/L3 用例断言渲染层感知）
    onPluginCrash: (cb: (data: unknown) => void) => {
      ipcRenderer.on('plugin:crashed', (_e, data) => cb(data))
    }
  })
}

// 模块级全局声明（由 Vite define 注入）
declare const __FF_E2E__: boolean
