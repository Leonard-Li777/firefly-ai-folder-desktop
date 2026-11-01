/**
 * 跨版本平滑适配剪贴板工具 (safeClipboard)
 *
 * 背景：
 * 1. Electron 44/45 中 clipboard 在主进程中全面异步化（返回 Promise）；
 *    而在 Electron 32 (Linux) 中该接口为同步函数。
 * 2. Web 标准 navigator.clipboard 存在严格的 Document Focus 要求（窗口失焦时抛出 NotAllowedError），
 *    通过主进程 safeClipboard 封装并经 IPC 暴露，可彻底避免焦点异常并统一行为。
 */
import { clipboard } from 'electron'

export const safeClipboard = {
  writeText: async (text: string): Promise<void> => {
    await Promise.resolve(clipboard.writeText(text))
  },
  readText: async (): Promise<string> => {
    return await Promise.resolve(clipboard.readText())
  },
  write: async (data: Parameters<typeof clipboard.write>[0]): Promise<void> => {
    await Promise.resolve(clipboard.write(data))
  }
}
