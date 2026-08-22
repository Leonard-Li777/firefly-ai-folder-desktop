/**
 * 全局类型定义
 * 这个文件确保全局变量和类型定义被正确加载
 */

import type { ElectronAPI } from './electron/preload'

declare global {
  const __APP_VERSION__: string
  const __BUILD_REGION__: 'CN' | 'INTL'
  const __AI_ENGINE__: string
  const VITE_POSTHOG_HOST: string
  const VITE_POSTHOG_KEY: string
  const VITE_ENABLE_POSTHOG: string
  const __IS_DEV__: boolean
  const __IS_PROD__: boolean

  interface Window {
    VITE_POSTHOG_HOST: string
    VITE_POSTHOG_KEY: string
    VITE_ENABLE_POSTHOG: string
    __IS_DEV__: boolean
    __IS_PROD__: boolean
    electronAPI: ElectronAPI
    electronLLM: any
    electronAi: any
    ipcRenderer: any
  }
}

declare module 'react-window' {
  export const FixedSizeList: any
  export const FixedSizeGrid: any
}

declare module 'exiftool-vendored'
declare module 'pdf-poppler'
declare module 'onnxruntime-node'

export {}
