/**
 * 插件中心渲染层纯辅助函数集合 (Plugin Center Helpers)
 *
 * 铁律：纯函数与渲染层隔离，严禁导入包含 Node.js 原生模块 (node:crypto / fs) 的主进程代码
 * @doc-anchor: docs/specs/plugin-center-slots-exclusivity-and-lifecycle-spec.md#32-离线环境可见性契约调整-environmentvisibility
 */

/**
 * 决定是否在界面上渲染「导出离线总包」按钮
 *
 * 规则：仅在开启开发者模式且当前环境允许导出时才渲染
 */
export function shouldRenderOfflineExportButton(
  isDeveloperMode: boolean,
  allowOfflineExport: boolean
): boolean {
  return Boolean(isDeveloperMode && allowOfflineExport)
}
