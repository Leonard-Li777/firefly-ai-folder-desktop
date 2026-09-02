import React, { useRef } from 'react'
import { getFileNameFromPath } from '@firefly/shared'
import { useVirtualDirectory } from './hooks/useVirtualDirectory'
import { DimensionTreeSidebar } from './components/DimensionTreeSidebar'
import { DirectoryHeader } from '../DirectoryHeader'
import { SplitPane } from '../../common/SplitPane'
import { EmptyState } from '../../common/EmptyState'
import { Button } from '../../ui/button'
import { MaterialIcon } from '../../../lib/utils'
import { VirtualDirectoryTabs } from './components/VirtualDirectoryTabs'
import { ExportPreviewPanel } from './components/ExportPreviewPanel'
import {
  DirectoryManagementModals,
  DirectoryManagementModalsRef
} from './components/DirectoryManagementModals'
import { OrganizeModals, OrganizeModalsRef } from './components/OrganizeModals'
import { ExportSelector } from './components/ExportSelector'
import { VirtualDirectoryFileList } from './components/VirtualDirectoryFileList'
import { DimensionFileListPanel } from '../DimensionFileListPanel'
import { RestrictedFeatureOverlay } from '../../common/RestrictedFeatureOverlay'
import { PAGE_IDS } from '../../../constants/page-ids'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../../common/Toast'
import { useTierStore } from '../../../stores/tier-store'
import { WorkspaceDirectory } from '@firefly/types'

