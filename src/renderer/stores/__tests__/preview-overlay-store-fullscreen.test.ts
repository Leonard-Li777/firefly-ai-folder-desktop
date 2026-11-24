// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest'
import { usePreviewOverlayStore } from '../preview-overlay-store'

describe('usePreviewOverlayStore 全屏模式记忆与 ESC 关闭生命周期契约', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    usePreviewOverlayStore.setState({
      isOpen: false,
      filePath: '',
      fileName: '',
      extension: '',
      previewMode: 'split',
      activePageId: '',
      pageStates: {}
    })
  })

  it('全屏模式下 ESC 关闭后，保持全屏偏好模式，后续点击可再次自动全屏，直到用户切换为分栏', () => {
    const pageId = 'analyzed-test-page'
    const store = usePreviewOverlayStore.getState()

    // 1. 初始打开文件 A (分栏模式)
    store.openPreview('D:/photos/a.jpg', 'a.jpg', 'jpg', pageId)
    expect(usePreviewOverlayStore.getState().isOpen).toBe(false)
    expect(usePreviewOverlayStore.getState().getPagePreviewMode(pageId)).toBe('split')

    // 2. 用户点击工具栏切换为全屏模式
    store.togglePreviewMode(pageId)
    expect(usePreviewOverlayStore.getState().isOpen).toBe(true)
    expect(usePreviewOverlayStore.getState().getPagePreviewMode(pageId)).toBe('fullscreen')

    // 3. 用户按 ESC 关闭全屏预览
    store.closePreview(pageId)
    // 覆盖层关闭，文件信息清空
    expect(usePreviewOverlayStore.getState().isOpen).toBe(false)
    expect(usePreviewOverlayStore.getState().filePath).toBe('')
    // ★ 关键契约：页面预览偏好必须依然保持为 fullscreen！不能被私自篡改为 split！
    expect(usePreviewOverlayStore.getState().getPagePreviewMode(pageId)).toBe('fullscreen')

    // 4. 用户再次点击文件 B：由于记忆为全屏模式，应直接自动在全屏覆盖层中展开
    store.openPreview('D:/photos/b.jpg', 'b.jpg', 'jpg', pageId)
    expect(usePreviewOverlayStore.getState().isOpen).toBe(true)
    expect(usePreviewOverlayStore.getState().filePath).toBe('D:/photos/b.jpg')
    expect(usePreviewOverlayStore.getState().getPagePreviewMode(pageId)).toBe('fullscreen')

    // 5. 再次按 ESC 关闭
    store.closePreview(pageId)
    expect(usePreviewOverlayStore.getState().isOpen).toBe(false)
    expect(usePreviewOverlayStore.getState().getPagePreviewMode(pageId)).toBe('fullscreen')

    // 6. 再次点击第一张图片 A：依然自动打开全屏
    store.openPreview('D:/photos/a.jpg', 'a.jpg', 'jpg', pageId)
    expect(usePreviewOverlayStore.getState().isOpen).toBe(true)
    expect(usePreviewOverlayStore.getState().filePath).toBe('D:/photos/a.jpg')
    expect(usePreviewOverlayStore.getState().getPagePreviewMode(pageId)).toBe('fullscreen')

    // 7. 用户在工具栏中主动点击“分栏模式”切换
    store.togglePreviewMode(pageId)
    expect(usePreviewOverlayStore.getState().isOpen).toBe(false)
    expect(usePreviewOverlayStore.getState().getPagePreviewMode(pageId)).toBe('split')

    // 8. 恢复分栏后，后续点击在分栏中打开（isOpen: false）
    store.openPreview('D:/photos/c.jpg', 'c.jpg', 'jpg', pageId)
    expect(usePreviewOverlayStore.getState().isOpen).toBe(false)
    expect(usePreviewOverlayStore.getState().pageStates[pageId]?.filePath).toBe('D:/photos/c.jpg')
  })
})
