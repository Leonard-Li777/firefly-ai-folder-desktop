// 由 preload.ts 按领域分片（工单 01 preload IPC 桥拆分）。正文为原 electronAPI 区间逐字节等价搬运、零行为改动、零顶层 key 增删。

import type { LogCategory } from '../../../pro/packages/shared/src/logger/log-category'
import { ipcRenderer } from 'electron'
import { logger } from './shared-context'

export const analysisApi = {
  onSSLCertificateError: (callback: (event: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('ssl-certificate-error', handler)
    return () => ipcRenderer.removeListener('ssl-certificate-error', handler)
  },

  // 工作目录更新事件
  onWorkspaceDirectoriesUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('workspace-directories-updated', handler)
    return () => ipcRenderer.removeListener('workspace-directories-updated', handler)
  },

  // 忽略规则变更事件
  onIgnoreRulesChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('ignore-rules-changed', handler)
    return () => ipcRenderer.removeListener('ignore-rules-changed', handler)
  },

  // 目录文件更新事件（增量更新）
  onDirectoryFilesUpdated: (callback: (dirPath: string) => void) => {
    const handler = (_event: any, dirPath: string) => callback(dirPath)
    ipcRenderer.on('directory-files-updated', handler)
    return () => ipcRenderer.removeListener('directory-files-updated', handler)
  },

  onSystemNotification: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('system:notification', handler)
    return () => ipcRenderer.removeListener('system:notification', handler)
  }

  // PRD-0044：安装遮罩链路（onInitialSetupStatus / setupOverlayReady 与
  // system:initial-setup-status、system:setup-overlay-ready 两条 IPC）随
  // 渲染进程 InitialSetupOverlay 一并清退删除
}
