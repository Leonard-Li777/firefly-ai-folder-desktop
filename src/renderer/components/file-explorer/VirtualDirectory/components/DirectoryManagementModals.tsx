import React, { useState, useImperativeHandle, forwardRef } from 'react'
import { PromptDialog } from '../../../../components/common/PromptDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../../../components/ui/alert-dialog'
import { Button } from '../../../../components/ui/button'
import { VirtualDirectory } from '@firefly/types'
import { t } from '@app/languages'

export interface DirectoryManagementModalsRef {
  rename: (id: number) => void
  confirmDelete: (id: number) => void
}

interface DirectoryManagementModalsProps {
  virtualDirectories: VirtualDirectory[]
  handleRename: (id: number, newName: string) => Promise<void>
  executeDelete: (id: number) => Promise<void>
}

export const DirectoryManagementModals = React.memo(
  forwardRef<DirectoryManagementModalsRef, DirectoryManagementModalsProps>(
    ({ virtualDirectories, handleRename, executeDelete }, ref) => {
      const [renamingId, setRenamingId] = useState<number | null>(null)
      const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)

      useImperativeHandle(ref, () => ({
        rename: (id: number) => {
          setRenamingId(id)
        },
        confirmDelete: (id: number) => {
          setDeleteConfirmId(id)
        }
      }))

      const handleRenameSubmit = async (newName: string) => {
        if (renamingId) {
          await handleRename(renamingId, newName)
          setRenamingId(null)
        }
      }

      const handleDeleteConfirm = async () => {
        if (deleteConfirmId) {
          await executeDelete(deleteConfirmId)
          setDeleteConfirmId(null)
        }
      }

      return (
        <>
          <PromptDialog
            open={renamingId !== null}
            onClose={() => setRenamingId(null)}
            onSubmit={handleRenameSubmit}
            title={t('重命名虚拟目录')}
            message={t('请输入新的名称：')}
            defaultValue={virtualDirectories.find(d => d.id === renamingId)?.name}
          />

          <AlertDialog
            open={deleteConfirmId !== null}
            onOpenChange={(open: boolean) => !open && setDeleteConfirmId(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader className="text-left">
                <AlertDialogTitle>{t('删除虚拟目录')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('确认要删除该虚拟目录吗？此操作不可撤销。')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel asChild>
                  <Button variant="outline">{t('取消')}</Button>
                </AlertDialogCancel>
                <AlertDialogAction asChild>
                  <Button variant="destructive" onClick={handleDeleteConfirm}>
                    {t('删除')}
                  </Button>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )
    }
  )
)

DirectoryManagementModals.displayName = 'DirectoryManagementModals'
