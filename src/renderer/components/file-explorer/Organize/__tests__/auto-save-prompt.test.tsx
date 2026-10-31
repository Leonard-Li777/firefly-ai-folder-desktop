import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { Organize } from '../index'
import { useOrganizeStore } from '../../../../stores/organize-store'

// Mock 外部依赖
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/organize', search: '' }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()]
}))

vi.mock('@app/languages', () => ({
  t: (key: string, params?: any) => {
    if (params && typeof params === 'object') {
      let res = key
      for (const k in params) {
        res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k])
      }
      return res
    }
    return key
  },
  $t: (key: string) => key,
  Translate: ({ children }: any) => children,
  i18nScope: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' },
  default: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' }
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({
    t: (s: string) => s,
    activeLanguage: 'zh-CN',
    defaultLanguage: 'zh-CN'
  })
}))

vi.mock('../hooks/useOrganizeState', () => ({
  useOrganizeState: vi.fn()
}))

vi.mock('../components/StageBreadcrumb', () => ({
  StageBreadcrumb: () => <div data-testid="stage-breadcrumb" />
}))

vi.mock('../components/StructureView', () => ({
  StructureView: () => <div data-testid="structure-view" />
}))

vi.mock('../components/DoneView', () => ({
  DoneView: () => <div data-testid="done-view" />
}))

vi.mock('../components/OrganizeSidebar', () => ({
  OrganizeSidebar: () => <div data-testid="organize-sidebar" />
}))

vi.mock('../components/RootModeSelectView', () => ({
  RootModeSelectView: () => <div data-testid="root-mode-select-view" />
}))

vi.mock('../components/SmartClusteringView', () => ({
  SmartClusteringView: () => <div data-testid="smart-clustering-view" />
}))

vi.mock('../../DirectoryHeader', () => ({
  DirectoryHeader: () => <div data-testid="directory-header" />
}))

vi.mock('../../FileExplorerLayout', () => ({
  FileExplorerLayout: ({ children }: any) => <div>{children}</div>
}))

vi.mock('../../../stores/search-store', () => ({
  useSearchStore: () => ({
    setAnalyzedDirectoryKeyword: vi.fn()
  })
}))

vi.mock('../../../stores/analyzed-directory-store', () => ({
  useAnalyzedDirectoryStore: () => ({
    allFiles: []
  })
}))

import { useOrganizeState } from '../hooks/useOrganizeState'

