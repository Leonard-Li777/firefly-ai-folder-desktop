/**
 * 跨平台安全剪贴板写入工具 (Renderer)
 *
 * 优先调用 window.electronAPI.utils.copyTextToClipboard 走主进程 safeClipboard，
 * 彻底规避 W3C navigator.clipboard 在窗口失焦/后台回调/DevTools 激活时的 NotAllowedError；
 * 若在纯 Web 环境或 electronAPI 不可用时，平滑降级为 navigator.clipboard.writeText。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const normalizedText = typeof text === 'string' ? text : String(text ?? '')
  if (typeof window !== 'undefined' && window.electronAPI?.utils?.copyTextToClipboard) {
    try {
      const res = await window.electronAPI.utils.copyTextToClipboard(normalizedText)
      if (res && res.success !== false) return true
    } catch {
      // 降级尝试 navigator.clipboard
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalizedText)
      return true
    } catch (err) {
      console.warn('[Clipboard] 写入剪贴板失败:', err)
      return false
    }
  }

  return false
}
