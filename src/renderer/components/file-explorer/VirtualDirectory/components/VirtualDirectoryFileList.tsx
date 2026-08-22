import React from 'react'
import { t } from '@app/languages'
import { Button } from '../../../../components/ui/button'
import { MaterialIcon } from '../../../../lib/utils'
import { FileExplorerLayout } from '../../FileExplorerLayout'
import { Breadcrumbs } from '../../Breadcrumbs'
import { SearchBar } from '../../../common/SearchBar'
import { PersistentTooltip } from '../../../common/PersistentTooltip'
import { CardSizePopover } from '../../../common/CardSizePopover'
import { MiniViewDisplaySettingsPopover } from '../../../common/MiniViewDisplaySettingsPopover'
import { PAGE_IDS } from '../../../../constants/page-ids'
import { useNavigate } from 'react-router-dom'

interface VirtualDirectoryFileListProps {
  fileListFiles: any[]
  fileListDirectories: any[]
  selectedFileListFiles: any[]
  activeItem: any | null
  handleFileListFileSelect: (newSelection: any[], isFromCheckbox?: boolean) => void
  handleFileListDirectoryChange: (path: string) => void
  viewMode: 'list' | 'grid' | 'waterfall'
  setViewMode: (mode: 'list' | 'grid' | 'waterfall') => void
  currentWorkspaceDirectory: any
  isSplitView: boolean
  loadTree: () => void
  handleBack: () => void
  handleForward: () => void
  handleUp: () => void
  currentHistoryIndex: number
  navigationHistory: any[]
  virtualCurrentPath: string
  virtualBasePath: string
  handleVirtualNavigate: (path: string) => void
  setVirtualDirectoryKeyword: (keyword: string) => void
  showExportTooltip: boolean
  setShowExportTooltip: (show: boolean) => void
  totalFiles: number
  filteredFilesByTags: any[]
  vdirSidebarTab: 'directory' | 'dimensions'
  selectedNode: any
  rootNode: any
  currentVD: any
}