describe('Organize 自动保存文案提示测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOrganizeStore.setState({
      stage: 'structure',
      organizeMode: 'fine-organize',
      currentVDir: null,
      draft: null
    })
  })

  it('structure 阶段未保存虚拟目录时应展示“本页面自动保存草稿”', () => {
    ;(useOrganizeState as any).mockReturnValue({
      stage: 'structure',
      organizeMode: 'fine-organize',
      currentVDir: null,
      draft: { source: 'draft' },
      options: { allowCreateNew: false },
      setOptions: vi.fn(),
      handleStartOrganize: vi.fn(),
      canGoBack: false,
      canForward: false,
      candidates: [],
      displayTree: [],
      draftTree: [{ name: 'test', subdirectories: [], files: [] }],
      finalTree: [],
      isExecutingRename: false,
      isSavingTags: false,
      isTrashingDuplicates: false,
      isDuplicateProcessing: false,
      duplicateSelectedCount: 0,
      smartClusterSaveState: { canSave: false, isSaving: false },
      isGeneratingCandidates: false,
      customTreeCanSubmit: false,
      optionsHistory: [],
      rawToOrganizeCount: 0,
      capacityExceededCount: 0,
      toOrganizeFiles: [],
      organizeCapacityLimit: 3000,
      bypassCapacityLimit: false,
      organizeFileLimitOverride: null,
      handleAttemptEnterModeSelect: vi.fn(),
      setStage: vi.fn()
    })

    render(<Organize />)
    expect(screen.getByText('本页面自动保存草稿')).toBeInTheDocument()
    expect(screen.queryByText('本页面自动保存')).not.toBeInTheDocument()
  })

  it('structure 阶段已保存虚拟目录时（如增量整理）应展示“本页面自动保存”', () => {
    ;(useOrganizeState as any).mockReturnValue({
      stage: 'structure',
      organizeMode: 'incremental-organize',
      currentVDir: { id: 101, name: '已保存目录', source: 'ai-reorganized' },
      draft: { source: 'incremental' },
      options: { allowCreateNew: false },
      setOptions: vi.fn(),
      handleStartOrganize: vi.fn(),
      canGoBack: false,
      canForward: false,
      candidates: [],
      displayTree: [],
      draftTree: [{ name: 'test', subdirectories: [], files: [] }],
      finalTree: [],
      isExecutingRename: false,
      isSavingTags: false,
      isTrashingDuplicates: false,
      isDuplicateProcessing: false,
      duplicateSelectedCount: 0,
      smartClusterSaveState: { canSave: false, isSaving: false },
      isGeneratingCandidates: false,
      customTreeCanSubmit: false,
      optionsHistory: [],
      rawToOrganizeCount: 0,
      capacityExceededCount: 0,
      toOrganizeFiles: [],
      organizeCapacityLimit: 3000,
      bypassCapacityLimit: false,
      organizeFileLimitOverride: null,
      handleAttemptEnterModeSelect: vi.fn(),
      setStage: vi.fn()
    })

    render(<Organize />)
    expect(screen.getByText('本页面自动保存')).toBeInTheDocument()
    expect(screen.queryByText('本页面自动保存草稿')).not.toBeInTheDocument()
  })

  it('done 阶段未保存虚拟目录时应展示“本页面自动保存草稿”及保存虚拟目录按钮', () => {
    ;(useOrganizeState as any).mockReturnValue({
      stage: 'done',
      organizeMode: 'fine-organize',
      currentVDir: { id: 102, name: '草稿目录', source: 'draft' },
      draft: { source: 'draft' },
      options: { allowCreateNew: false },
      setOptions: vi.fn(),
      handleSave: vi.fn(),
      canGoBack: false,
      canForward: false,
      candidates: [],
      displayTree: [{ name: 'test', subdirectories: [], files: [] }],
      draftTree: [],
      finalTree: [{ name: 'test', subdirectories: [], files: [] }],
      isExecutingRename: false,
      isSavingTags: false,
      isTrashingDuplicates: false,
      isDuplicateProcessing: false,
      duplicateSelectedCount: 0,
      smartClusterSaveState: { canSave: false, isSaving: false },
      isGeneratingCandidates: false,
      customTreeCanSubmit: false,
      optionsHistory: [],
      rawToOrganizeCount: 0,
      capacityExceededCount: 0,
      toOrganizeFiles: [],
      organizeCapacityLimit: 3000,
      bypassCapacityLimit: false,
      organizeFileLimitOverride: null,
      handleAttemptEnterModeSelect: vi.fn(),
      setStage: vi.fn()
    })

    render(<Organize />)
    expect(screen.getByText('本页面自动保存草稿')).toBeInTheDocument()
    expect(screen.getByText('保存虚拟目录，支持后续继续整理和增量整理')).toBeInTheDocument()
  })

  it('done 阶段已保存虚拟目录时应展示切换虚拟目录查看结果的引导链接', () => {
    ;(useOrganizeState as any).mockReturnValue({
      stage: 'done',
      organizeMode: 'incremental-organize',
      currentVDir: { id: 103, name: '已保存目录', source: 'ai-reorganized' },
      draft: null,
      options: { allowCreateNew: false },
      setOptions: vi.fn(),
      handleSave: vi.fn(),
      canGoBack: false,
      canForward: false,
      candidates: [],
      displayTree: [{ name: 'test', subdirectories: [], files: [] }],
      draftTree: [],
      finalTree: [{ name: 'test', subdirectories: [], files: [] }],
      isExecutingRename: false,
      isSavingTags: false,
      isTrashingDuplicates: false,
      isDuplicateProcessing: false,
      duplicateSelectedCount: 0,
      smartClusterSaveState: { canSave: false, isSaving: false },
      isGeneratingCandidates: false,
      customTreeCanSubmit: false,
      optionsHistory: [],
      rawToOrganizeCount: 0,
      capacityExceededCount: 0,
      toOrganizeFiles: [],
      organizeCapacityLimit: 3000,
      bypassCapacityLimit: false,
      organizeFileLimitOverride: null,
      handleAttemptEnterModeSelect: vi.fn(),
      setStage: vi.fn()
    })

    render(<Organize />)
    expect(screen.getByText('本页面自动保存，你可随时切换虚拟目录页面查看结果')).toBeInTheDocument()
    expect(screen.queryByText('本页面自动保存草稿')).not.toBeInTheDocument()
    expect(screen.queryByText('保存虚拟目录，支持后续继续整理和增量整理')).not.toBeInTheDocument()
  })
})
