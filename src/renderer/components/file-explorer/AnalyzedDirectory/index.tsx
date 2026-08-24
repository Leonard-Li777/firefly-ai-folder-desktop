import { FileItem as FileType, SelectedTag, UnionMode, WorkspaceDirectory } from '@firefly/types'
import { AnalyzedDirectoryProps } from './types'
import { MaterialIcon, cn } from '../../../lib/utils'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../ui/dialog'
import { DimensionTreeSidebar } from '../DimensionTreeSidebar'
import { DimensionFileListPanel } from '../DimensionFileListPanel'
import { DirectoryHeader } from '../DirectoryHeader'
import { DirectoryManagementModals } from './components/DirectoryManagementModals'
import { FileDetailsPanel } from '../FileDetailsPanel/index'
import { NoWorkspaceDirectoryMessage } from '../../common/NoWorkspaceDirectoryMessage'
import { OrganizeModals } from './components/OrganizeModals'
import { QuotaWarningBar } from '../QuotaWarningBar'
import { UtilityModals } from './components/UtilityModals'
import { performanceTracker } from '../../../lib/performance-metrics'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { EmptyState } from '../../common/EmptyState'
import { toast } from '../../common/Toast'
import { useInvitation } from '../../../hooks/useInvitation'
import { useNavigate, useLocation } from 'react-router-dom'
import { useSearchStore } from '../../../stores/search-store'
import { usePreviewOverlayStore } from '../../../stores/preview-overlay-store'
import { getPreviewRouteType, getExtFromSmartName } from '../../../lib/preview-utils'
import { SplitPreviewPanel } from '../SplitPreviewPanel'
import { SplitPane } from '../../common/SplitPane'
import { useAnalyzedDirectoryFilter } from './hooks/useAnalyzedDirectoryFilter'
import { useAnalyzedDirectoryState } from './hooks/useAnalyzedDirectoryState'
import { useAnalyzedDirectoryStore } from '../../../stores/analyzed-directory-store'
import { PAGE_IDS } from '../../../constants/page-ids'
import { useTierStore } from '../../../stores/tier-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { RestrictedFeatureOverlay } from '../../common/RestrictedFeatureOverlay'
import { getSelectedTagsFromSet } from '../dimension-tree-utils'

/**
 * 虚拟目录组件
 * 提供基于 AI 分析维度的文件浏览和管理功能
 */
