import { useCallback, useMemo, useState } from 'react'
import { WorkspaceDirectory } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { useAnalyzedDirectoryStore } from '../../../../../stores/analyzed-directory-store'
import { useVirtualDirectoryStore } from '../../../../../stores/virtual-directory-store'
import { useTierStore } from '../../../../../stores/tier-store'

/**
 * 工作目录域：工作区目录列表、下拉开关、当前工作区是否仍处于可用槽位。
 */
export function useOrganizeWorkdir() {
  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const { computed_limits } = useTierStore()

  // ─── 工作目录 ─────────────────────────────────────────────────────────────
  const workspaceDirectories = useVirtualDirectoryStore((s: any) => s.workspaceDirectories)
  const [showDirectoryDropdown, setShowDirectoryDropdown] = useState(false)

  const isWorkspaceActive = useMemo(() => {
    if (!currentWorkspaceDirectory || !workspaceDirectories.length) return true
    const type = currentWorkspaceDirectory.type
    if (type !== 'SPEEDY' && type !== 'PRIVATE') return true

    const sameTypeDirs = workspaceDirectories.filter((d: WorkspaceDirectory) => d.type === type)
    const { isPathEqual } = window.electronAPI!.utils
    const index = sameTypeDirs.findIndex(
      (d: WorkspaceDirectory) =>
        d.path &&
        currentWorkspaceDirectory.path &&
        isPathEqual(d.path, currentWorkspaceDirectory.path)
    )
    if (index === -1) return true

    const limit =
      type === 'SPEEDY'
        ? ((computed_limits as any)?.speedy_dir_slot_limit ?? 1)
        : ((computed_limits as any)?.private_dir_slot_limit ?? 1)

    if (index < limit) return true

    return false
  }, [currentWorkspaceDirectory, workspaceDirectories, computed_limits])

  const loadWorkspaceDirectories = useCallback(async () => {
    try {
      if (typeof window.electronAPI?.getAllWorkspaceDirectories === 'function') {
        const dirs = await window.electronAPI.getAllWorkspaceDirectories()
        useVirtualDirectoryStore.getState().setWorkspaceDirectories(dirs || [])
      }
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '加载工作目录失败:', e)
    }
  }, [])

  return {
    workspaceDirectories,
    showDirectoryDropdown,
    setShowDirectoryDropdown,
    isWorkspaceActive,
    loadWorkspaceDirectories
  }
}