export const VirtualDirectory: React.FC = () => {
  useVoerkaI18n(i18nScope)

  const {
    virtualDirectories,
    selectedId,
    setSelectedId,
    activeItem,
    setActiveItem,
    selectedFileListFiles,
    setSelectedFileListFiles,
    lastSelectedFileRef,
    viewMode,
    setViewMode,
    vdirSidebarTab,
    setVdirSidebarTab,
    dimensionGroups,
    selectedTags,
    setSelectedTags,
    isDimensionLoading,
    filteredFilesByTags,
    vdirMultiSelectMode,
    setVdirMultiSelectMode,
    unionMode,
    expandedKeys,
    setExpandedKeys,
    handleSelectionChange,
    handleModeChange,
    handleTagClick,
    navigate,
    location,
    isExportMode,
    currentWorkspaceDirectory,
    setCurrentWorkspaceDirectory,
    virtualDirectoryKeyword,
    setVirtualDirectoryKeyword,
    setAnalyzedDirectoryKeyword,
    computed_limits,
    entitlements,
    config,
    vdirSlotLimit,
    treeData,
    selectedNode,
    setSelectedNode,
    rootNode,
    sidebarCollapsed,
    setSidebarCollapsed,
    workspaceDirectories,
    showDirectoryDropdown,
    setShowDirectoryDropdown,
    dropdownRef,
    loadWorkspaceDirectories,
    loadVDirs,
    loadTree,
    handleRename,
    executeDelete,
    handleRegenerate,
    currentVD,
    isVdirActive,
    totalFiles,
    fileListFiles,
    exportPreviewOptions,
    updateOption,
    previewTree,
    totalFileCount,
    isTooManyTags,
    showExportTooltip,
    setShowExportTooltip,
    handleVirtualNavigate,
    virtualCurrentPath,
    currentHistoryIndex,
    handleBack,
    handleForward,
    handleUp,
    navigationHistory,
    fileListDirectories,
    handleFileListFileSelect,
    handleFileListDirectoryChange,
    isSplitView,
    currentWorkspaceDirectoryPath,
    virtualBasePath
  } = useVirtualDirectory()

  const dirModalsRef = useRef<DirectoryManagementModalsRef>(null)
  const organizeModalsRef = useRef<OrganizeModalsRef>(null)

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="">
        <DirectoryHeader
          currentWorkspaceDirectory={currentWorkspaceDirectory}
          workspaceDirectories={workspaceDirectories}
          showDirectoryDropdown={showDirectoryDropdown}
          isRealDirectory={false}
          exportTooltipVisible={showExportTooltip}
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
              const n = getFileNameFromPath(p) || p
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
            setVirtualDirectoryKeyword(kw)
          }}
        />
      </div>

      <DirectoryManagementModals
        ref={dirModalsRef}
        virtualDirectories={virtualDirectories}
        handleRename={handleRename}
        executeDelete={executeDelete}
      />

      {virtualDirectories.length === 0 && !isExportMode ? (
        <EmptyState
          icon="folder_off"
          title={t('暂无已保存的虚拟目录')}
          description={t('请前往已分析页面勾选文件后点击立即整理')}
        >
          <Button
            variant="outline"
            className="rounded-xl mt-2 font-bold shadow-xs"
            onClick={() => {
              navigate('/analyzed-directory', { state: { startInOrganizeMode: true } })
            }}
          >
            <MaterialIcon icon="add" className="mr-2 text-sm" />
            {t('创建虚拟目录')}
          </Button>
        </EmptyState>
      ) : (
        <SplitPane
          direction="horizontal"
          storageKey="virtual-directory"
          className="flex-1"
          sections={[
            {
              id: 'vdir-list',
              type: 'pixel' as const,
              defaultSize: 200,
              minSize: 100,
              collapsed: sidebarCollapsed,
              collapsedSize: 50,
              content: (
                <VirtualDirectoryTabs
                  virtualDirectories={virtualDirectories}
                  selectedId={selectedId}
                  setSelectedId={setSelectedId}
                  sidebarCollapsed={sidebarCollapsed}
                  setSidebarCollapsed={setSidebarCollapsed}
                  entitlements={entitlements}
                  vdirSlotLimit={vdirSlotLimit}
                  computed_limits={computed_limits}
                  setRenamingId={id => id && dirModalsRef.current?.rename(id)}
                  handleRegenerate={handleRegenerate}
                  handleDelete={id => dirModalsRef.current?.confirmDelete(id)}
                />
              )
            },

            {
              id: 'tree',
              type: 'pixel' as const,
              defaultSize: 288,
              minSize: 180,
              content: (
                <DimensionTreeSidebar
                  virtualDirectories={virtualDirectories}
                  selectedId={selectedId}
                  setSelectedId={setSelectedId}
                  currentVD={currentVD}
                  isExportMode={isExportMode}
                  currentWorkspaceDirectory={currentWorkspaceDirectory}
                  dimensionGroups={dimensionGroups}
                  isDimensionLoading={isDimensionLoading}
                  unionMode={unionMode}
                  onSelectionChange={handleSelectionChange}
                  onModeChange={handleModeChange}
                  onTagClick={handleTagClick}
                  selectedTags={selectedTags}
                  treeData={treeData}
                  rootNode={rootNode}
                  selectedNode={selectedNode}
                  setSelectedNode={setSelectedNode}
                  activeItem={activeItem}
                  setActiveItem={setActiveItem}
                  setSelectedFileListFiles={setSelectedFileListFiles}
                  fileListFiles={fileListFiles}
                  sidebarCollapsed={sidebarCollapsed}
                  setSidebarCollapsed={setSidebarCollapsed}
                  entitlements={entitlements}
                  vdirSlotLimit={vdirSlotLimit}
                  computed_limits={computed_limits}
                  setRenamingId={id => id && dirModalsRef.current?.rename(id)}
                  handleRegenerate={handleRegenerate}
                  handleDelete={id => dirModalsRef.current?.confirmDelete(id)}
                  config={config}
                  vdirMultiSelectMode={vdirMultiSelectMode}
                  setVdirMultiSelectMode={setVdirMultiSelectMode}
                  vdirSidebarTab={vdirSidebarTab}
                  setVdirSidebarTab={setVdirSidebarTab}
                  expandedKeys={expandedKeys}
                  setExpandedKeys={setExpandedKeys}
                />
              )
            },

            ...(isExportMode && vdirSidebarTab === 'dimensions'
              ? [
                  {
                    id: 'export-preview',
                    type: 'pixel' as const,
                    defaultSize: 250,
                    minSize: 150,
                    content: (
                      <ExportPreviewPanel
                        options={exportPreviewOptions}
                        updateOption={updateOption}
                        previewTree={previewTree}
                        totalFileCount={totalFileCount}
                        isTooManyTags={isTooManyTags}
                        hasSelectedTags={selectedTags.length > 0}
                      />
                    )
                  }
                ]
              : []),

            {
              id: 'file-list',
              type: 'flex' as const,
              defaultSize: 1,
              minSize: 300,
              content: (
                <div className="flex-1 h-full relative overflow-hidden flex bg-background">
                  {isExportMode ? (
                    <ExportSelector
                      currentWorkspaceDirectoryPath={currentWorkspaceDirectoryPath}
                      isVdirActive={isVdirActive}
                      computed_limits={computed_limits}
                      handleExportVdir={() => organizeModalsRef.current?.triggerExportVdir()}
                      handleExportReal={() => organizeModalsRef.current?.triggerExportReal()}
                    />
                  ) : (
                    <SplitPane
                      direction="horizontal"
                      storageKey="virtual-directory-inner"
                      className="flex-1"
                      sections={[
                        {
                          id: 'inner-file-list',
                          type: 'flex' as const,
                          defaultSize: 1,
                          minSize: 300,
                          content:
                            vdirSidebarTab === 'dimensions' ? (
                              <DimensionFileListPanel
                                workspaceDirectoryPath={currentWorkspaceDirectory?.path}
                                virtualDirectoryId={selectedId || undefined}
                                selectedTags={selectedTags}
                                isMultiSelectMode={vdirMultiSelectMode}
                                removeSelectedTag={(dimId, tagValue, parentTagValue) => {
                                  if (tagValue) {
                                    setSelectedTags(prev =>
                                      prev.filter(
                                        t =>
                                          !(
                                            t.dimensionId === dimId &&
                                            t.tagValue === tagValue &&
                                            t.parentTagValue === parentTagValue
                                          )
                                      )
                                    )
                                  } else {
                                    setSelectedTags(prev => prev.filter(t => t.dimensionId !== dimId))
                                  }
                                }}
                                toggleTagSelection={(dimId, val, parentVal) => {
                                  setSelectedTags(prev => {
                                    const exists = prev.some(
                                      t =>
                                        t.dimensionId === dimId &&
                                        t.tagValue === val &&
                                        t.parentTagValue === parentVal
                                    )
                                    if (exists) {
                                      return prev.filter(
                                        t =>
                                          !(
                                            t.dimensionId === dimId &&
                                            t.tagValue === val &&
                                            t.parentTagValue === parentVal
                                          )
                                      )
                                    } else {
                                      const group = dimensionGroups.find(g => g.id === dimId)
                                      const tagDef = group?.tags.find(t => t.tagValue === val)
                                      return [
                                        ...prev,
                                        {
                                          dimensionId: dimId,
                                          dimensionName: group?.name || '',
                                          tagValue: val,
                                          level: tagDef?.level ?? 0,
                                          ...(parentVal ? { parentTagValue: parentVal } : {})
                                        }
                                      ]
                                    }
                                  })
                                }}
                                clearSelectedTags={() => {
                                  setSelectedTags([])
                                }}
                                activeItem={activeItem}
                                setActiveItem={setActiveItem}
                                selectedFiles={selectedFileListFiles}
                                setSelectedFiles={setSelectedFileListFiles}
                                unionMode={unionMode}
                                showDetailsPanel={!!currentWorkspaceDirectory}
                                showPreviewPanel={isSplitView}
                                pageId={PAGE_IDS.VIRTUAL_DIRECTORY}
                                currentPath={location.pathname}
                              />
                            ) : (
                              <VirtualDirectoryFileList
                                fileListFiles={fileListFiles}
                                fileListDirectories={fileListDirectories}
                                selectedFileListFiles={selectedFileListFiles}
                                activeItem={activeItem}
                                handleFileListFileSelect={handleFileListFileSelect}
                                handleFileListDirectoryChange={handleFileListDirectoryChange}
                                viewMode={viewMode}
                                setViewMode={setViewMode}
                                currentWorkspaceDirectory={currentWorkspaceDirectory}
                                isSplitView={isSplitView}
                                loadTree={loadTree}
                                handleBack={handleBack}
                                handleForward={handleForward}
                                handleUp={handleUp}
                                currentHistoryIndex={currentHistoryIndex}
                                navigationHistory={navigationHistory}
                                virtualCurrentPath={virtualCurrentPath}
                                virtualBasePath={virtualBasePath}
                                handleVirtualNavigate={handleVirtualNavigate}
                                setVirtualDirectoryKeyword={setVirtualDirectoryKeyword}
                                showExportTooltip={showExportTooltip}
                                setShowExportTooltip={setShowExportTooltip}
                                totalFiles={totalFiles}
                                filteredFilesByTags={filteredFilesByTags}
                                vdirSidebarTab={vdirSidebarTab}
                                selectedNode={selectedNode}
                                rootNode={rootNode}
                                currentVD={currentVD}
                              />
                            )
                        }
                      ]}
                    />
                  )}
                  {!isVdirActive && selectedId && !isExportMode && (
                    <RestrictedFeatureOverlay
                      type="VDIR"
                      targetName={currentVD?.name || ''}
                      targetId={selectedId}
                      workspaceId={currentWorkspaceDirectory?.id}
                      onSuccess={() => {
                        useTierStore.getState().fetchProfile()
                        window.dispatchEvent(new CustomEvent('workspace-directories-updated'))
                        loadVDirs()
                      }}
                    />
                  )}
                </div>
              )
            }
          ]}
        />
      )}

      <OrganizeModals
        ref={organizeModalsRef}
        selectedId={selectedId}
        isVdirActive={isVdirActive}
        currentWorkspaceDirectory={currentWorkspaceDirectory}
        currentVD={currentVD}
        loadVDirs={loadVDirs}
        loadTree={loadTree}
        computed_limits={computed_limits}
        vdirSidebarTab={vdirSidebarTab}
        selectedTags={selectedTags}
        previewTree={previewTree}
        exportPreviewOptions={exportPreviewOptions}
      />
    </div>
  )
}

export default VirtualDirectory
export {
  DimensionTreeSidebar,
  DirectoryManagementModals,
  OrganizeModals,
  ExportSelector,
  VirtualDirectoryFileList
}
