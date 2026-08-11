import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { MaterialIcon, cn } from '../../../lib/utils'
import React, { useRef, useMemo } from 'react'
import { WorkspaceDirectory } from '@firefly/types'
import { useNavigate } from 'react-router-dom'

import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { DirectoryHeader } from '../DirectoryHeader'
import { EditStrategyDialog } from './components/EditStrategyDialog'
import { EmptyState } from '../../common/EmptyState'
import { FileList } from '../FileList'
import { FileExplorerLayout } from '../FileExplorerLayout'
import { OrganizeCustomFormDialog } from './components/OrganizeCustomFormDialog'
import { PersistentTooltip } from '../../common/PersistentTooltip'
import { CardSizePopover } from '../../common/CardSizePopover'
import { MiniViewDisplaySettingsPopover } from '../../common/MiniViewDisplaySettingsPopover'
import { t } from '@app/languages'
import { toast } from '../../common/Toast'
import { useAnalyzedDirectoryStore } from '../../../stores/analyzed-directory-store'
import { useSearchStore } from '../../../stores/search-store'
import { PAGE_IDS } from '../../../constants/page-ids'
import { RestrictedFeatureOverlay } from '../../common/RestrictedFeatureOverlay'
import { PaymentFlowDialog } from '../../tier/PaymentFlowDialog'

import { useOrganizeState } from './hooks/useOrganizeState'
import { StageBreadcrumb } from './components/StageBreadcrumb'
import { ModeSelectView } from './components/ModeSelectView'
import { CandidatesView } from './components/CandidatesView'
import { StructureView } from './components/StructureView'
import { OrganizingView } from './components/OrganizingView'
import { DoneView } from './components/DoneView'
import { SplitPane } from '../../common/SplitPane'

