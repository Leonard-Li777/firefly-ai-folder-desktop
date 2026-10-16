import { useMemo } from 'react'
import { useVirtualDirectoryStore } from '../../../stores/virtual-directory-store'

export interface UseIsPrivateFileOptions {
  filePath?: string
  workspaceDirectoryType?: 'SPEEDY' | 'PRIVATE' | 'VDIR'
}

/**
 * 判断当前预览文件是否属于私有目录 (PRIVATE)
 * 优先级规则：
 * 1. 若显式指定了 workspaceDirectoryType，以其为第一优先级 ('PRIVATE' 为私有)
 * 2. 否则若提供了 filePath，且存在已加载的 workspaceDirectories，基于路径层级匹配所属工作区类型
 * 3. 兜底回退到当前全局激活的工作区 currentWorkspaceDirectory.type
 */
export function useIsPrivateFile(options?: UseIsPrivateFileOptions): boolean {
  const currentWorkspaceDirectory = useVirtualDirectoryStore(s => s.currentWorkspaceDirectory)
  const workspaceDirectories = useVirtualDirectoryStore(s => s.workspaceDirectories)

  return useMemo(() => {
    // 1. 若显式指定了工作区类型
    if (options?.workspaceDirectoryType) {
      return options.workspaceDirectoryType === 'PRIVATE'
    }

    const targetPath = options?.filePath
    const isSubPathFn = window?.electronAPI?.utils?.isSubPath
    const isPathEqualFn =
      window?.electronAPI?.utils?.isPathEqual || ((a: string, b: string) => a === b)

    // 2. 根据 filePath 查找匹配的工作区
    if (targetPath && workspaceDirectories && workspaceDirectories.length > 0) {
      const matched = workspaceDirectories.find(ws => {
        if (!ws.path) return false
        if (isPathEqualFn(ws.path, targetPath)) return true
        if (typeof isSubPathFn === 'function') {
          return isSubPathFn(ws.path, targetPath)
        }
        return targetPath.startsWith(ws.path)
      })
      if (matched) {
        return matched.type === 'PRIVATE'
      }
    }

    // 3. 兜底回退到当前激活工作区
    return currentWorkspaceDirectory?.type === 'PRIVATE'
  }, [
    options?.workspaceDirectoryType,
    options?.filePath,
    currentWorkspaceDirectory,
    workspaceDirectories
  ])
}
