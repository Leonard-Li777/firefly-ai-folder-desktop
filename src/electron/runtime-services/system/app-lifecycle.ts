/**
 * 应用生命周期与安全重启管理 (AppLifecycle)
 *
 * 落实 Windows 单实例安全重启铁律：
 * 1. 统一 5000ms 硬上限停止推理引擎与卸载插件；
 * 2. 显式释放 Windows 单实例互斥锁 app.releaseSingleInstanceLock()；
 * 3. 避免新旧进程竞争单实例锁崩溃或闪退；
 * 4. 调用 app.relaunch() 与 app.exit(0)。
 *
 * @doc-anchor: docs/specs/custom-plugin-directory-and-mirror-download-spec.md §7.2
 */

import { app, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@firefly/shared'

export async function safeRestartApp(): Promise<void> {
  const CLEANUP_TIMEOUT_MS = 5000
  logger.info(LogCategory.MAIN, '[AppLifecycle] 开始执行安全重启流程...')

  try {
    // 销毁所有 UI 窗口，避免渲染进程接收到异常事件
    try {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.destroy()
        }
      }
    } catch {}

    // 并行竞争停止 Omni 推理、卸载插件与持久化写入
    await Promise.race([
      Promise.allSettled([
        (async () => {
          try {
            const { omniService } = require('./omni-service')
            await omniService?.stop?.()
          } catch {}
        })(),
        (async () => {
          try {
            const { modularResourceService } = require('./modular-resource-service')
            await modularResourceService?.processManager?.stopAll?.()
          } catch {}
        })(),
        (async () => {
          try {
            const { ConfigOrchestrator } = require('../../config/config-orchestrator')
            await ConfigOrchestrator.getInstance()?.closeAllStores?.()
          } catch {}
        })()
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('RESTART_CLEANUP_TIMEOUT')), CLEANUP_TIMEOUT_MS)
      )
    ])
  } catch (err) {
    logger.warn(LogCategory.MAIN, '[AppLifecycle] 重启前清理超时或失败，强制拉起新进程:', err)
  }

  // 显式释放 Windows 单实例互斥锁，防止新进程因竞争锁而退出
  try {
    if (typeof app !== 'undefined' && typeof app.releaseSingleInstanceLock === 'function') {
      app.releaseSingleInstanceLock()
      logger.info(LogCategory.MAIN, '[AppLifecycle] 单实例互斥锁已成功释放')
    }
  } catch (err) {
    logger.warn(LogCategory.MAIN, '[AppLifecycle] 释放单实例锁失败:', err)
  }

  try {
    if (typeof app !== 'undefined') {
      if (typeof app.relaunch === 'function') {
        app.relaunch()
      }
      if (typeof app.exit === 'function') {
        app.exit(0)
      }
    }
  } catch (err) {
    logger.error(LogCategory.MAIN, '[AppLifecycle] 启动新进程失败:', err)
  }
}
