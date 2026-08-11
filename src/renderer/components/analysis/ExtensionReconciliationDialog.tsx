import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Button } from '../ui/button'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'
import { Label } from '../ui/label'
import { FolderOpen } from 'lucide-react'
import { t } from '@app/languages'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'

export function ExtensionReconciliationDialog() {
  const { reconciliationFiles, showReconciliationDialog, setShowReconciliationDialog } =
    useAnalysisQueueStore()

  const [choices, setChoices] = useState<Record<string, string>>({})
  const [workspacePath, setWorkspacePath] = useState<string>('')

  useEffect(() => {
    if (showReconciliationDialog) {
      const initialChoices: Record<string, string> = {}
      reconciliationFiles.forEach(f => {
        initialChoices[f.fileFingerprint] = 'ORIGINAL'
      })
      setChoices(initialChoices)

      // 异步获取当前工作目录根路径
      window
        .electronAPI!.getCurrentWorkspaceDirectory()
        .then(dir => {
          if (dir?.path) {
            setWorkspacePath(dir.path)
          }
        })
        .catch(err => {
          console.error('[Frontend] 获取当前工作区失败:', err)
        })
    }
  }, [showReconciliationDialog, reconciliationFiles])

  const handleConfirm = async () => {
    const fixes = Object.entries(choices).map(([fileFingerprint, val]) => ({
      fileFingerprint,
      chosenExtension: val === 'ORIGINAL' ? null : val
    }))
    try {
      await window.electronAPI!.batchFixExtensions(fixes)
      setShowReconciliationDialog(false)
    } catch (error) {
      console.error('[Frontend] 批量修正扩展名失败:', error)
    }
  }

  const handleOpenFolder = (path: string) => {
    window.electronAPI!.utils.showItemInFolder(path)
  }

  return (
    <Dialog open={showReconciliationDialog} onOpenChange={setShowReconciliationDialog}>
      <DialogContent className="max-w-[1000px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('智能文件名扩展名确认')}</DialogTitle>
          <DialogDescription>
            {t('此操作仅会更新智能文件名，不会影响磁盘中的原始文件。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto my-4 border rounded-md">
          <div className="grid grid-cols-[1fr_80px_300px] text-xs font-medium text-muted-foreground px-3 py-2 border-b bg-muted sticky top-0 z-10">
            <div>{t('智能文件名')}</div>
            <div className="text-center">{t('定位')}</div>
            <div>{t('扩展名确认')}</div>
          </div>

          <div className="divide-y">
            {reconciliationFiles.map(file => {
              const platform = window.electronAPI?.utils?.getPlatform?.() || 'win32'
              const isWin = platform === 'win32'

              const normP = file.path.replace(/[\\\/]+/g, '/').trim()
              const normR = workspacePath
                .replace(/[\\\/]+/g, '/')
                .replace(/\/+$/, '')
                .trim()

              let relativePath = file.path
              if (normR) {
                const normP_lower = isWin ? normP.toLowerCase() : normP
                const normR_lower = isWin ? normR.toLowerCase() : normR

                if (normP_lower.startsWith(normR_lower + '/')) {
                  relativePath = file.path.slice(normR.length + 1)
                } else if (normP_lower === normR_lower) {
                  relativePath = ''
                }
              }

              return (
                <div
                  key={file.fileFingerprint}
                  className="grid grid-cols-[1fr_80px_300px] items-center px-3 py-3 hover:bg-accent/50 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" title={file.smartName}>
                      {file.smartName}
                    </div>
                    <div
                      className="truncate text-[10px] text-muted-foreground leading-relaxed mt-0.5"
                      title={relativePath}
                    >
                      {relativePath}
                    </div>
                  </div>
                  <div className="flex justify-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-primary"
                      onClick={() => handleOpenFolder(file.path)}
                      title={t('在文件夹中打开')}
                    >
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  </div>
                  <div>
                    <RadioGroup
                      value={choices[file.fileFingerprint] || 'ORIGINAL'}
                      onValueChange={val =>
                        setChoices(prev => ({ ...prev, [file.fileFingerprint]: val }))
                      }
                      className="flex flex-wrap gap-x-4 gap-y-2"
                    >
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="ORIGINAL" id={`orig-${file.fileFingerprint}`} />
                        <Label
                          htmlFor={`orig-${file.fileFingerprint}`}
                          className="text-xs cursor-pointer"
                        >
                          {t('不更名')}
                        </Label>
                      </div>
                      {Array.from(new Set(file.extensions))
                        .filter(ext => {
                          const displayExt = ext.startsWith('.') ? ext : `.${ext}`
                          const originalExt = file.type.startsWith('.')
                            ? file.type
                            : `.${file.type}`
                          return displayExt !== originalExt
                        })
                        .map(ext => {
                          const displayExt = ext.startsWith('.') ? ext : `.${ext}`
                          return (
                            <div key={ext} className="flex items-center space-x-2">
                              <RadioGroupItem
                                value={displayExt}
                                id={`${ext}-${file.fileFingerprint}`}
                              />
                              <Label
                                htmlFor={`${ext}-${file.fileFingerprint}`}
                                className="text-xs cursor-pointer font-mono"
                              >
                                {displayExt}
                              </Label>
                            </div>
                          )
                        })}
                    </RadioGroup>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowReconciliationDialog(false)}>
            {t('取消')}
          </Button>
          <Button onClick={handleConfirm}>{t('确认')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
