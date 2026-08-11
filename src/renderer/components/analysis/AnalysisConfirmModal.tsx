import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Button } from '../ui/button'
import { t } from '@app/languages'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import FileList from '../file-explorer/FileList'

export function AnalysisConfirmModal() {
  const {
    showConfirmModal,
    setShowConfirmModal,
    confirmModalFiles,
    handleConfirmSkip,
    handleConfirmReanalyze
  } = useAnalysisQueueStore()

  const mappedFiles = React.useMemo(() => {
    return confirmModalFiles.map((file, index) => {
      // 提取 parentPath
      const match = file.path.match(/^(.*)[/\\][^/\\]+$/)
      const parentPath = match ? match[1] : ''
      return {
        id: `confirm-file-${index}`,
        name: file.name,
        smartName: (file as any).smartName,
        path: file.path,
        parentPath,
        size: file.size,
        extension: file.type || '',
        modifiedAt: new Date(),
        isAnalyzed: true,
        qualityScore: (file as any).qualityScore,
        description: (file as any).description,
        tags: (file as any).tags,
        author: (file as any).author,
        language: (file as any).language
      }
    })
  }, [confirmModalFiles])

  return (
    <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
      <DialogContent className="max-w-[750px] max-h-[85vh] flex flex-col p-6 rounded-xl">
        <DialogHeader className="mb-2 flex-shrink-0">
          <DialogTitle className="text-lg font-bold text-foreground">
            {t('重新分析确认')}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground mt-1">
            {t(
              '检测到所选的文件中包含在当前模式下已完成分析的文件，您可以选择跳过这些文件或重新进行分析。'
            )}
          </DialogDescription>
        </DialogHeader>

        {/* 确认弹窗列表容器 — 基于标准 FileList 呈现（包含智能文件名+原文件名双名称展示），外层常驻横竖滚动 */}
        <div className="flex-1 h-[340px] min-h-[300px] border border-border/80 rounded-lg overflow-auto relative bg-muted/20">
          <FileList
            files={mappedFiles}
            directories={[]}
            selectedFiles={[]}
            onFileSelect={() => {}}
            onDirectoryChange={() => {}}
            currentPath=""
            viewMode="list"
            showAnalysisStatus={false}
            selectionEnabled={false}
            isRealDirectory={false}
            forceShowAllFields={true}
            showsmartName={true}
          />
        </div>

        <DialogFooter className="mt-4 gap-2 flex-col sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => setShowConfirmModal(false)}
            className="w-full sm:w-auto"
          >
            {t('取消')}
          </Button>
          <Button
            variant="secondary"
            onClick={handleConfirmReanalyze}
            className="w-full sm:w-auto border border-border bg-secondary hover:bg-secondary/80 text-secondary-foreground"
          >
            {t('重新分析')}
          </Button>
          <Button
            variant="default"
            onClick={handleConfirmSkip}
            className="w-full sm:w-auto bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {t('跳过已分析文件')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
