import React, { useState } from 'react'
import { DirectoryNode, OrganizeType, FileInfoForAI } from '@yonuc/types/organize-types'
import { MaterialIcon } from '../../lib/utils'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { DirectoryTreePreview } from './DirectoryTreePreview'
import { t } from '@app/languages'
import { captureEvent } from '../../lib/posthog'

interface ConfirmOrganizeDialogProps {
  organizeType: OrganizeType
  fileCount: number
  directoryStructure: DirectoryNode[]
  fileMap?: Map<number, FileInfoForAI>
  isPrivate?: boolean
  onConfirm: (createBackup: boolean) => void
  onCancel: () => void
  onRegenerate?: (instruction: string) => void
  onConfirmVirtualDirectory?: () => void
}

/**
 * 确认整理对话框
 * 显示整理预览并让用户确认操作
 */
export const ConfirmOrganizeDialog: React.FC<ConfirmOrganizeDialogProps> = ({
  organizeType,
  fileCount,
  directoryStructure,
  fileMap,
  onConfirm,
  onCancel,
  onRegenerate,
  onConfirmVirtualDirectory,
}) => {
  const [createBackup, setCreateBackup] = useState(false)
  const [showInstructionInput, setShowInstructionInput] = useState(false)
  const [instructionText, setInstructionText] = useState('')
  const [showVirtualDirTip, setShowVirtualDirTip] = useState(false)

  const handleConfirm = async () => {
    // 验证授权状态
    if (window.electronAPI?.license) {
      const statusResult = await window.electronAPI.license.getStatus()
      if (statusResult.status !== 'AUTHORIZED') {
        window.dispatchEvent(new CustomEvent('app:unauthorized', { detail: statusResult }))
        return
      }
    }

    captureEvent('一键整理确认', { 
      organizeType, 
      fileCount,
      hasInstruction: !!instructionText.trim()
    })
    onConfirm(createBackup)
  }

  const handleCancel = () => {
    captureEvent('一键整理取消', { organizeType })
    onCancel()
  }

  const handleRegenerate = () => {
    captureEvent('一键整理自定义提示词重新生成', { 
      instructionLength: instructionText.length,
      instructionContent: instructionText
    })
    onRegenerate?.(instructionText)
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-2xl w-full p-6 max-h-[80vh] flex flex-col border border-border">
        <div className="flex items-center mb-4">
          <h2 className="text-xl font-bold">{t('整理真实目录')}</h2>
        </div>

        {organizeType === 'quickOrganize' && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900/50 rounded p-3 mb-4">
            <div className="flex items-start">
              <MaterialIcon icon="info" className="text-blue-500 text-lg mr-2 mt-0.5 shrink-0" />
              <div className="text-blue-800 dark:text-blue-200 text-sm flex-1">
                <span>{t('如果对结果不满意？请尝试：')}</span>
                <div className="inline-block relative">
                  <Button 
                    variant="link" 
                    className="text-blue-500 hover:underline p-0 h-auto" 
                    onClick={() => {
                      setShowVirtualDirTip(!showVirtualDirTip)
                      if (!showVirtualDirTip) captureEvent('查看虚拟目录功能提示')
                    }}
                  >
                    {t('导出虚拟目录功能')}
                  </Button>
                  {showVirtualDirTip && (
                    <div className="absolute bottom-full left-0 mb-2 p-3 bg-card text-card-foreground rounded shadow-lg border border-border z-50 w-64 text-xs">
                      {t('在虚拟目录页面左侧标签目录树中勾选标签，点击导出虚拟目录按钮，定制化的生成你需要的目录结构，且不影响真实目录的文件结构')}
                    </div>
                  )}
                </div>
                <span className="mx-1">{t('或者')}</span>
                <Button 
                  variant="link" 
                  className="text-blue-500 hover:underline p-0 h-auto"
                  onClick={() => {
                    setShowInstructionInput(!showInstructionInput)
                    if (!showInstructionInput) captureEvent('点击提示词引导按钮')
                  }}
                >
                  {t('提示词引导AI整理')}
                </Button>
              </div>
            </div>
            
            {showInstructionInput && (
              <div className="mt-3">
                <Textarea
                  placeholder={t('例如：目录名最多4个字')}
                  value={instructionText}
                  onChange={(e) => setInstructionText(e.target.value)}
                  className="mb-2 bg-white dark:bg-black/20"
                  rows={3}
                />
                <div className="flex justify-end mt-3">
                  <Button 
                    size="sm" 
                    onClick={handleRegenerate}
                    disabled={!instructionText.trim()}
                  >
                    {t('重新整理')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        <h3 className="font-semibold mb-2">{t('整理预览：')} <span className="font-bold">{t('{fileCount} 个文件将被移动到新位置', { fileCount })}</span></h3>

        <div className="flex-1 overflow-y-auto mb-4 border rounded p-3 bg-muted/30 dark:bg-muted">
          <div>
            <DirectoryTreePreview directories={directoryStructure} fileMap={fileMap} />
          </div>
        </div>



        {/* 底部操作区域 */}
        <div className="flex justify-end gap-3 mt-4">
          <button
            onClick={handleCancel}
            className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors"
          >
            {t('取消')}
          </button>
          
          {/* 导出虚拟目录按钮 */}
          {onConfirmVirtualDirectory && (
            <button
              onClick={async () => {
                // 验证授权状态
                if (window.electronAPI?.license) {
                  const statusResult = await window.electronAPI.license.getStatus()
                  if (statusResult.status !== 'AUTHORIZED') {
                    window.dispatchEvent(new CustomEvent('app:unauthorized', { detail: statusResult }))
                    return
                  }
                }

                captureEvent('一键整理确认-虚拟目录', { 
                  organizeType, 
                  fileCount 
                })
                onConfirmVirtualDirectory()
              }}
              className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
            >
              {t('导出虚拟目录')}
            </button>
          )}
          
          {/* 整理真实目录按钮（带hover警告） */}
          <div className="relative group">
            <button
              onClick={handleConfirm}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
            >
              {t('整理真实目录')}
            </button>
            {/* Hover 时显示的警告提示 */}
            <div className="absolute bottom-full right-0 mb-2 w-72 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-900/50 rounded shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50">
              <div className="flex items-start gap-2">
                <MaterialIcon icon="warning" className="text-yellow-500 text-lg shrink-0" />
                <p className="text-yellow-800 dark:text-yellow-200 text-sm">
                  {t('此操作将改变真实目录的文件结构，操作不可撤销！')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

