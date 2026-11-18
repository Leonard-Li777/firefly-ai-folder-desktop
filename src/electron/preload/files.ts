// 由 preload.ts 按领域分片（工单 01 preload IPC 桥拆分）。正文为原 electronAPI 区间逐字节等价搬运、零行为改动、零顶层 key 增删。

import type { FileInfo, FileItem } from '@firefly/types'
import type {
  DeepLinkTargetPayload,
  LaunchOutcome
} from '../runtime-services/system/external-app-launcher'
import type { LogCategory } from '../../../pro/packages/shared/src/logger/log-category'
import { ipcRenderer, webUtils } from 'electron'
import { logger } from './shared-context'

export const filesApi = {
  // 授权相关
  license: {
    getStatus: (): Promise<{ status: string; expiry?: string; error?: string; type?: string }> =>
      ipcRenderer.invoke('license/get-status'),
    checkOnline: (): Promise<{ status: string; expiry?: string; error?: string; type?: string }> =>
      ipcRenderer.invoke('license/check-online'),
    getInvitationCode: (): Promise<string> => ipcRenderer.invoke('license/get-invitation-code'),
    getIdentCode: (): Promise<string> => ipcRenderer.invoke('license/get-ident-code'),
    getBase64Code: (): Promise<string> => ipcRenderer.invoke('license/get-ident-code'),
    activate: (licenseCode: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('license/activate', licenseCode),
    onUnauthorized: (callback: (result: any) => void) => {
      const subscription = (_event: any, result: any) => callback(result)
      ipcRenderer.on('license:unauthorized', subscription)
      return () => ipcRenderer.removeListener('license:unauthorized', subscription)
    }
  },

  // 文件清理
  fileCleanup: {
    deleteFile: (fileId: number | string): Promise<boolean> =>
      ipcRenderer.invoke('file-cleanup/delete-file', fileId),
    batchDeleteFiles: (
      fileIds: (number | string)[]
    ): Promise<{ success: number; failed: number }> =>
      ipcRenderer.invoke('file-cleanup/batch-delete-files', fileIds)
  },

  // 工具函数
  utils: {
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch (err) {
        if (__IS_DEV__) {
          console.error('[Preload] webUtils.getPathForFile failed:', err)
        }
        return ''
      }
    },

    getPlatform: (): string => process.platform,

    normalizeForCache: (p: string) =>
      process.platform === 'win32' ? (p ? p.toLowerCase() : '') : p,
    isPathEqual: (p1?: string | null, p2?: string | null) => {
      if (!p1 || !p2) return p1 === p2
      return process.platform === 'win32' ? p1.toLowerCase() === p2.toLowerCase() : p1 === p2
    },
    stripTrailingSlash: (p: string) => (p ? p.replace(/[\/\\]$/, '') : ''),
    pathSeparator: process.platform === 'win32' ? '\\' : '/',
    normalizePath: (p: string) => {
      if (!p) return ''
      const sep = process.platform === 'win32' ? '\\' : '/'
      return p.replace(/[\\\/]/g, sep)
    },
    isSubPath: (parent: string, child: string) => {
      const platform = process.platform
      let p = parent ? parent.replace(/[\/\\]$/, '') : ''
      let c = child ? child.replace(/[\/\\]$/, '') : ''
      if (platform === 'win32') {
        p = p.toLowerCase()
        c = c.toLowerCase()
      }
      return c.startsWith(p + '/') || c.startsWith(p + '\\') || p === c
    },

    showOpenDialog: (options: any) => ipcRenderer.invoke('show-open-dialog', options),

    showSaveDialog: (options: any) => ipcRenderer.invoke('show-save-dialog', options),

    showMessageBox: (options: any) => ipcRenderer.invoke('show-message-box', options),

    // 校验目录是否可写（通过实际创建临时文件检测）
    checkDirectoryWritable: (dirPath: string) =>
      ipcRenderer.invoke('check-directory-writable', dirPath),

    // 探测工作目录画像（扩展名分布与推荐意图）
    probeDirectoryProfile: (dirPath: string) =>
      ipcRenderer.invoke('probe-directory-profile', dirPath),

    // 端侧工作流语义打分 (Stage B)
    scoreWorkflowSemantics: (
      request: import('@firefly/types').WorkflowSemanticsScoreRequest
    ): Promise<import('@firefly/types').WorkflowSemanticsScoreResult> =>
      ipcRenderer.invoke('score-workflow-semantics', request),

    getUserHomePath: () => ipcRenderer.invoke('get-user-home-path'),

    // 添加路径连接函数
    joinPath: (basePath: string, relativePath: string) =>
      ipcRenderer.invoke('join-path', basePath, relativePath),

    // 用系统默认程序打开文件
    openFileWithDefaultApp: (filePath: string) =>
      ipcRenderer.invoke('open-file-with-default-app', filePath),

    // 在外部应用中精准定位打开（支持秒数/页码/行号）
    launchExternalDeepLink: (payload: DeepLinkTargetPayload): Promise<LaunchOutcome> =>
      ipcRenderer.invoke('system:launch-external-deeplink', payload),

    // 用系统文件浏览器打开目录
    openPathInExplorer: (dirPath: string) => ipcRenderer.invoke('open-path-in-explorer', dirPath),

    // 在系统文件浏览器中定位并选中文件
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('show-item-in-folder', filePath),

    // 将文件复制到剪贴板
    copyFileToClipboard: (filePath: string) =>
      ipcRenderer.invoke('copy-file-to-clipboard', filePath),

    // 将多个文件复制到剪贴板
    copyFilesToClipboard: (filePaths: string[]) =>
      ipcRenderer.invoke('copy-files-to-clipboard', filePaths),

    // 将文本安全写入剪贴板（走主进程 safeClipboard，规避窗口焦点检查与跨版本差异）
    copyTextToClipboard: (text: string) => ipcRenderer.invoke('copy-text-to-clipboard', text),

    // 从剪贴板读取文本
    readTextFromClipboard: () => ipcRenderer.invoke('read-text-from-clipboard'),

    // 写入文件
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('write-file', filePath, content),

    // LibreOffice检测
    detectLibreOffice: () => ipcRenderer.invoke('detect-libreoffice'),

    // FFmpeg检测
    detectFfmpeg: () => ipcRenderer.invoke('ffmpeg:check-installation'),

    // ffprobe 外部依赖检测 (Issue #738 深度清理中心显式门禁)
    detectFfprobe: (): Promise<{ available: boolean; path: string | null }> =>
      ipcRenderer.invoke('ffmpeg:check-ffprobe'),

    // 打开外部链接
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

    // 获取资源路径
    getResourcesPath: () => ipcRenderer.invoke('get-resources-path'),

    // 读取文件并转换为 base64
    readFileBase64: (filePath: string): Promise<string> =>
      ipcRenderer.invoke('read-file-base64', filePath),

    // 读取文件并直接返回 Uint8Array 二进制 Buffer
    readFileBuffer: (filePath: string): Promise<Uint8Array> =>
      ipcRenderer.invoke('read-file-buffer', filePath),

    // 预处理文本文件用于预览（截取1MB + 转UTF-8 + 写入临时目录）
    preprocessTextFile: (filePath: string): Promise<string> =>
      ipcRenderer.invoke('preprocess-text-file', filePath),

    // 清理生成的预处理预览文件
    deletePreprocessedFile: (filePath: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('delete-preprocessed-file', filePath)
  }
}
