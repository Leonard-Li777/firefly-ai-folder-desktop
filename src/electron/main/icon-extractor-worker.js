/**
 * icon-extractor-worker.js
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

'use strict'

// 在子进程中通过 require 同步加载原生模块（CJS 环境，无 ESM 限制）
let extractIconFn = null
try {
  const mod = require('extract-file-icon')
  // 兼容 CJS interop 的两种形态（直接函数 / { default: fn }）
  extractIconFn = (mod && typeof mod.default === 'function') ? mod.default : mod
  if (typeof extractIconFn !== 'function') {
    extractIconFn = null
    console.error('[icon-worker] extract-file-icon 加载失败：导出不是函数')
  }
} catch (err) {
  console.error('[icon-worker] extract-file-icon require 失败:', err && err.message)
}

/**
 * 处理主进程发来的图标提取请求
 * @param {{ id: number, filePath: string }} msg
 */
process.on('message', function (msg) {
  const { id, filePath } = msg || {}

  // 防御：空路径或无效路径直接返回 null
  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    process.send({ id, base64: null })
    return
  }

  // extract-file-icon 模块不可用时直接返回 null（调用方降级到 app.getFileIcon）
  if (!extractIconFn) {
    process.send({ id, base64: null })
    return
  }

  try {
    // 同步调用原生模块提取 256x256 高清图标，返回 PNG Buffer
    const pngBuffer = extractIconFn(filePath, 256)
    if (pngBuffer && pngBuffer.length > 0) {
      process.send({ id, base64: pngBuffer.toString('base64') })
    } else {
      process.send({ id, base64: null })
    }
  } catch (err) {
    // 提取失败（文件不存在、类型不支持等）均安全返回 null
    process.send({ id, base64: null, error: err && err.message })
  }
})

// 子进程启动完成标志，通知主进程已就绪
process.send({ id: -1, ready: true })
