/**
 * 跨版本平滑适配剪贴板工具 (safeClipboard)
 *
 * 背景与规范契约 (PRD-0058 / ADR-0050)：
 * 1. Electron 44/45 中 clipboard 在主进程中全面异步化（返回 Promise），
 *    且 clipboard.write 遵循 W3C 规范仅接受 ClipboardItem[] 数组，不再接受旧版数据对象；
 *    而在 Electron 32 (Linux) 中该接口为同步函数且接受 { text, html, ... } 对象。
 * 2. 复制文件到剪贴板时，Electron 45 将 'text/uri-list' 自动映射为系统级原生文件格式
 *    （Windows 为 CF_HDROP，macOS 为 NSFilenamesPboardType，Linux 为 text/uri-list）；
 *    而在 Electron 32 中通过 writeBuffer 或 filenames 字段传递。
 * 3. safeClipboard 负责百分之百抹平版本 API 差异与 Document Focus 限制。
 */
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as electron from 'electron'

const { clipboard } = electron

export interface LegacyClipboardWriteData {
  text?: string
  html?: string
  image?: any
  rtf?: string
  bookmark?: string
  filenames?: string[]
}

export const safeClipboard = {
  /**
   * 写入纯文本到剪贴板
   */
  writeText: async (text: string): Promise<void> => {
    await Promise.resolve(clipboard.writeText(text))
  },

  /**
   * 读取剪贴板纯文本
   */
  readText: async (): Promise<string> => {
    return await Promise.resolve(clipboard.readText())
  },

  /**
   * 复制文件列表到系统剪贴板（支持在资源管理器/访达中直接粘贴文件）
   */
  writeFiles: async (filePaths: string[]): Promise<void> => {
    if (!filePaths || filePaths.length === 0) return

    const validPaths = filePaths.filter(Boolean).map(p => path.resolve(p))
    if (validPaths.length === 0) return

    const fileUris = validPaths.map(p => pathToFileURL(p).href).join('\r\n')
    const plainText = validPaths.join('\n')

    const ClipboardItemClass = (electron as any).ClipboardItem || (globalThis as any).ClipboardItem
    if (typeof ClipboardItemClass === 'function') {
      // Electron 45+：使用 W3C 规范的 ClipboardItem 承载 text/uri-list
      const item = new ClipboardItemClass({
        'text/uri-list': fileUris,
        'text/plain': plainText
      })
      await Promise.resolve(clipboard.write([item]))
    } else {
      // Electron 32 (Linux / 旧版兼容)
      if (typeof (clipboard as any).writeBuffer === 'function') {
        try {
          (clipboard as any).writeBuffer('text/uri-list', Buffer.from(fileUris))
        } catch {}
      }
      await Promise.resolve(
        (clipboard as any).write({
          text: plainText,
          filenames: validPaths
        })
      )
    }
  },

  /**
   * 通用写入（自适应抹平 Electron 32 对象格式与 Electron 45 ClipboardItem[] 数组）
   */
  write: async (data: any): Promise<void> => {
    if (!data) return

    const ClipboardItemClass = (electron as any).ClipboardItem || (globalThis as any).ClipboardItem
    if (typeof ClipboardItemClass === 'function') {
      // Electron 45+
      if (Array.isArray(data)) {
        await Promise.resolve(clipboard.write(data))
      } else if (typeof data === 'object') {
        const items: Record<string, any> = {}
        if (data.text) items['text/plain'] = data.text
        if (data.html) items['text/html'] = data.html
        if (data.bookmark) items['electron application/bookmark'] = data.bookmark
        if (data.filenames && Array.isArray(data.filenames)) {
          const validPaths = data.filenames.filter(Boolean).map((p: string) => path.resolve(p))
          items['text/uri-list'] = validPaths.map((p: string) => pathToFileURL(p).href).join('\r\n')
          if (!items['text/plain']) {
            items['text/plain'] = validPaths.join('\n')
          }
        }
        const item = new ClipboardItemClass(items)
        await Promise.resolve(clipboard.write([item]))
      }
    } else {
      // Electron 32
      await Promise.resolve((clipboard as any).write(data))
    }
  }
}
