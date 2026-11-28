// 由 preload.ts 按领域分片（工单 01 preload IPC 桥拆分）提取的共享上下文：
// 渲染进程日志桥、进程启动参数派生量。各分域统一 import 复用，避免重复定义。
import type { LogCategory } from '../../../pro/packages/shared/src/logger/log-category'
import { ipcRenderer } from 'electron'

export const logger = {
  log: (category: LogCategory, message: string, data?: any) => {
    if (__IS_DEV__) console.log(`[${category}] ${message}`, data !== undefined ? data : '')
  },
  warn: (category: LogCategory, message: string, data?: any) => {
    if (__IS_DEV__) console.warn(`[${category}] ${message}`, data !== undefined ? data : '')
    try {
      ipcRenderer.send('log-forward', { category, level: 'warn', message, data })
    } catch {}
  },
  error: (category: LogCategory, message: string, data?: any) => {
    if (__IS_DEV__) console.error(`[${category}] ${message}`, data !== undefined ? data : '')
    try {
      ipcRenderer.send('log-forward', { category, level: 'error', message, data })
    } catch {}
  }
}

// 从 additionalArguments 与 process.env 双通道读取区域并执行白名单校验
export const isPackaged = process.argv.includes('--is-packaged=true')
export const resolveAppRegionFromEnvAndArgv = (): 'cn' | 'intl' => {
  const argvMatch = process.argv.find(arg => arg.startsWith('--app-region='))
  const fromArgv = argvMatch ? argvMatch.split('=')[1] : null
  const fromEnv = typeof process.env !== 'undefined' ? process.env.APP_REGION : null
  const candidate = (fromArgv || fromEnv || 'intl').trim().toLowerCase()
  return candidate === 'cn' ? 'cn' : 'intl'
}
export const appRegion: 'cn' | 'intl' = resolveAppRegionFromEnvAndArgv()
export const hasPeerData: boolean =
  process.argv.find(arg => arg.startsWith('--has-peer-data='))?.split('=')[1] === 'true'
const peerRegionArg = process.argv.find(arg => arg.startsWith('--peer-region='))
const rawPeerRegion = peerRegionArg
  ? peerRegionArg.split('=')[1]
  : appRegion === 'cn'
    ? 'intl'
    : 'cn'
export const peerRegion: 'cn' | 'intl' = rawPeerRegion === 'cn' ? 'cn' : 'intl'
export const startupTimelineEnabled: boolean = process.argv.includes('--ff-startup-timeline=1')
