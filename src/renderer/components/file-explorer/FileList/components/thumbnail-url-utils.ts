import { LogCategory, logger } from '@firefly/shared'
import { useVirtualDirectoryStore } from '../../../../stores/virtual-directory-store'

/**
 * 常见网页原生支持渲染的图片格式扩展名集合
 */
export const NATIVE_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'svg',
  'ico',
  'avif'
])

/**
 * 转换本地路径为安全的 Chromium file:/// 协议 URL
 * 编码非 ASCII 字符以及 #、?、% 等特殊 URL 关键字符，防止被截断或解析错乱
 */
export function toSafeFileUrl(filePath: string): string {
  if (!filePath) return ''
  if (filePath.startsWith('file://')) return filePath

  const unified = filePath.replace(/\\/g, '/').replace(/\/+/g, '/')
  const segments = unified.split('/')
  const encoded = segments
    .map((seg, i) => {
      if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return seg
      return encodeURIComponent(seg)
    })
    .join('/')
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/**
 * 判断 child 是否处于 parent 目录或其子目录中。
 * 复用 preload 暴露的原生路径工具（渲染层单一事实源），避免自造分隔符归一化逻辑。
 */
export function isParentPath(parent: string, child: string): boolean {
  if (!parent || !child) return false
  const isSubPath = window.electronAPI?.utils?.isSubPath
  if (typeof isSubPath === 'function') {
    const result = isSubPath(parent, child)
    if (typeof result === 'boolean') return result
  }
  // preload 不可用或其 mock 未返回 boolean 时的兜底（纯前端/测试环境）：
  // 统一斜杠并忽略大小写后判断，与 path.ts::isSubPath 语义对齐。
  // 此处归一化仅用于 URL 拼接前的归属判断，不参与 DB/缓存键等比较层。
  const p = parent.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()
  const c = child.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
  return c.startsWith(p + '/') || c === p
}

/**
 * 通用缩略图与本地预览图路径解析器：
 * 严守三阶段生命周期与物理路径安全，精准支持：
 * 1. 绝对物理路径（直接编码）
 * 2. 原生图片格式原图（当 thumb 为空或仅为原图文件名时，直接采信 filePath 原文，杜绝错误拼接）
 * 3. 独立转码/抽帧缩略图（如 .VirtualDirectory/.thumbnail/...webp）
 * 4. 跨工作区/切换工作区中途态防串扰（强制校验 filePath 是否真属 workspaceDirectoryPath，若不匹配绝不使用错误工作区拼接）
 */
export function resolveThumbnailUrl(
  thumbnailPath?: string | null,
  filePath?: string | null,
  workspaceDirectoryPath?: string | null
): string {
  const thumb = thumbnailPath ? thumbnailPath.trim() : ''
  const cleanFilePath = filePath ? filePath.trim() : ''
  const fileExt = cleanFilePath.split('.').pop()?.toLowerCase() || ''
  const isImage = NATIVE_IMAGE_EXTENSIONS.has(fileExt)

  // 1. 如果有缩略图路径
  if (thumb) {
    const isAbs = /^[a-zA-Z]:[\\/]/.test(thumb) || thumb.startsWith('/') || thumb.startsWith('\\\\')

    if (isAbs) {
      return toSafeFileUrl(thumb)
    }

    // 判断 thumb 是否为独立生成的转码/抽帧缩略图（通常存放于 .VirtualDirectory/.thumbnail 下）
    const isGeneratedThumb =
      thumb.includes('.VirtualDirectory') ||
      thumb.includes('.thumbnail') ||
      thumb.startsWith('.thumbnail')

    // 如果是常见原生图片格式，且 thumb 只是图片本身的文件名或相对路径（非独立生成的 .thumbnail），
    // 原文件路径 cleanFilePath 就是最权威的绝对路径，直接使用，彻底避免跨工作区错误拼接导致 404
    if (isImage && cleanFilePath && !isGeneratedThumb) {
      return toSafeFileUrl(cleanFilePath)
    }

    // 针对相对路径缩略图（如 .VirtualDirectory/.thumbnail/...），推导所属的合法工作区路径
    let wsDir = ''

    // 优先校验传入的 workspaceDirectoryPath 是否确为 cleanFilePath 的父级工作区
    if (workspaceDirectoryPath && cleanFilePath) {
      if (isParentPath(workspaceDirectoryPath, cleanFilePath)) {
        wsDir = workspaceDirectoryPath
      }
    } else if (workspaceDirectoryPath && !cleanFilePath) {
      wsDir = workspaceDirectoryPath
    }

    // 若 workspaceDirectoryPath 与 cleanFilePath 并不匹配（如跨工作区搜索、工作区切换中途态），
    // 坚决不可使用错误的 workspaceDirectoryPath，改从 cleanFilePath 自身推导
    if (!wsDir && cleanFilePath) {
      const virtIdx = cleanFilePath.indexOf('.VirtualDirectory')
      if (virtIdx > 0) {
        wsDir = cleanFilePath.substring(0, virtIdx).replace(/[\\/]+$/, '')
      } else {
        const lastSep = Math.max(cleanFilePath.lastIndexOf('/'), cleanFilePath.lastIndexOf('\\'))
        if (lastSep > 0) {
          wsDir = cleanFilePath.substring(0, lastSep)
        }
      }
    }

    // 兜底：检查全局 store 中的当前工作区（同样需校验归属性）
    if (!wsDir) {
      try {
        const storeWs = useVirtualDirectoryStore.getState().currentWorkspaceDirectory?.path || ''
        if (storeWs && (!cleanFilePath || isParentPath(storeWs, cleanFilePath))) {
          wsDir = storeWs
        }
      } catch (error) {
        // 兜底读取工作区失败必须上报，严禁静默降级掩盖 store 异常
        logger.warn(LogCategory.RENDERER, '读取当前工作区用于缩略图解析失败', error)
      }
    }

    if (wsDir) {
      const cleanWs = wsDir.replace(/[\\/]+$/, '')
      const cleanThumb = thumb.replace(/^[\\/]+/, '')
      return toSafeFileUrl(`${cleanWs}/${cleanThumb}`)
    }

    // 若无法推导出合法工作区但文件本身是图片，平滑降级使用原图
    if (isImage && cleanFilePath) {
      return toSafeFileUrl(cleanFilePath)
    }
  }

  // 2. 若无独立生成缩略图，但属于常见网页原生支持渲染的图片格式，直接以原文件路径作为缩略图呈现
  if (isImage && cleanFilePath) {
    return toSafeFileUrl(cleanFilePath)
  }

  return ''
}
