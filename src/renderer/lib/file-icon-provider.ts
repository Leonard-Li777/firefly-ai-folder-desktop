/**
 * 文件系统图标提供器
 * 用于在没有缩略图时展示系统/文件关联图标。
 *
 * 缓存策略：
 * - 绝大多数文件类型的图标由扩展名决定，按 `ext:size` 缓存可极大减少 IPC 调用
 * - 可执行文件 / 快捷方式 / 图标文件等每文件图标可能不同，按 `path:size` 缓存
 * - 相同 key 的并发请求通过 in-flight Promise 去重
 */

/** Electron 支持的系统图标尺寸 */
export type FileIconSize = 'small' | 'normal' | 'large'

/** 图标可能随文件不同而变化的扩展名，需要按完整路径缓存 */
const PER_PATH_CACHE_EXTS = new Set(['exe', 'lnk', 'ico', 'dll', 'cpl', 'msc', 'scr', 'url', 'app'])

/** 扩展名缓存（key: ext:size -> dataUrl） */
const extCache = new Map<string, string>()
/** 路径缓存（key: path:size -> dataUrl），用于可执行文件等 */
const pathCache = new Map<string, string>()
/** 进行中的请求（key -> Promise），避免同一 key 并发重复 IPC */
const inflight = new Map<string, Promise<string | null>>()

/** 归一化扩展名（去掉前导点、统一小写） */
const normalizeExt = (ext?: string): string => {
  if (!ext) return 'unknown'
  return ext.toLowerCase().replace(/^\./, '')
}

/**
 * 获取文件系统图标 DataURL
 * @param filePath 文件完整路径
 * @param extension 文件扩展名（用于缓存 key；可执行文件按路径缓存）
 * @param size 图标尺寸（Electron 枚举）
 */
export const getFileIconDataUrl = async (
  filePath: string,
  extension?: string,
  size: FileIconSize = 'small'
): Promise<string | null> => {
  // 空路径/非字符串路径直接返回，避免发起无谓的 IPC 调用并传入原生模块
  if (
    !filePath ||
    typeof filePath !== 'string' ||
    filePath.trim() === '' ||
    !window.electronAPI?.getFileIcon
  )
    return null

  const ext = normalizeExt(extension)
  const usePathCache = PER_PATH_CACHE_EXTS.has(ext)
  const key = usePathCache ? `path:${filePath}:${size}` : `ext:${ext}:${size}`

  const cached = usePathCache ? pathCache.get(key) : extCache.get(key)
  if (cached !== undefined) return cached

  const pending = inflight.get(key)
  if (pending) return pending

  const promise = (async () => {
    try {
      const dataUrl = await window.electronAPI!.getFileIcon(filePath, size)
      if (dataUrl) {
        if (usePathCache) pathCache.set(key, dataUrl)
        else extCache.set(key, dataUrl)
      }
      return dataUrl
    } catch {
      return null
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, promise)
  return promise
}
