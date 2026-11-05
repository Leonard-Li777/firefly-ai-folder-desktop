/**
 * 插件子进程 Bootstrap 退出纪律与环境初始化
 *
 * 遵循规格：plugin-runtime-sandbox-and-omni-seams-spec.md §2.2 第 4 条
 * 防止 Electron 37+ 下 utilityProcess 发生未捕获异常时仅打日志不退出导致进程僵尸化
 */

export function setupPluginBootstrapExitHandlers(
  processRef: NodeJS.Process = process,
  logger: { error: (...args: any[]) => void } = console
): void {
  processRef.on('uncaughtException', (err: any) => {
    logger.error('[PluginBootstrap] Uncaught Exception:', err)
    // setImmediate 确保日志和 Mojo IPC 消息在退出前充分刷盘
    setImmediate(() => {
      processRef.exit(1)
    })
  })

  processRef.on('unhandledRejection', (reason: any) => {
    logger.error('[PluginBootstrap] Unhandled Rejection:', reason)
    setImmediate(() => {
      processRef.exit(1)
    })
  })
}
