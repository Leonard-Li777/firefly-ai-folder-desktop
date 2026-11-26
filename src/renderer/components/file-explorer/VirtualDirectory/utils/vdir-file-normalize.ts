import { getFileNameFromPath } from '@firefly/shared'

/**
 * 将虚拟目录树快照中的文件记录归一化为与右侧 FileList 完全同源的 FileItem 形状。
 *
 * 树快照记录（`virtual_directory_files` 查询结果）只有 `fileId` / `originalPath` 等物理字段，
 * 缺少 FileItem 契约要求的 `path` / `extension` / `id`：
 * - 属性面板依赖 `item.path` 定位缩略图与迷你预览；
 * - FileExplorerLayout 的预览同步、FileList 的选中高亮依赖 `path` 参与匹配。
 * 若直接把原始记录当作 activeItem，左侧目录树点到文件后预览与属性面板、列表选中态都会失联。
 *
 * @param f 树快照或标签过滤结果中的文件记录
 */
export function normalizeVirtualDirectoryFile(f: any): any {
  const originalPath = f?.originalPath || f?.path || ''
  let parsedTags: string[] = []
  if (f?.tags) {
    try {
      const arr = typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags
      parsedTags = Array.isArray(arr) ? arr.filter(Boolean) : []
    } catch {
      parsedTags = []
    }
  }
  return {
    id: f?.fileId ?? f?.id,
    path: originalPath,
    // 树节点在 getTreeChildren 中已把 name 改写为智能文件名，这里优先取回物理文件名，
    // 保证与 FileList 条目字段语义一致（name=物理名、smartName=智能名）。
    name: f?._rawName || f?.name || getFileNameFromPath(originalPath) || 'unknown',
    size: f?.size || 0,
    extension: '.' + (originalPath?.split('.').pop()?.toLowerCase() || ''),
    isFile: true,
    fileFingerprint: f?.fileFingerprint,
    originalPath,
    smartName: f?.smartName,
    qualityScore: f?.qualityScore,
    description: f?.description,
    tags: parsedTags,
    author: f?.author,
    language: f?.language,
    analyzedAt: f?.analyzedAt,
    lastAnalyzedAt: f?.analyzedAt,
    modifiedAt: f?.modifiedAt
  } as any
}
