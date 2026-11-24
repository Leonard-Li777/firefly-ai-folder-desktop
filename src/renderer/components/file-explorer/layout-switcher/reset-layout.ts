import { useLayoutSwitcherStore } from '../../../stores/layout-switcher-store'
import { useVirtualDirectoryStore } from '../../../stores/virtual-directory-store'

/**
 * 清除当前页面与 SplitPane 持久化布局尺寸并重载页面，与头像菜单「重置布局」共用单一事实源。
 */
export function resetCurrentPageLayout(pathname: string, pageId?: string): void {
  let storageKey = 'real-directory'
  if (pathname === '/analyzed-directory') {
    storageKey = 'analyzed-directory'
  } else if (pathname.startsWith('/virtual-directory')) {
    storageKey = 'virtual-directory'
  } else if (pathname === '/organize') {
    storageKey = 'organize-main'
  }

  localStorage.removeItem('split-pane:' + storageKey)

  const effectivePageId = pageId || storageKey
  for (const key of [
    `hub_split_v1_${effectivePageId}_primary_h`,
    `hub_split_v1_${effectivePageId}_primary_v`,
    `hub_split_v1_${effectivePageId}_companion_h`,
    `hub_split_v1_${effectivePageId}_companion_v`,
    `split-pane:${effectivePageId}:primary_h`,
    `split-pane:${effectivePageId}:primary_v`,
    `split-pane:${effectivePageId}:companion_h`,
    `split-pane:${effectivePageId}:companion_v`
  ]) {
    localStorage.removeItem(key)
  }

  try {
    const ws = useVirtualDirectoryStore.getState().currentWorkspaceDirectory
    const wsId = ws?.workspace_id ?? ws?.id
    // 纯粹清空当前工作区/页面的 Level 1 用户覆盖，使 Level 2 工作流基线或 Level 3 页面保底平滑恢复
    useLayoutSwitcherStore.getState().clearUserLayout?.(wsId ?? undefined, effectivePageId)
  } catch {
    // store 未挂载时忽略，依靠清缓存后整页刷新恢复默认布局
  }

  window.location.reload()
}