export const VirtualDirectoryFileList: React.FC<VirtualDirectoryFileListProps> = React.memo(
  ({
    fileListFiles,
    fileListDirectories,
    selectedFileListFiles,
    activeItem,
    handleFileListFileSelect,
    handleFileListDirectoryChange,
    viewMode,
    setViewMode,
    currentWorkspaceDirectory,
    isSplitView,
    loadTree,
    handleBack,
    handleForward,
    handleUp,
    currentHistoryIndex,
    navigationHistory,
    virtualCurrentPath,
    virtualBasePath,
    handleVirtualNavigate,
    setVirtualDirectoryKeyword,
    showExportTooltip,
    setShowExportTooltip,
    totalFiles,
    filteredFilesByTags,
    vdirSidebarTab,
    selectedNode,
    rootNode,
    currentVD
  }) => {
    const navigate = useNavigate()

    return (
      <FileExplorerLayout
        files={fileListFiles}
        directories={fileListDirectories}
        selectedFileIds={selectedFileListFiles.map(f =>
          typeof f === 'string' ? f : f?.path || f?.id
        )}
        activeItem={activeItem}
        onFileSelect={handleFileListFileSelect}
        onDirectoryChange={handleFileListDirectoryChange}
        viewMode={viewMode}
        onViewModeChange={mode => setViewMode(mode as any)}
        currentPath={selectedNode ? selectedNode.name : currentVD?.name || ''}
        isRealDirectory={false}
        selectionEnabled={false}
        showsmartName={true}
        showAnalysisStatus={false}
        workspaceDirectoryPath={currentWorkspaceDirectory?.path}
        workspaceDirectoryType={currentWorkspaceDirectory?.type as any}
        pageId={PAGE_IDS.VIRTUAL_DIRECTORY}
        showDetailsPanel={!!currentWorkspaceDirectory}
        showPreviewPanel={isSplitView}
        onFileDeleted={loadTree}
        onFileUpdated={loadTree}
        renderToolbar={layoutContext => (
          <div className="flex-shrink-0 border-b border-border px-3 py-1.5 flex flex-wrap items-center justify-between bg-card gap-y-2 gap-x-4">
            <div className="flex items-center space-x-2 flex-1 min-w-[200px]">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent"
                onClick={handleBack}
                disabled={currentHistoryIndex <= 0}
                title={t('后退 (Alt+Left / Backspace)')}
              >
                <MaterialIcon icon="arrow_back" className="text-xl" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent"
                onClick={handleForward}
                disabled={currentHistoryIndex >= navigationHistory.length - 1}
                title={t('前进 (Alt+Right)')}
              >
                <MaterialIcon icon="arrow_forward" className="text-xl" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent"
                onClick={handleUp}
                disabled={
                  virtualCurrentPath
                    .split(window.electronAPI!.utils.getPlatform?.() === 'win32' ? '\\' : '/')
                    .filter(Boolean).length <= 1
                }
                title={t('向上 (Alt+Up)')}
              >
                <MaterialIcon icon="arrow_upward" className="text-xl" />
              </Button>
              <div className="flex items-center text-sm font-medium text-foreground dark:text-foreground ml-3 min-w-0 overflow-x-auto custom-scrollbar-hide">
                <Breadcrumbs
                  currentPath={virtualCurrentPath}
                  basePath={virtualBasePath}
                  onNavigate={handleVirtualNavigate}
                />
              </div>
            </div>

            <div className="flex items-center space-x-2 text-foreground dark:text-foreground ml-auto">
              <div className="flex-shrink-0 relative z-10 h-8 flex items-center mr-1">
                <SearchBar
                  type="virtual-directory"
                  placeholder={t('搜索...')}
                  onSearch={keyword => {
                    setVirtualDirectoryKeyword(keyword)
                  }}
                  className="w-30 focus-within:w-80 transition-all duration-300"
                />
              </div>
              {/* 视图模式与显示设置 Mini 下拉弹窗 */}
              <MiniViewDisplaySettingsPopover
                viewMode={layoutContext.viewMode}
                onViewModeChange={layoutContext.setViewMode}
                gridCardWidth={layoutContext.gridCardWidth}
                onGridCardWidthChange={layoutContext.setGridCardWidth}
              />
              <PersistentTooltip
                id="header_export_satisfaction_hint"
                content={t('对虚拟目录满意，可以选择导出')}
                visible={showExportTooltip}
                onClose={() => {
                  localStorage.setItem('tooltip_dismissed_header_export_satisfaction_hint', 'true')
                  setShowExportTooltip(false)
                }}
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-lg border-primary/40 hover:bg-primary/10 text-primary flex items-center gap-1.5 font-bold cursor-pointer shrink-0"
                  onClick={() => {
                    localStorage.setItem(
                      'tooltip_dismissed_header_export_satisfaction_hint',
                      'true'
                    )
                    setShowExportTooltip(false)
                    navigate('/virtual-directory/export')
                  }}
                >
                  <MaterialIcon icon="share" className="text-sm text-primary" />
                  {t('导出整理')}
                </Button>
              </PersistentTooltip>
            </div>
          </div>
        )}
        renderFooter={() => (
          <div className="px-3 py-1.5 flex items-center text-xs text-muted-foreground">
            <MaterialIcon icon="insert_drive_file" className="mr-1.5 text-sm" />
            {t('{count} 个文件', {
              count:
                (vdirSidebarTab as string) === 'dimensions'
                  ? filteredFilesByTags.length
                  : selectedNode
                    ? selectedNode.files.length
                    : (rootNode?.rootFiles?.length || 0) + totalFiles
            })}
          </div>
        )}
      />
    )
  }
)

VirtualDirectoryFileList.displayName = 'VirtualDirectoryFileList'