export const Organize: React.FC = () => {
  const navigate = useNavigate()
  const { setAnalyzedDirectoryKeyword } = useSearchStore()

  const {
    currentWorkspaceDirectory,
    dimensionGroups,
    workspaceDirectories,
    loadWorkspaceDirectories,
    showDirectoryDropdown,
    setShowDirectoryDropdown,
    isWorkspaceActive,
    viewMode,
    setViewMode,
    stage,
    setStage,
    organizeMode,
    setOrganizeMode,
    incrementalVdId,
    handleSelectIncrementalVd,
    isLimitPredict,
    isLoadingFiles,
    toOrganizeFiles,
    candidates,
    isGeneratingCandidates,
    generateCandidates,
    selectedCandidate,
    setSelectedCandidate,
    showCustomForm,
    setShowCustomForm,
    draft,
    setDraft,
    progressInfo,
    isPaused,
    draftTree,
    finalTree,
    displayTree,
    hasRescueFailed,
    showBackConfirm,

    setShowBackConfirm,
    showGuidanceDialog,
    setShowGuidanceDialog,
    guidancePrompt,
    setGuidancePrompt,
    resetGuidancePrompt,
    showEditStrategy,
    setShowEditStrategy,
    showBatchLimitConfirm,
    setShowBatchLimitConfirm,
    executeStartOrganize,
    handleSelectFilesToOrganize,
    showStartDropdown,
    setShowStartDropdown,
    showSaveDropdown,
    setShowSaveDropdown,
    isRegenerate,
    isRegenerateFree,
    showRegenerateFirecoreConfirm,
    setShowRegenerateFirecoreConfirm,
    isGeneratingTree,
    handleModeSelect,
    handleGuideGeneration,
    handleSelectCandidate,
    handleCustomSubmit,
    handleStartOrganize,
    handlePause,
    handleResume,
    handleEnd,
    handleReorganizeFromOrganizing,
    handleSave,
    handleRegenerateSaveAfterFirecoreConfirm,
    handleReorganize,
    handleBack,
    canForward,
    handleForward,
    handleBackConfirm,
    handleRescue,
    isAutoRescuing,
    isRescuing,
    handleAutoRescue,
    currentVDir,
    virtualDirectories,
    options,
    setOptions,
    initialVDirInfo,
    fetchProfile,
    computed_limits,
    handleDeleteTreeNode,
    deleteConfirmNodeKey,
    deleteConfirmNodeName,
    cancelDeleteTreeNode,
    confirmDeleteTreeNode,
    handleRenameTreeNode,
    handleAddSubdirTreeNode,
    handleMoveNodeOrFile,
    handleSelectDraftVDir,
    handleDeleteDraftVDir,
    canGoBack,
    resetOrganizeState,
    highFrequencyTags
  } = useOrganizeState()

  const dropdownRef = useRef<HTMLDivElement>(null!)
  const startDropdownRef = useRef<HTMLDivElement>(null!)
  const saveDropdownRef = useRef<HTMLDivElement>(null!)

  const isReadOnly = stage === 'organizing' || stage === 'done'
  const isSavedVDirOrganize =
    organizeMode === 'incremental-organize' ||
    (Boolean(currentVDir?.id) &&
      currentVDir?.source !== 'draft' &&
      organizeMode !== 'fast-organize' &&
      organizeMode !== 'fine-organize')

  const hasClassifiedInTree = useMemo(() => {
    const tree = finalTree?.length ? finalTree : draftTree
    if (!Array.isArray(tree) || tree.length === 0) return false
    const checkNode = (nodes: any[]): boolean => {
      for (const node of nodes) {
        const isUnclass =
          node.name === '未归类' || node.name === '未分类' || node.name === 'Unclassified'
        if (
          !isUnclass &&
          ((node.files && node.files.length > 0) || (node.fileCount && node.fileCount > 0))
        ) {
          return true
        }
        if (node.subdirectories && node.subdirectories.length > 0) {
          if (checkNode(node.subdirectories)) return true
        }
      }
      return false
    }
    return checkNode(tree)
  }, [finalTree, draftTree])

  return (
    <>
      <div className="flex flex-col h-full bg-background">
        <DirectoryHeader
          workspaceDirectories={workspaceDirectories}
          currentWorkspaceDirectory={currentWorkspaceDirectory}
          showDirectoryDropdown={showDirectoryDropdown}
          isRealDirectory={false}
          onToggleDirectoryDropdown={forceState =>
            setShowDirectoryDropdown(forceState !== undefined ? forceState : !showDirectoryDropdown)
          }
          onSelectWorkspaceDirectory={async dir => {
            const store = useAnalyzedDirectoryStore.getState()
            await store.setCurrentWorkspaceDirectory(dir)
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
                const store = useAnalyzedDirectoryStore.getState()
                await store.setCurrentWorkspaceDirectory(target)
                navigate('/real-directory')
              } catch (e: any) {
                toast.error(e?.message || t('添加工作目录失败'))
              }
            }
          }}
          dropdownRef={dropdownRef}
          onSearch={kw => {
            setAnalyzedDirectoryKeyword(kw)
          }}
        />

        <div className="flex items-center justify-between px-4 py-2 bg-muted/20 border-b gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={resetOrganizeState}
              className="font-bold text-xs"
            >
              <MaterialIcon icon="add_circle" className="text-sm" />
              {t('新建整理')}
            </Button>
            <div className="flex items-center -space-x-px">
              <Button
                variant="outline"
                size="sm"
                onClick={handleBack}
                disabled={!canGoBack}
                className="rounded-r-none gap-1 text-muted-foreground hover:text-foreground h-8"
              >
                <MaterialIcon icon="arrow_back" className="text-sm" />
                {t('返回')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleForward}
                disabled={!canForward}
                className="rounded-l-none gap-1 text-muted-foreground hover:text-foreground h-8"
              >
                {t('前进')}
                <MaterialIcon icon="arrow_forward" className="text-sm" />
              </Button>
            </div>
            <div className="w-px h-4 bg-border/50" />
            <StageBreadcrumb stage={stage} />
          </div>

          <div className="flex items-center gap-2">
            {stage === 'candidates' && (
              <>
                <PersistentTooltip
                  id="organize_regenerate_hint"
                  content={t('不满意可以重新生成整理方案')}
                  position="bottom"
                  delay={1000}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateCandidates}
                    disabled={isGeneratingCandidates}
                    className="text-xs gap-1 h-8"
                  >
                    <MaterialIcon
                      icon="refresh"
                      className={cn('text-sm', isGeneratingCandidates && 'animate-spin')}
                    />
                    {isGeneratingCandidates ? t('正在生成...') : t('重新生成')}
                  </Button>
                </PersistentTooltip>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowGuidanceDialog(true)}
                  disabled={isGeneratingCandidates}
                  className="text-xs gap-1 h-8"
                  title={t('推荐云端AI才能达到较好效果')}
                >
                  <MaterialIcon icon="tips_and_updates" className="text-sm" />
                  {t('指导方案生成')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCustomForm(true)}
                  disabled={isGeneratingCandidates}
                  className="text-xs gap-1 h-8"
                >
                  <MaterialIcon icon="edit_note" className="text-sm" />
                  {t('自定义目录树（推荐）')}
                </Button>
              </>
            )}
            {stage === 'structure' && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground font-medium px-2.5 py-1 bg-muted/30 rounded-md select-none">
                  {t('本页面自动保存')}
                </span>
                <div className="flex items-center border border-primary/20 bg-primary/5 rounded-xl overflow-hidden">
                  <Button
                    size="sm"
                    onClick={handleStartOrganize}
                    className="rounded-l-lg rounded-r-none text-xs gap-1.5 bg-primary hover:bg-primary/90 px-4 font-bold shadow-md shadow-primary/10 transition-all hover:scale-[1.01] active:scale-[0.98] h-8"
                  >
                    <MaterialIcon icon="play_circle" className="text-sm" />
                    {t('开始整理')}
                  </Button>
                  <label className="flex items-center gap-2 text-xs font-semibold text-primary cursor-pointer select-none px-3 py-1.5 hover:bg-primary/10 transition-colors h-8">
                    <Checkbox
                      id="allow-create-new"
                      checked={options.allowCreateNew}
                      onCheckedChange={checked =>
                        setOptions({ ...options, allowCreateNew: !!checked })
                      }
                      className="border-primary/60 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground w-3.5 h-3.5 rounded-sm"
                    />
                    <span>{t('整理过程中允许AI新增目录')}</span>
                  </label>
                </div>
              </div>
            )}

            {stage === 'organizing' && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={isPaused ? handleResume : handlePause}
                  className={cn(
                    'rounded-xl text-xs gap-1 transition-all',
                    isPaused
                      ? 'border-green-500/30 dark:border-green-500/40 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/20'
                      : ''
                  )}
                >
                  <MaterialIcon icon={isPaused ? 'play_arrow' : 'pause'} className="text-sm" />
                  {isPaused ? t('恢复') : t('暂停')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReorganizeFromOrganizing}
                  className="rounded-xl text-xs gap-1"
                >
                  <MaterialIcon icon="refresh" className="text-sm" />
                  {t('重新整理')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleEnd}
                  className="rounded-xl text-xs gap-1 border-destructive/40 text-destructive hover:bg-destructive/5"
                >
                  <MaterialIcon icon="stop" className="text-sm" />
                  {t('结束')}
                </Button>
              </>
            )}

            {stage === 'done' && (
              <>
                {Boolean(currentVDir?.source === 'draft' || draft?.source === 'draft') ? (
                  <span className="text-xs text-muted-foreground font-medium px-2 py-1 bg-muted/30 rounded-md select-none">
                    {t('本页面自动保存')}
                  </span>
                ) : isSavedVDirOrganize ? (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      const targetId = currentVDir?.id || incrementalVdId
                      if (targetId) {
                        navigate(`/virtual-directory?id=${targetId}`)
                      } else {
                        navigate('/virtual-directory')
                      }
                    }}
                    className="text-xs"
                  >
                    {t('本页面自动保存，你可随时切换虚拟目录页面查看结果')}
                  </Button>
                ) : null}
              </>
            )}

            {stage === 'done' && !isSavedVDirOrganize && (
              <Button
                size="sm"
                onClick={handleSave}
                className="group relative overflow-hidden rounded-xl text-xs gap-1.5 bg-primary hover:bg-primary/95 text-primary-foreground font-bold px-6 py-2 transition-all duration-300 hover:scale-105 active:scale-95"
              >
                {/* 划过光线动画层 */}
                <span className="btn-shimmer-effect" />
                <MaterialIcon icon="save" className="text-sm relative z-10" />
                <span className="relative z-10">
                  {t('保存虚拟目录，支持后续继续整理和增量整理')}
                </span>
              </Button>
            )}
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden relative">
          <SplitPane
            direction="horizontal"
            storageKey="organize-main"
            className="flex-1"
            sections={[
              {
                id: 'file-list',
                type: 'flex' as const,
                defaultSize: 1,
                minSize: 150,
                content: (
                  <FileExplorerLayout
                    files={toOrganizeFiles}
                    selectionEnabled={false}
                    showDetailsPanel={false}
                    showPreviewPanel={false}
                    viewMode={viewMode}
                    showsmartName={true}
                    onViewModeChange={m => setViewMode(m as any)}
                    renderToolbar={ctx => (
                      <div className="p-3 border-b flex flex-col gap-2 bg-muted/10">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="font-bold text-sm text-foreground">
                              {t('待整理文件')}
                            </span>
                            {Boolean(
                              (incrementalVdId || currentVDir?.id || draft?.source === 'draft') &&
                              hasClassifiedInTree
                            ) && (
                              <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1 text-xs font-medium shrink-0">
                                <MaterialIcon icon="filter_alt" className="text-sm" />
                                {t('已过滤前次已整理文件')}
                              </span>
                            )}
                          </span>
                          {/* 视图模式与显示设置 Mini 下拉弹窗 */}
                          <MiniViewDisplaySettingsPopover
                            viewMode={ctx.viewMode}
                            onViewModeChange={ctx.setViewMode}
                            gridCardWidth={ctx.gridCardWidth}
                            onGridCardWidthChange={ctx.setGridCardWidth}
                          />
                        </div>
                      </div>
                    )}
                    renderFooter={() => (
                      <div className="px-3 py-1 flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">{t('待整理文件')}</span>
                        <span className="text-xs font-medium tabular-nums">
                          {t('{count} 个文件', { count: toOrganizeFiles.length })}
                        </span>
                      </div>
                    )}
                  />
                )
              },
              {
                id: 'main-content',
                type: 'flex' as const,
                defaultSize: 2,
                minSize: 200,
                content: (
                  <div className="h-full overflow-hidden flex flex-col">
                    {toOrganizeFiles.length === 0 &&
                    stage === 'mode-select' &&
                    !isSavedVDirOrganize &&
                    !incrementalVdId &&
                    !currentVDir?.id &&
                    displayTree.length === 0 &&
                    virtualDirectories.length === 0 ? (
                      <EmptyState
                        icon="folder_off"
                        title={t('暂无待整理文件')}
                        description={t('请先前往真实目录选择文件进行分析')}
                      >
                        <Button
                          variant="outline"
                          className="rounded-xl mt-2 font-bold shadow-xs"
                          onClick={() => navigate('/real-directory')}
                        >
                          <MaterialIcon icon="folder_open" className="mr-2 text-sm" />
                          {t('返回真实目录')}
                        </Button>
                      </EmptyState>
                    ) : (
                      <>
                        {stage === 'mode-select' && (
                          <ModeSelectView
                            organizeMode={organizeMode}
                            onSelectMode={handleModeSelect}
                            hasVirtualDirectories={virtualDirectories.length > 0}
                            virtualDirectories={virtualDirectories}
                            onSelectIncrementalVd={handleSelectIncrementalVd}
                            onSelectDraftVDir={handleSelectDraftVDir}
                            onDeleteDraftVDir={handleDeleteDraftVDir}
                          />
                        )}

                        {stage === 'candidates' && (
                          <CandidatesView
                            candidates={candidates}
                            isLoading={isGeneratingCandidates}
                            organizeMode={organizeMode}
                            onSelectCandidate={handleSelectCandidate}
                            isLimitPredict={isLimitPredict}
                            onRegenerate={generateCandidates}
                          />
                        )}

                        {stage === 'structure' && (
                          <StructureView
                            tree={displayTree}
                            isReadOnly={isReadOnly}
                            organizeMode={organizeMode}
                            draft={draft}
                            candidate={selectedCandidate}
                            isGenerating={isGeneratingTree}
                            onReorganize={() =>
                              selectedCandidate && handleSelectCandidate(selectedCandidate)
                            }
                            onDeleteNode={handleDeleteTreeNode}
                            onRenameNode={handleRenameTreeNode}
                            onAddSubdir={handleAddSubdirTreeNode}
                            onMoveNodeOrFile={handleMoveNodeOrFile}
                            highFrequencyTags={highFrequencyTags}
                            currentVDir={currentVDir}
                          />
                        )}

                        {stage === 'organizing' && (
                          <OrganizingView
                            tree={displayTree}
                            progressInfo={progressInfo}
                            isPaused={isPaused}
                            organizeMode={organizeMode}
                            draft={draft}
                            candidate={selectedCandidate}
                            toOrganizeFiles={toOrganizeFiles}
                            highFrequencyTags={highFrequencyTags}
                          />
                        )}

                        {stage === 'done' && (
                          <DoneView
                            tree={displayTree}
                            organizeMode={organizeMode}
                            onReorganize={handleReorganize}
                            onRescue={() => handleRescue(true)}
                            isRescuing={isRescuing}
                            isAutoRescuing={isAutoRescuing}
                            onAutoRescue={handleAutoRescue}
                            hasRescueFailed={hasRescueFailed}
                            progressInfo={progressInfo}
                            draft={draft}
                            candidate={selectedCandidate}
                            currentVDir={currentVDir}
                            options={options}
                            setOptions={setOptions}
                            onDeleteNode={handleDeleteTreeNode}
                            onRenameNode={handleRenameTreeNode}
                            onAddSubdir={handleAddSubdirTreeNode}
                            onMoveNodeOrFile={handleMoveNodeOrFile}
                            toOrganizeFiles={toOrganizeFiles}
                            highFrequencyTags={highFrequencyTags}
                          />
                        )}
                      </>
                    )}
                  </div>
                )
              }
            ]}
          />
          {!isWorkspaceActive && currentWorkspaceDirectory && (
            <RestrictedFeatureOverlay
              type={currentWorkspaceDirectory.type || 'SPEEDY'}
              targetName={currentWorkspaceDirectory.name}
              targetId={currentWorkspaceDirectory.id!}
              onSuccess={() => {
                fetchProfile()
                window.dispatchEvent(new CustomEvent('workspace-directories-updated'))
                loadWorkspaceDirectories()
              }}
            />
          )}
        </div>

        <OrganizeCustomFormDialog
          open={showCustomForm}
          onClose={() => setShowCustomForm(false)}
          onSubmit={handleCustomSubmit}
          initialName={initialVDirInfo?.name}
          initialStrategy={initialVDirInfo?.strategy}
          workspacePath={currentWorkspaceDirectory?.path}
        />

        {showEditStrategy && (
          <EditStrategyDialog
            open={showEditStrategy}
            initialStrategy={draft?.strategy || ''}
            onClose={() => setShowEditStrategy(false)}
            onSubmit={newStrategy => {
              if (draft) {
                setDraft({ ...draft, strategy: newStrategy })
                if (selectedCandidate) {
                  setSelectedCandidate({ ...selectedCandidate, strategy: newStrategy })
                }
              }
            }}
          />
        )}

        <Dialog open={showBackConfirm} onOpenChange={setShowBackConfirm}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('停止整理并返回？')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground py-2">
              {t('正在进行 AI 文件分类，返回上一级将停止当前的分类进程，是否继续？')}
            </p>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setShowBackConfirm(false)}>
                {t('继续整理')}
              </Button>
              <Button variant="destructive" onClick={handleBackConfirm}>
                {t('停止并返回')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={!!deleteConfirmNodeKey}
          onOpenChange={open => !open && cancelDeleteTreeNode()}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('确定要删除该目录吗？')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground py-2 leading-relaxed">
              {t('确定要删除目录「{name}」吗？该目录下的所有文件将被移至未归类列表中。', {
                name: deleteConfirmNodeName || deleteConfirmNodeKey || ''
              })}
            </p>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={cancelDeleteTreeNode}>
                {t('取消')}
              </Button>
              <Button variant="destructive" onClick={confirmDeleteTreeNode}>
                {t('确认删除')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showGuidanceDialog} onOpenChange={setShowGuidanceDialog}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('指导方案生成')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground mb-4">
              {t('请输入指导 AI 生成方案的提示词，AI 将以此为蓝本重新构思并生成 3 份整理方案')}
            </p>
            <textarea
              className="w-full min-h-[200px] p-3 rounded-xl border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
              placeholder={t('请描述您的整理需求，例如：以设计师视角整理素材文件')}
              value={
                guidancePrompt ||
                `以设计师视角，按以下目录结构整理素材文件：

- 设计素材库
  - UI设计
    - 组件库
    - 页面模板
    - 图标素材
  - 插画素材
    - 扁平插画
    - 3D插画
    - 手绘风格
  - 字体资源
    - 中文字体
    - 英文字体
    - 特殊字体
  - 图片素材
    - 背景图片
    - 照片素材
    - 纹理贴图
  - 动效资源
    - Lottie动画
    - GIF动图
    - 视频素材`
              }
              onChange={e => setGuidancePrompt(e.target.value)}
            />
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setShowGuidanceDialog(false)}>
                {t('取消')}
              </Button>
              <Button variant="outline" onClick={resetGuidancePrompt}>
                {t('恢复示例')}
              </Button>
              <Button onClick={handleGuideGeneration}>{t('生成方案')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <PaymentFlowDialog
        open={showRegenerateFirecoreConfirm}
        onOpenChange={setShowRegenerateFirecoreConfirm}
        cost={(computed_limits?.regenerate_vdir_cost as number) ?? 0}
        operationName={t('重新生成虚拟目录')}
        firecoreOperationType="spend_regenerate_vdir"
        metadata={{ vdirId: currentVDir?.id }}
        onSuccess={handleRegenerateSaveAfterFirecoreConfirm}
      />
      <Dialog open={showBatchLimitConfirm} onOpenChange={setShowBatchLimitConfirm}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-warning font-bold">
              <MaterialIcon icon="warning" className="text-warning text-xl" />
              {t('建议减少待整理文件')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-3 text-sm text-muted-foreground leading-relaxed">
            {t('当前文件较多。建议减少待整理文件数，否则整理耗时过长可能导致失败。')}
          </div>
          <DialogFooter className="flex-row justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setShowBatchLimitConfirm(false)}
              className="text-xs"
            >
              {t('取消')}
            </Button>
            <Button
              variant="secondary"
              onClick={handleSelectFilesToOrganize}
              className="text-xs font-medium"
            >
              {t('去选择文件')}
            </Button>
            <Button
              onClick={() => {
                setShowBatchLimitConfirm(false)
                executeStartOrganize()
              }}
              className="text-xs font-semibold"
            >
              {t('继续整理')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