export const AnalyzedDirectory: React.FC<AnalyzedDirectoryProps> = () => {
  useVoerkaI18n(i18nScope)
  const navigate = useNavigate()
  const location = useLocation()
  const currentPath = location.pathname
  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(s => s.currentWorkspaceDirectory)
  const setCurrentWorkspaceDirectory = useAnalyzedDirectoryStore(
    s => s.setCurrentWorkspaceDirectory
  )
  const dimensionGroups = useAnalyzedDirectoryStore(s => s.dimensionGroups)
  const selectedTags = useAnalyzedDirectoryStore(s => s.selectedTags)
  const setSelectedTags = useAnalyzedDirectoryStore(s => s.setSelectedTags)
  const addSelectedTag = useAnalyzedDirectoryStore(s => s.addSelectedTag)
  const removeSelectedTag = useAnalyzedDirectoryStore(s => s.removeSelectedTag)
  const clearSelectedTags = useAnalyzedDirectoryStore(s => s.clearSelectedTags)
  const filteredFiles = useAnalyzedDirectoryStore(s => s.filteredFiles)
  const savedDirectories = useAnalyzedDirectoryStore(s => s.savedDirectories)
  const setSavedDirectories = useAnalyzedDirectoryStore(s => s.setSavedDirectories)
  const isLoading = useAnalyzedDirectoryStore(s => s.isLoading)
  const selectedItem = useAnalyzedDirectoryStore(s => s.selectedItem)
  const setSelectedItem = useAnalyzedDirectoryStore(s => s.setSelectedItem)
  const showDetailsPanel = useAnalyzedDirectoryStore(s => s.showDetailsPanel)
  const setShowDetailsPanel = useAnalyzedDirectoryStore(s => s.setShowDetailsPanel)

  const { setAnalyzedDirectoryKeyword } = useSearchStore()
  const { quota, refreshCount, isLoading: isInvitationLoading } = useInvitation(true)

  // Manage local states - isOrganizeMode: true = 整理模式, false = 浏览模式(默认)
  const [isOrganizeMode, setIsOrganizeMode] = useState(() => {
    // 从路由状态中读取初始模式（从虚拟目录点击+创建时传入）
    return (location.state as any)?.startInOrganizeMode === true
  })
  // 多选模式：独立控制维度标签的多选行为
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false)
  // 标签筛选模式：并集或交集
  const [unionMode, setUnionMode] = useState<UnionMode>('union')
  const [selectedFiles, setSelectedFilesBase] = useState<FileType[]>([])
  // 用 ref 保存最新的 selectedFiles，同步更新避免连续点击时 ref 过时
  const selectedFilesRef = useRef(selectedFiles)
  const setSelectedFiles = useCallback((files: FileType[]) => {
    selectedFilesRef.current = files
    setSelectedFilesBase(files)
  }, [])
  const [showManageModal, setShowManageModal] = useState(false)
  const [editingAnalyzedDirectoryId, setEditingAnalyzedDirectoryId] = useState<string | null>(null)
  const [editingDirectoryName, setEditingDirectoryName] = useState('')
  const [showInvitationModal, setShowInvitationModal] = useState(false)
  const [showThresholdDialog, setShowThresholdDialog] = useState(false)
  const [showGenerateAnalyzedDirDialog, setShowGenerateAnalyzedDirDialog] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const handleConfirmGenerateAnalyzedDirectories = useCallback(async (options: any) => {
    setShowGenerateAnalyzedDirDialog(false)
    toast.success(t('已分析目录已生成'))
  }, [])

  const dropdownRef = useRef<HTMLDivElement>(null!)

  const showEmptyTags = useSettingsStore(s => s.getConfigValue<boolean>('SHOW_EMPTY_TAGS')) ?? false
  const panDimensionIds =
    useSettingsStore(s => s.getConfigValue<number[]>('PAN_DIMENSION_IDS')) || []

  // Initialize modular hooks
  const state = useAnalyzedDirectoryState(
    isMultiSelectMode,
    clearSelectedTags,
    addSelectedTag,
    unionMode,
    () => setRefreshKey(k => k + 1)
  )

  const {
    analyzedFilesCount,
    loadDimensionGroups,
    loadFilteredFiles,
    loadWorkspaceDirectories,
    machineId,
    setMachineId,
    modelMode,
    serviceStatus,
    workspaceDirectories,
    showDirectoryDropdown,
    setShowDirectoryDropdown,
    isDimensionLoading,
    lastSingleTag
  } = state

  const pageStates = usePreviewOverlayStore(s => s.pageStates)
  const isSplitView = (pageStates[PAGE_IDS.ANALYZED_DIRECTORY]?.mode ?? 'split') === 'split'

  // 当路由切回已分析页面或选中项发生变化时，自动刷新/恢复属于当前页面的预览
  useEffect(() => {
    if (currentPath === '/analyzed-directory') {
      const splitState = usePreviewOverlayStore.getState()
      const pageMode = splitState.pageStates[PAGE_IDS.ANALYZED_DIRECTORY]?.mode ?? 'split'
      if (pageMode === 'split') {
        if (
          selectedItem &&
          selectedItem.path &&
          !('isDirectory' in selectedItem && (selectedItem as any).isDirectory)
        ) {
          const fileItem = selectedItem as FileType
          const ext =
            fileItem.extension ||
            getExtFromSmartName(fileItem.smartName || fileItem.name) ||
            fileItem.path.split('.').pop() ||
            ''
          const routeType = getPreviewRouteType(ext)
          if (routeType !== 'unsupported') {
            if (
              (splitState.activePageId === '' ||
                splitState.activePageId === PAGE_IDS.ANALYZED_DIRECTORY) &&
              splitState.filePath !== fileItem.path
            ) {
              splitState.openPreview(
                fileItem.path,
                fileItem.smartName || fileItem.name,
                ext,
                PAGE_IDS.ANALYZED_DIRECTORY
              )
            }
          } else if (
            splitState.activePageId === PAGE_IDS.ANALYZED_DIRECTORY &&
            splitState.filePath
          ) {
            splitState.clearPreview(PAGE_IDS.ANALYZED_DIRECTORY)
          }
        } else if (splitState.activePageId === PAGE_IDS.ANALYZED_DIRECTORY && splitState.filePath) {
          splitState.clearPreview(PAGE_IDS.ANALYZED_DIRECTORY)
        }
      }
    }
  }, [currentPath, selectedItem])

  const { computed_limits, fetchProfile } = useTierStore()

  const isWorkspaceActive = useMemo(() => {
    if (!currentWorkspaceDirectory || !workspaceDirectories.length) return true
    const type = currentWorkspaceDirectory.type
    if (type !== 'SPEEDY' && type !== 'PRIVATE') return true

    const sameTypeDirs = workspaceDirectories.filter(d => d.type === type)
    const { isPathEqual } = window.electronAPI!.utils
    const index = sameTypeDirs.findIndex(
      d =>
        d.path &&
        currentWorkspaceDirectory.path &&
        isPathEqual(d.path, currentWorkspaceDirectory.path)
    )
    if (index === -1) return true

    const limit =
      type === 'SPEEDY'
        ? (computed_limits?.speedy_dir_slot_limit ?? 1)
        : (computed_limits?.private_dir_slot_limit ?? 1)

    if (index < limit) return true

    return false
  }, [currentWorkspaceDirectory, workspaceDirectories, computed_limits])

  const organize = useAnalyzedDirectoryFilter(
    currentWorkspaceDirectory,
    selectedFiles,
    modelMode || 'local',
    serviceStatus,
    analyzedFilesCount,
    savedDirectories,
    async () => {
      if (!currentWorkspaceDirectory?.path) return
      const saved = await window.electronAPI!.analyzedDirectory.getSavedDirectories(
        currentWorkspaceDirectory.path
      )
      setSavedDirectories(saved)
    },
    loadFilteredFiles
  )

  const {
    handleQuickOrganize,
    handleConfirmOrganize,
    organizePreview,
    aiGeneratedStructure,
    fileMapForOrganize,
    showConfirmOrganizeDialog,
    setShowConfirmOrganizeDialog,
    showOrganizeProgressDialog,
    organizeProgress,
    showOrganizeErrorDialog,
    setShowOrganizeErrorDialog,
    organizeResult,
    setShowResultDialog,
    showResultDialog,
    showAIProgressDialog,
    setShowAIProgressDialog,
    aiBatchProgress,
    showEmptyFolderCleanupDialog,
    setShowEmptyFolderCleanupDialog,
    emptyFolderScanPath,
    setEmptyFolderScanPath,
    showConflictDialog,
    setShowConflictDialog,
    conflicts,
    handleConflictResolve,
    handleConflictCancel,
    handleCancelAIOrganize,
    handleDeleteNode,
    onPauseToggle,
    onEnd,
    isPaused
  } = organize

  // 清除路由状态，避免刷新页面时仍然保持整理模式
  useEffect(() => {
    if (location.state?.startInOrganizeMode) {
      window.history.replaceState({}, '')
    }
  }, [])

  // 监听路由状态变化，当从虚拟目录传入 startInOrganizeMode 时进入整理模式
  useEffect(() => {
    if (location.state?.startInOrganizeMode) {
      setIsOrganizeMode(true)
      window.history.replaceState({}, '')
    }
  }, [location.state])

  // 整理模式与多选模式联动：进入整理模式自动开启多选，退出时自动关闭
  useEffect(() => {
    if (isOrganizeMode) {
      setIsMultiSelectMode(true)
    } else {
      setIsMultiSelectMode(false)
    }
  }, [isOrganizeMode])

  // 当搜索结果变化时，清理不在结果中的已选中项 (O(N + M) 线性算法，彻底消除六百万次二次循环死锁)
  useEffect(() => {
    if (selectedFiles.length > 0) {
      if (filteredFiles.length === 0) {
        setSelectedFiles([])
        return
      }
      const { getPlatform } = window.electronAPI!.utils
      const isWin = getPlatform() === 'win32'
      const pathSet = new Set(filteredFiles.map(ff => (isWin ? ff.path.toLowerCase() : ff.path)))
      const newSelected = selectedFiles.filter(sf =>
        pathSet.has(isWin ? sf.path.toLowerCase() : sf.path)
      )
      if (newSelected.length !== selectedFiles.length) setSelectedFiles(newSelected)
    }
  }, [filteredFiles])

  // Handlers
  const handleTagClick = useCallback(
    (tag: SelectedTag) => {
      clearSelectedTags()
      addSelectedTag(tag)
    },
    [clearSelectedTags, addSelectedTag]
  )

  const handleToggleTagFromPanel = useCallback(
    (dimId: number, val: string, parentVal?: string) => {
      removeSelectedTag(dimId, val, parentVal)
    },
    [removeSelectedTag]
  )

  const handleSortChange = useCallback((b: any, o: any) => {
    // Logic handled inside DimensionFileListPanel or store
  }, [])

  const handleLoadMore = useCallback(() => {
    state.loadFilteredFiles(true)
  }, [state.loadFilteredFiles])

  const handleFirstRender = useCallback(() => {
    performanceTracker.end('Component Mount to Initial Render')
    performanceTracker.end('Total Switch Time (Real to Analyzed)')
    performanceTracker.logReport('Switch to Analyzed Directory')
  }, [])

  const handleConfirmOrganizeAnalyzedDirectory = useCallback(async () => {
    navigate('/organize')
  }, [navigate])

  const selectionStack = useMemo(() => {
    return selectedTags.map(t => `${t.dimensionId}::${t.parentTagValue || ''}::${t.tagValue}`)
  }, [selectedTags])

  const handleSelectionChange = useCallback(
    (
      tagsSet: Set<string>,
      reason: 'toggle' | 'selectAll' | 'invert' | 'clear',
      updatedParentTagMap: Map<string, string[]>
    ) => {
      const selectedList = getSelectedTagsFromSet(tagsSet, dimensionGroups, updatedParentTagMap)
      setSelectedTags(selectedList)
    },
    [dimensionGroups, setSelectedTags]
  )

  const handleModeChange = useCallback((mode: UnionMode) => {
    setUnionMode(mode)
  }, [])

  return (
    <div className="flex-1 flex flex-col overflow-hidden animate-in fade-in duration-300 slide-in-from-bottom-1">
      <div>
        <DirectoryHeader
          currentWorkspaceDirectory={currentWorkspaceDirectory}
          workspaceDirectories={workspaceDirectories}
          showDirectoryDropdown={showDirectoryDropdown}
          isRealDirectory={false}
          onToggleDirectoryDropdown={forceState =>
            setShowDirectoryDropdown(forceState !== undefined ? forceState : !showDirectoryDropdown)
          }
          onSelectWorkspaceDirectory={async d => {
            await window.electronAPI!.setCurrentWorkspaceDirectory(d.path)
            setCurrentWorkspaceDirectory(d)
            setShowDirectoryDropdown(false)
          }}
          onAddWorkspaceDirectory={async type => {
            const res = await window.electronAPI!.utils.showOpenDialog({
              properties: ['openDirectory']
            })
            if (!res.canceled && res.filePaths.length > 0) {
              const p = res.filePaths[0]
              const n = p.split(/[\\/]/).pop() || p
              const newDir: WorkspaceDirectory = {
                path: p,
                name: n,
                type,
                recursive: true,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date()
              }
              try {
                await window.electronAPI!.addWorkspaceDirectory(newDir)
                await loadWorkspaceDirectories()
                const { isPathEqual } = window.electronAPI!.utils
                const allDirs = await window.electronAPI!.getAllWorkspaceDirectories()
                const official = allDirs.find(d => isPathEqual(d.path, p))
                const target = official || newDir
                await window.electronAPI!.setCurrentWorkspaceDirectory(target.path)
                setCurrentWorkspaceDirectory(target)
                navigate('/real-directory')
              } catch (e: any) {
                toast.error(e?.message || t('添加工作目录失败'))
              }
            }
          }}
          dropdownRef={dropdownRef}
          onSearch={kw => {
            if (selectedTags.length > 0) clearSelectedTags()
            setAnalyzedDirectoryKeyword(kw)
          }}
        />
      </div>

      {currentWorkspaceDirectory ? (
        <div className="flex flex-1 flex-col overflow-hidden relative">
          <QuotaWarningBar
            currentWorkspaceDirectory={currentWorkspaceDirectory}
            machineId={machineId}
            setMachineId={setMachineId}
            setShowInvitationModal={setShowInvitationModal}
          />
          {/* 整理模式提示条 */}
          {isOrganizeMode && (
            <div className="bg-primary/10 border-b border-primary/30 px-4 py-2 flex items-center">
              <span className="text-sm text-primary font-medium">
                {t(
                  '当前为整理模式，请勾选或框选文件加入待整理文件列表（点选文件支持 Ctrl 和 Shift ）'
                )}
              </span>
              <button
                onClick={() => setIsOrganizeMode(false)}
                className="text-sm text-primary hover:text-primary/80 underline font-medium"
              >
                {t('退出整理模式')}
              </button>
            </div>
          )}
          <SplitPane
            direction="horizontal"
            storageKey="analyzed-directory"
            sections={[
              {
                id: 'dimension-tree',
                type: 'pixel' as const,
                defaultSize: 230,
                minSize: 100,
                content: (
                  <aside
                    className={
                      'flex-shrink-0 border-r border-border flex flex-col h-full relative overflow-hidden'
                    }
                  >
                    {/* 侧边栏头部 - 始终固定显示 */}
                    <div className="px-3 border-b border-border/80 flex items-center justify-between flex-shrink-0 h-[44px]">
                      <span className="font-semibold text-sm text-foreground flex items-center gap-1.5">
                        <MaterialIcon icon="category" className="text-primary text-sm" />
                        {t('分类维度')}
                      </span>

                      {/* 多选开关 - 独立控制维度标签的多选行为 */}
                      <div className="flex items-center space-x-2">
                        <span className="text-[11px] text-muted-foreground">{t('多选')}</span>
                        <button
                          role="switch"
                          aria-checked={isMultiSelectMode}
                          onClick={() => setIsMultiSelectMode(!isMultiSelectMode)}
                          className={cn(
                            'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
                            isMultiSelectMode ? 'bg-primary' : 'bg-muted-foreground/30'
                          )}
                          disabled={(analyzedFilesCount || 0) === 0 && !isMultiSelectMode}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out',
                              isMultiSelectMode ? 'translate-x-4' : 'translate-x-0'
                            )}
                          />
                        </button>
                      </div>
                    </div>
                    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                      {isDimensionLoading && dimensionGroups.length === 0 ? (
                        <div className="text-center py-8">
                          <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-primary mb-2"></div>
                          <p>{t('加载中...')}</p>
                        </div>
                      ) : dimensionGroups.length === 0 ? (
                        <div className="text-center py-8">{t('暂无数据')}</div>
                      ) : (
                        <DimensionTreeSidebar
                          dimensionGroups={dimensionGroups}
                          showEmptyTags={showEmptyTags}
                          panDimensionIds={panDimensionIds}
                          isExportMode={isMultiSelectMode}
                          showSelectAll={isMultiSelectMode}
                          storageKey="analyzedDir"
                          workspacePath={currentWorkspaceDirectory?.path}
                          onSelectionChange={handleSelectionChange}
                          onModeChange={handleModeChange}
                          onTagClick={handleTagClick}
                          initialUnionMode={unionMode}
                        />
                      )}
                    </div>
                  </aside>
                )
              },
              {
                id: 'file-list',
                type: 'flex' as const,
                defaultSize: isSplitView ? 2 : 1,
                minSize: 200,
                content: (
                  <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                    {analyzedFilesCount === 0 ? (
                      <div className="flex-1 flex flex-col justify-center items-center">
                        <EmptyState
                          title={t('暂无已分析文件')}
                          description={t('当前工作目录还没有AI分析过的文件。')}
                        >
                          {/* 步骤提示卡片 */}
                          <div className="w-full max-w-lg mt-7 mb-7 space-y-2 text-left">
                            <div className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/40 dark:bg-muted/20 border border-border/40 dark:border-border/30">
                              <div className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/15 dark:bg-primary/20 flex items-center justify-center mt-0.5">
                                <span className="text-[9px] font-black text-primary">1</span>
                              </div>
                              <p className="text-xs text-muted-foreground leading-snug">
                                {t('切换到真实目录，找到要分析的文件')}
                              </p>
                            </div>
                            <div className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/40 dark:bg-muted/20 border border-border/40 dark:border-border/30">
                              <div className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/15 dark:bg-primary/20 flex items-center justify-center mt-0.5">
                                <span className="text-[9px] font-black text-primary">2</span>
                              </div>
                              <p className="text-xs text-muted-foreground leading-snug">
                                {t('选择文件或目录并点击"立即分析"，将文件加入AI analysis队列')}
                              </p>
                            </div>
                          </div>

                          {/* 行动按钮 */}
                          <Button
                            variant="default"
                            onClick={() => navigate('/real-directory')}
                            className="group shadow-sm hover:shadow-md hover:shadow-primary/20 transition-all duration-300 cursor-pointer flex items-center gap-1.5 px-5"
                          >
                            <MaterialIcon icon="folder_open" className="text-sm" />
                            <span>{t('前往真实目录')}</span>
                            <MaterialIcon
                              icon="arrow_forward"
                              className="text-sm transition-transform group-hover:translate-x-0.5"
                            />
                          </Button>
                        </EmptyState>
                      </div>
                    ) : (
                      <DimensionFileListPanel
                        workspaceDirectoryPath={currentWorkspaceDirectory?.path}
                        selectedTags={selectedTags}
                        isMultiSelectMode={isMultiSelectMode || isOrganizeMode}
                        removeSelectedTag={removeSelectedTag}
                        toggleTagSelection={handleToggleTagFromPanel}
                        clearSelectedTags={clearSelectedTags}
                        activeItem={selectedItem}
                        setActiveItem={setSelectedItem}
                        selectedFiles={selectedFiles}
                        setSelectedFiles={setSelectedFiles}
                        showOrganizeButton={!isOrganizeMode}
                        onStartOrganize={() => setIsOrganizeMode(true)}
                        isOrganizeMode={isOrganizeMode}
                        onBatchRename={() => {
                          if (selectedFiles.length === 0) {
                            toast.warning(t('至少勾选一个文件'))
                            return
                          }
                          const stateParams = {
                            selectedFileIds: selectedFiles.map(f => f.id),
                            initialStage: 'batch-rename'
                          }
                          navigate('/organize', { state: stateParams })
                        }}
                        onBatchTag={() => {
                          if (selectedFiles.length === 0) {
                            toast.warning(t('至少勾选一个文件'))
                            return
                          }
                          const stateParams = {
                            selectedFileIds: selectedFiles.map(f => f.id),
                            initialStage: 'batch-tag'
                          }
                          navigate('/organize', { state: stateParams })
                        }}
                        onOrganizeSelected={() => {
                          if (selectedFiles.length === 0) {
                            toast.warning(t('至少勾选一个文件'))
                            return
                          }
                          const stateParams = {
                            selectedFileIds: selectedFiles.map(f => f.id),
                            initialStage: 'root-mode-select'
                          }
                          navigate('/organize', { state: stateParams })
                        }}
                        refreshKey={refreshKey}
                        currentPath={currentPath}
                        unionMode={unionMode}
                        showDetailsPanel={showDetailsPanel}
                        showPreviewPanel={isSplitView}
                        onCloseDetailsPanel={() => setShowDetailsPanel(false)}
                        onFileDeleted={() => {
                          loadFilteredFiles()
                          loadDimensionGroups()
                        }}
                        onFileUpdated={() => {
                          loadFilteredFiles()
                          loadDimensionGroups()
                        }}
                        workspaceDirectoryType={currentWorkspaceDirectory?.type as any}
                      />
                    )}
                  </div>
                )
              }
            ]}
          />
          {!isWorkspaceActive && (
            <RestrictedFeatureOverlay
              type={(currentWorkspaceDirectory.type || 'SPEEDY') as 'SPEEDY' | 'PRIVATE'}
              targetName={currentWorkspaceDirectory.name}
              targetId={currentWorkspaceDirectory.id!}
              onSuccess={() => {
                fetchProfile()
                window.dispatchEvent(new CustomEvent('workspace-directories-updated'))
              }}
            />
          )}
        </div>
      ) : (
        <NoWorkspaceDirectoryMessage
          onAddWorkspaceDirectory={async type => {
            const res = await window.electronAPI!.utils.showOpenDialog({
              properties: ['openDirectory']
            })
            if (!res.canceled && res.filePaths.length > 0) {
              const p = res.filePaths[0]
              const n = p.split(/[\\/]/).pop() || p
              try {
                await window.electronAPI!.addWorkspaceDirectory({
                  path: p,
                  name: n,
                  type,
                  recursive: true,
                  isActive: true,
                  createdAt: new Date(),
                  updatedAt: new Date()
                })
                loadWorkspaceDirectories()
              } catch (e: any) {
                toast.error(e?.message || t('添加工作目录失败'))
              }
            }
          }}
        />
      )}

      <DirectoryManagementModals
        showManageModal={showManageModal}
        setShowManageModal={setShowManageModal}
        savedDirectories={savedDirectories}
        editingAnalyzedDirectoryId={editingAnalyzedDirectoryId}
        editingDirectoryName={editingDirectoryName}
        setEditingDirectoryName={setEditingDirectoryName}
        handleSaveEdit={async id => {
          if (!editingDirectoryName.trim()) return
          await window.electronAPI!.analyzedDirectory.renameDirectory(id, editingDirectoryName)
          const s = await window.electronAPI!.analyzedDirectory.getSavedDirectories(
            currentWorkspaceDirectory?.path
          )
          setSavedDirectories(s)
          setEditingAnalyzedDirectoryId(null)
          setEditingDirectoryName('')
        }}
        handleCancelEdit={() => {
          setEditingAnalyzedDirectoryId(null)
          setEditingDirectoryName('')
        }}
        handleStartEdit={dir => {
          setEditingAnalyzedDirectoryId(dir.id)
          setEditingDirectoryName(dir.name)
        }}
        handleDeleteDirectory={async id => {
          await window.electronAPI!.analyzedDirectory.deleteDirectory(
            id,
            currentWorkspaceDirectory?.path
          )
          const s = await window.electronAPI!.analyzedDirectory.getSavedDirectories(
            currentWorkspaceDirectory?.path
          )
          setSavedDirectories(s)
        }}
      />

      <OrganizeModals
        currentWorkspaceDirectory={currentWorkspaceDirectory}
        showConfirmOrganizeDialog={showConfirmOrganizeDialog}
        setShowConfirmOrganizeDialog={setShowConfirmOrganizeDialog}
        organizePreview={organizePreview}
        aiGeneratedStructure={aiGeneratedStructure}
        fileMapForOrganize={fileMapForOrganize}
        handleConfirmOrganize={handleConfirmOrganize}
        handleQuickOrganize={handleQuickOrganize}
        handleConfirmOrganizeAnalyzedDirectory={handleConfirmOrganizeAnalyzedDirectory}
        showOrganizeProgressDialog={showOrganizeProgressDialog}
        organizeProgress={organizeProgress}
        showOrganizeErrorDialog={showOrganizeErrorDialog}
        setShowOrganizeErrorDialog={setShowOrganizeErrorDialog}
        organizeResult={organizeResult}
        showResultDialog={showResultDialog}
        setShowResultDialog={setShowResultDialog}
        showAIProgressDialog={showAIProgressDialog}
        setShowAIProgressDialog={setShowAIProgressDialog}
        aiBatchProgress={aiBatchProgress}
        handleCancelAIOrganize={handleCancelAIOrganize}
        showConflictDialog={showConflictDialog}
        conflicts={conflicts}
        handleConflictResolve={handleConflictResolve}
        handleConflictCancel={handleConflictCancel}
        onPauseToggle={onPauseToggle}
        onEnd={onEnd}
        isPaused={isPaused}
        onDeleteNode={handleDeleteNode}
        handleExportLog={async () => {
          if (!organizeResult || !currentWorkspaceDirectory) return
          const res = await window.electronAPI!.utils.showSaveDialog({
            title: t('导出错误日志'),
            defaultPath: 'errors.json'
          })
          if (!res.canceled && res.filePath)
            await window.electronAPI!.utils.writeFile(
              res.filePath,
              JSON.stringify(organizeResult.errors)
            )
        }}
      />

      <UtilityModals
        currentWorkspaceDirectory={currentWorkspaceDirectory}
        selectedTags={selectedTags}
        dimensionGroups={dimensionGroups}
        selectionStack={selectionStack}
        showEmptyFolderCleanupDialog={showEmptyFolderCleanupDialog}
        setShowEmptyFolderCleanupDialog={setShowEmptyFolderCleanupDialog}
        emptyFolderScanPath={emptyFolderScanPath}
        setEmptyFolderScanPath={setEmptyFolderScanPath}
        showInvitationModal={showInvitationModal}
        setShowInvitationModal={setShowInvitationModal}
        quota={quota}
        refreshCount={refreshCount}
        isInvitationLoading={isInvitationLoading}
        showGenerateAnalyzedDirDialog={showGenerateAnalyzedDirDialog}
        setShowGenerateAnalyzedDirDialog={setShowGenerateAnalyzedDirDialog}
        handleConfirmGenerateAnalyzedDirectories={handleConfirmGenerateAnalyzedDirectories}
      />

      <Dialog open={showThresholdDialog} onOpenChange={setShowThresholdDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('文件数量较多')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t(
              '当前已分析文件较多（共 {count} 个），整理耗时可能较长，是否开启选择模式手动挑选文件进行整理？',
              { count: filteredFiles.length }
            )}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowThresholdDialog(false)
                navigate('/organize')
              }}
            >
              {t('否，直接整理全部')}
            </Button>
            <Button
              onClick={() => {
                setShowThresholdDialog(false)
                setIsOrganizeMode(true)
              }}
            >
              {t('是，开启选择模式')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default AnalyzedDirectory
