/**
 * icon-extractor-worker.ts
 *
 * 图标提取独立子进程。
 * 通过 child_process.fork() 由主进程启动，使用 IPC 消息通信。
 *
 * 目的：将 extract-file-icon（调用 Windows Shell COM API）隔离到独立进程，
 * 避免在 Electron 主进程非 Chrome_UIThread 线程中调用该 API 导致：
 *   Check failed: checker.CalledOnValidBrowserThread(thread_identifier).
 *   Must be called on Chrome_UIThread; actually called on Unknown Thread.
 *
 * 消息协议：
 *   请求：{ id: number, filePath: string }
 *   响应：{ id: number, base64: string | null, error?: string }
 */

import { createRequire } from 'node:module'

/** extract-file-icon 原生模块的导出形态 */
type IconExtractor = (filePath: string, size?: 16 | 32 | 64 | 256) => Buffer

/** 子进程与父进程之间的 IPC 消息体 */
interface IconWorkerRequest {
  id: number
  filePath?: string
}

interface IconWorkerResponse {
  id: number
  ready?: boolean
  base64?: string | null
  error?: string
}

// 在子进程中同步加载原生模块（CJS interop，规避 ESM 限制）
const moduleRequire = createRequire(import.meta.url)

let extractIconFn: IconExtractor | null = null
try {
  const mod = moduleRequire('extract-file-icon') as unknown
  // 兼容 CJS interop 的两种形态（直接函数 / { default: fn }）
  const fn = (mod as { default?: unknown })?.default ?? mod
  extractIconFn = typeof fn === 'function' ? (fn as IconExtractor) : null
  if (!extractIconFn) {
    console.error('[icon-worker] extract-file-icon 加载失败：导出不是函数')
  }
} catch (err) {
  console.error('[icon-worker] extract-file-icon 加载失败:', (err as Error)?.message)
}

/**
 * 处理主进程发来的图标提取请求
 * @param msg 请求消息：{ id: number, filePath: string }
 */
process.on('message', (rawMsg: unknown) => {
  const { id, filePath } = (rawMsg || {}) as IconWorkerRequest

  // 防御：空路径或无效路径直接返回 null
  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    process.send?.({ id, base64: null } as IconWorkerResponse)
    return
  }

  // extract-file-icon 模块不可用时直接返回 null（调用方降级到 app.getFileIcon）
  if (!extractIconFn) {
    process.send?.({ id, base64: null } as IconWorkerResponse)
    return
  }

  try {
    // 同步调用原生模块提取 256x256 高清图标，返回 PNG Buffer
    const pngBuffer = extractIconFn(filePath, 256)
    if (pngBuffer && pngBuffer.length > 0) {
      process.send?.({ id, base64: pngBuffer.toString('base64') } as IconWorkerResponse)
    } else {
      process.send?.({ id, base64: null } as IconWorkerResponse)
    }
  } catch (err) {
    // 提取失败（文件不存在、类型不支持等）均安全返回 null
    process.send?.({ id, base64: null, error: (err as Error)?.message } as IconWorkerResponse)
  }
})

// 子进程启动完成标志，通知主进程已就绪
process.send?.({ id: -1, ready: true } as IconWorkerResponse)
