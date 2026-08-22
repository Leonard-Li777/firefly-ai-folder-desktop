import { create } from 'zustand'
import { logger, LogCategory } from '@firefly/shared'

export type PagePreviewMode = 'split' | 'fullscreen' | 'closed'

interface PagePreviewState {
  mode: PagePreviewMode
  /** 该页面当前正在预览的文件路径（独立于全局 filePath，避免页面切换时互相覆盖） */
  filePath?: string
  /** 该页面当前正在预览的文件名 */
  fileName?: string
  /** 该页面当前正在预览的扩展名 */
  extension?: string
}

interface PreviewOverlayState {
  isOpen: boolean
  filePath: string
  fileName: string
  extension: string
  /** 兼容测试/单页的全局预览模式 */
  previewMode: PagePreviewMode
  /** 当前预览所属的页面标识 */
  activePageId: string
  /** 每个页面独立的预览状态（分栏/全屏/关闭） */
  pageStates: Record<string, PagePreviewState>
  openPreview: (filePath: string, fileName: string, extension: string, pageId?: string) => void
  closePreview: (pageId?: string) => void
  clearPreview: (pageId?: string) => void
  togglePreviewMode: (pageId?: string) => void
  /** 获取指定页面的预览模式 */
  getPagePreviewMode: (pageId: string) => PagePreviewMode
  /** 获取指定页面独立保存的预览文件信息（不受 activePageId 影响） */
  getPagePreviewFile: (
    pageId: string
  ) => { filePath: string; fileName: string; extension: string } | null
}

function getStorageKey(pageId: string): string {
  return `preview-mode-${pageId}`
}

function loadPagePreviewMode(pageId: string): PagePreviewMode {
  try {
    const stored = pageId ? sessionStorage.getItem(getStorageKey(pageId)) : null
    const fallback = localStorage.getItem('preview-mode')
    const res = stored || fallback
    if (res === 'split' || res === 'fullscreen' || res === 'closed') {
      return res
    }
  } catch (error) {
    console.error('加载页面预览模式失败:', error)
  }
  return 'split'
}

function savePagePreviewMode(pageId: string, mode: PagePreviewMode): void {
  try {
    if (pageId) sessionStorage.setItem(getStorageKey(pageId), mode)
    localStorage.setItem('preview-mode', mode)
  } catch (error) {
    console.error('保存页面预览模式失败:', error)
  }
}

/**
 * 全局文件预览覆盖层状态
 * 通过 activePageId 隔离不同页面的预览：
 * - openPreview 设置 activePageId 为调用方的 pageId
 * - 各页面的 SplitPreviewPanel 只在 activePageId === 自己的 pageId 时显示预览
 * - closePreview 可选传入 pageId 做校验
 * - 每个页面独立存储预览模式（分栏/全屏/关闭），互不影响
 */
