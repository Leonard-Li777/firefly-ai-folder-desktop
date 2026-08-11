import { describe, expect, it, beforeEach } from 'vitest'
import { useVirtualDirectoryStore } from '../virtual-directory-store'
import { WorkspaceDirectory, SelectedTag } from '@yonuc/types'

describe('VirtualDirectoryStore', () => {
  beforeEach(() => {
    // Manually reset the store before each test
    useVirtualDirectoryStore.setState({
      currentWorkspaceDirectory: null,
      dimensionGroups: [],
      selectedTags: [],
      filteredFiles: [],
      isLoading: false,
      selectedItem: null,
      selectedFiles: [],
    })
  })

  it('resets selected tags and filtered files when current workspace directory is updated', () => {
    const store = useVirtualDirectoryStore.getState()
    
    // 1. Setup initial state with some tags and filtered files
    const mockTag: SelectedTag = {
      dimensionId: 1,
      tagId: 101,
      tagName: 'Test Tag',
      dimensionName: 'Test Dimension'
    }
    
    useVirtualDirectoryStore.setState({
      selectedTags: [mockTag],
      filteredFiles: [{ path: '/a/file.txt', name: 'file.txt' } as any]
    })
    
    // 2. Mock a new workspace directory
    const newDir: WorkspaceDirectory = {
      path: '/new/workspace',
      name: 'New Workspace',
      type: 'SPEEDY',
      recursive: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastScanAt: null
    }
    
    // 3. Update the directory
    useVirtualDirectoryStore.getState().setCurrentWorkspaceDirectory(newDir)
    
    // 4. Verify that tags and files are reset
    const updatedStore = useVirtualDirectoryStore.getState()
    expect(updatedStore.currentWorkspaceDirectory).toEqual(newDir)
    expect(updatedStore.selectedTags).toHaveLength(0)
    expect(updatedStore.filteredFiles).toHaveLength(0)
  })
})
