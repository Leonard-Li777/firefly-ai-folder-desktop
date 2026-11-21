import { describe, it, expect, beforeEach } from 'vitest'
import { useAnalyzedDirectoryStore } from '../analyzed-directory-store'

/**
 * 切换工作目录残留清理收口验收锁：
 *
 * Bug 现象：切换到另一个工作目录后，分类维度树仍显示上一个目录的维度树，
 * 文件预览面板还保留着上一个目录选中的文件预览。
 *
 * 根因：setCurrentWorkspaceDirectory 之前只重置 selectedTags / filteredFiles /
 * totalFilesCount，漏掉 dimensionGroups（分类维度树）、pathCountMap、
 * selectedItem（文件预览）、selectedFiles。
 *
 * 同时必须保证：loadWorkspaceDirectories 轮询在「同一路径」下回调本 action 时
 * 不得误清用户当前选中的预览（否则每次刷新预览都会闪没）。
 */
describe('analyzed-directory-store / setCurrentWorkspaceDirectory 切换目录残留清理', () => {
  const DIR_A = { id: 1, path: 'C:\\ws\\alpha', name: 'alpha' } as any
  const DIR_A_REFRESHED = { id: 1, path: 'C:\\ws\\alpha', name: 'alpha-renamed' } as any
  const DIR_B = { id: 2, path: 'C:\\ws\\beta', name: 'beta' } as any

  /** 构造「上一个目录已选中文件 + 已加载维度树」的脏状态 */
  const seedStaleState = () => {
    useAnalyzedDirectoryStore.setState({
      dimensionGroups: [{ id: 10, name: 'stale-group', tags: [] }] as any,
      pathCountMap: { 'C:\\ws\\alpha\\a.mp4': 3 },
      selectedItem: { id: 99, path: 'C:\\ws\\alpha\\a.mp4', name: 'a.mp4' } as any,
      selectedFiles: [{ id: 99, path: 'C:\\ws\\alpha\\a.mp4', name: 'a.mp4' }] as any,
      selectedTags: [{ dimensionId: 10, tagValue: 'stale' }] as any
    })
    // 先正式切到 A，使 currentWorkspaceDirectory 有值
    useAnalyzedDirectoryStore.getState().setCurrentWorkspaceDirectory(DIR_A)
    // 再补回脏派生态，模拟「A 目录下已浏览/已加载」
    useAnalyzedDirectoryStore.setState({
      dimensionGroups: [{ id: 10, name: 'stale-group', tags: [] }] as any,
      pathCountMap: { 'C:\\ws\\alpha\\a.mp4': 3 },
      selectedItem: { id: 99, path: 'C:\\ws\\alpha\\a.mp4', name: 'a.mp4' } as any,
      selectedFiles: [{ id: 99, path: 'C:\\ws\\alpha\\a.mp4', name: 'a.mp4' }] as any
    })
  }

  beforeEach(() => {
    useAnalyzedDirectoryStore.setState({
      currentWorkspaceDirectory: null,
      dimensionGroups: [],
      pathCountMap: undefined,
      selectedItem: null,
      selectedFiles: [],
      selectedTags: [],
      filteredFiles: []
    })
  })

  it('切换到不同工作目录时，清空分类维度树、路径计数、选中预览与多选项', () => {
    seedStaleState()

    useAnalyzedDirectoryStore.getState().setCurrentWorkspaceDirectory(DIR_B)

    const after = useAnalyzedDirectoryStore.getState()
    expect(after.currentWorkspaceDirectory?.path).toBe(DIR_B.path)
    // 分类维度树不再残留上一目录
    expect(after.dimensionGroups).toEqual([])
    expect(after.pathCountMap).toBeUndefined()
    // 文件预览不再残留上一目录选中的文件
    expect(after.selectedItem).toBeNull()
    expect(after.selectedFiles).toEqual([])
  })

  it('同一工作目录刷新时，保留用户当前选中的预览与多选项（防轮询误清）', () => {
    seedStaleState()
    const before = useAnalyzedDirectoryStore.getState()

    // loadWorkspaceDirectories 轮询用同路径的新对象回调
    useAnalyzedDirectoryStore.getState().setCurrentWorkspaceDirectory(DIR_A_REFRESHED)

    const after = useAnalyzedDirectoryStore.getState()
    expect(after.currentWorkspaceDirectory?.name).toBe(DIR_A_REFRESHED.name)
    // 同目录刷新不得清空用户正在看的预览
    expect(after.selectedItem).toEqual(before.selectedItem)
    expect(after.selectedFiles).toEqual(before.selectedFiles)
    expect(after.dimensionGroups).toEqual(before.dimensionGroups)
  })

  it('初始无目录时首次设置目录（null -> 有值）视为切换，派生态从零开始', () => {
    useAnalyzedDirectoryStore.setState({
      dimensionGroups: [{ id: 1, name: 'x', tags: [] }] as any,
      selectedItem: { id: 1, path: 'C:\\other\\x.mp4' } as any
    })

    useAnalyzedDirectoryStore.getState().setCurrentWorkspaceDirectory(DIR_A)

    const after = useAnalyzedDirectoryStore.getState()
    expect(after.dimensionGroups).toEqual([])
    expect(after.selectedItem).toBeNull()
  })
})