export const usePreviewOverlayStore = create<PreviewOverlayState>((set, get) => ({
  isOpen: false,
  filePath: '',
  fileName: '',
  extension: '',
  previewMode: 'split',
  activePageId: '',
  pageStates: {},

  getPagePreviewMode: (pageId: string) => {
    const state = get()
    const stored = state.pageStates[pageId]
    if (stored) return stored.mode
    const loaded = loadPagePreviewMode(pageId)
    // 缓存到 pageStates
    set(state => ({
      pageStates: { ...state.pageStates, [pageId]: { mode: loaded } }
    }))
    return loaded
  },

  openPreview: (filePath, fileName, extension, pageId = '') => {
    if (!pageId) {
      return
    }
    const state = get()
    // 优先读取显式设置的 state.previewMode（供单元测试/单页控制），否则按 pageStates/storage 规则
    const pageMode =
      state.previewMode !== 'split'
        ? state.previewMode
        : state.pageStates[pageId]?.mode || loadPagePreviewMode(pageId)

    // 幂等防护：如果参数与状态完全一致，则直接返回，防范死循环
    if (
      state.filePath === filePath &&
      state.fileName === fileName &&
      state.extension === extension &&
      state.activePageId === pageId &&
      state.pageStates[pageId]?.filePath === filePath &&
      (state.pageStates[pageId]?.mode === 'split' || !state.pageStates[pageId]) &&
      !state.isOpen
    ) {
      return
    }

    if (pageMode === 'fullscreen') {
      set({
        isOpen: true,
        filePath,
        fileName,
        extension,
        activePageId: pageId,
        previewMode: 'fullscreen',
        // 同步写入页面独立状态
        pageStates: {
          ...state.pageStates,
          [pageId]: {
            ...state.pageStates[pageId],
            mode: 'fullscreen',
            filePath,
            fileName,
            extension
          }
        }
      })
    } else {
      // 'split' 或 'closed' 模式都在分栏中打开，并自动切换到 split 模式
      if (pageMode === 'closed') {
        savePagePreviewMode(pageId, 'split')
      }
      set({
        isOpen: false,
        filePath,
        fileName,
        extension,
        activePageId: pageId,
        previewMode: 'split',
        // 同步写入页面独立状态（filePath/fileName/extension 与全局同步，但各页面互不干扰）
        pageStates: {
          ...state.pageStates,
          [pageId]: { ...state.pageStates[pageId], mode: 'split', filePath, fileName, extension }
        }
      })
    }
  },

  closePreview: pageId => {
    const state = get()
    if (pageId && state.activePageId && state.activePageId !== pageId) return
    const targetPageId = pageId || state.activePageId
    const pageMode = targetPageId
      ? state.pageStates[targetPageId]?.mode || loadPagePreviewMode(targetPageId)
      : state.previewMode

    if (pageMode === 'fullscreen') {
      set({
        isOpen: false,
        filePath: '',
        fileName: '',
        extension: '',
        activePageId: '',
        // 同步清空页面独立状态中的文件信息
        ...(targetPageId
          ? {
              pageStates: {
                ...state.pageStates,
                [targetPageId]: { mode: 'split', filePath: '', fileName: '', extension: '' }
              }
            }
          : {})
      })
    } else {
      // split 模式 → 关闭预览栏，切换到 closed 模式
      if (targetPageId) {
        savePagePreviewMode(targetPageId, 'closed')
      }
      set({
        isOpen: false,
        filePath: '',
        fileName: '',
        extension: '',
        activePageId: '',
        ...(targetPageId
          ? {
              pageStates: {
                ...state.pageStates,
                // 清空文件信息，同时标记为 closed 模式
                [targetPageId]: { mode: 'closed', filePath: '', fileName: '', extension: '' }
              }
            }
          : {})
      })
    }
  },

  /** 清空预览内容但不改变页面模式（用于单击不可预览文件时回到提示页面） */
  clearPreview: pageId => {
    const state = get()
    if (pageId && state.activePageId !== pageId && !state.filePath) return
    if (
      !state.filePath &&
      !state.fileName &&
      !state.extension &&
      state.activePageId === (pageId || '')
    )
      return

    set({
      filePath: '',
      fileName: '',
      extension: '',
      activePageId: pageId || '',
      // 同步清空页面独立状态中的文件信息
      ...(pageId
        ? {
            pageStates: {
              ...state.pageStates,
              [pageId]: { ...state.pageStates[pageId], filePath: '', fileName: '', extension: '' }
            }
          }
        : {})
    })
  },

  togglePreviewMode: (pageId?: string) => {
    const state = get()
    const targetPageId = pageId || state.activePageId
    const currentMode = targetPageId
      ? state.pageStates[targetPageId]?.mode || loadPagePreviewMode(targetPageId)
      : state.previewMode

    const newMode: PagePreviewMode = currentMode === 'fullscreen' ? 'split' : 'fullscreen'
    savePagePreviewMode(targetPageId, newMode)

    if (newMode === 'fullscreen' && state.filePath && state.activePageId === targetPageId) {
      set({
        previewMode: newMode,
        ...(targetPageId
          ? { pageStates: { ...state.pageStates, [targetPageId]: { mode: newMode } } }
          : {}),
        isOpen: true
      })
    } else if (newMode === 'split' && state.filePath && state.activePageId === targetPageId) {
      set({
        previewMode: newMode,
        ...(targetPageId
          ? { pageStates: { ...state.pageStates, [targetPageId]: { mode: newMode } } }
          : {}),
        isOpen: false
      })
    } else {
      set({
        previewMode: newMode,
        ...(targetPageId
          ? {
              pageStates: {
                ...state.pageStates,
                [targetPageId]: { ...state.pageStates[targetPageId], mode: newMode }
              }
            }
          : {})
      })
    }
  },

  getPagePreviewFile: (pageId: string) => {
    const state = get()
    const pageState = state.pageStates[pageId]
    if (!pageState?.filePath) return null
    return {
      filePath: pageState.filePath,
      fileName: pageState.fileName || '',
      extension: pageState.extension || ''
    }
  }
}))
