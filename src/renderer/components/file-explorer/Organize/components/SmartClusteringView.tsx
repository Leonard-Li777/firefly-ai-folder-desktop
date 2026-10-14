import React, { useState, useEffect, useCallback } from 'react'
import { VirtualDirectoryNode } from '@firefly/types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { Button } from '../../../ui/button'
import { Badge } from '../../../ui/badge'
import { Textarea } from '../../../ui/textarea'
import { VDirTree } from './VDirTree'
import { t } from '@app/languages'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../../ui/alert-dialog'

export interface SmartClusteringViewProps {
  workspaceId?: number
  workspaceDirectoryPath: string
  fileIds?: number[]
  onSaveVirtualDirectory: (name: string, tree: VirtualDirectoryNode[]) => Promise<void>
  onBack?: () => void
}

/** 6 组精选场景示例词 */
const PRESET_EXAMPLE_PROMPTS = [
  '按年份与财务类型归类',
  '按项目与设计稿归档',
  '个人学习与技术笔记',
  '合同与商务往来凭据',
  '媒体素材与拍摄产出',
  '会议纪要与周报总结'
]

export const SmartClusteringView: React.FC<SmartClusteringViewProps> = ({
  workspaceId,
  workspaceDirectoryPath,
  fileIds,
  onSaveVirtualDirectory,
  onBack
}) => {
  const [prompt, setPrompt] = useState<string>('')
  const [tree, setTree] = useState<VirtualDirectoryNode[]>([])
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [isTreeDirty, setIsTreeDirty] = useState<boolean>(false)
  const [summary, setSummary] = useState<string>('')
  const [durationMs, setDurationMs] = useState<number>(0)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [isSaving, setIsSaving] = useState<boolean>(false)

  // 脏状态防覆盖弹窗状态
  const [showDirtyDialog, setShowDirtyDialog] = useState<boolean>(false)
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)

  // 执行聚类请求核心函数
  const executeClustering = useCallback(
    async (userPrompt: string) => {
      setIsGenerating(true)
      setErrorMsg('')
      try {
        const res = await window.electronAPI.organizeRealDirectory.smartClusterHac({
          workspaceId,
          workspaceDirectoryPath,
          fileIds,
          prompt: userPrompt.trim()
        })

        if (!res || !res.success) {
          setErrorMsg(res?.summary || t('智能聚类执行失败或有效向量文件数不足'))
          setTree([])
          setSummary('')
          setDurationMs(0)
        } else {
          setTree(res.directories || [])
          setSummary(res.summary || '')
          setDurationMs(res.durationMs || 0)
          setIsTreeDirty(false)
        }
      } catch (err: any) {
        setErrorMsg(err?.message || t('智能聚类调用异常'))
      } finally {
        setIsGenerating(false)
      }
    },
    [workspaceId, workspaceDirectoryPath, fileIds]
  )

  // 首启自动生成基准聚类
  useEffect(() => {
    executeClustering('')
  }, [executeClustering])

  // 用户请求触发聚类（带脏状态拦截）
  const handleRequestClustering = (targetPrompt: string) => {
    if (isTreeDirty) {
      setPendingPrompt(targetPrompt)
      setShowDirtyDialog(true)
    } else {
      setPrompt(targetPrompt)
      executeClustering(targetPrompt)
    }
  }

  // 确认覆盖脏微调并重新聚类
  const handleConfirmDirtyOverwrite = () => {
    const nextPrompt = pendingPrompt ?? prompt
    setShowDirtyDialog(false)
    setPendingPrompt(null)
    setPrompt(nextPrompt)
    executeClustering(nextPrompt)
  }

  // 辅助函数：计算节点的路径唯一 key
  const getNodeKey = (node: any): string => {
    if (node.id) return String(node.id)
    return node.parent ? `${node.parent}/${node.name}` : node.name
  }

  // 目录树内联节点微调回调（变更即置 isTreeDirty = true）
  const handleRenameNode = useCallback((nodeKey: string, newName: string) => {
    const updateNodes = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return nodes.map(node => {
        const curKey = getNodeKey(node)
        if (curKey === nodeKey) {
          return { ...node, name: newName }
        }
        if (node.subdirectories && node.subdirectories.length > 0) {
          return { ...node, subdirectories: updateNodes(node.subdirectories) }
        }
        return node
      })
    }
    setTree(prev => updateNodes(prev))
    setIsTreeDirty(true)
  }, [])

  const handleDeleteNode = useCallback((nodeKey: string) => {
    const filterNodes = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return nodes
        .filter(node => getNodeKey(node) !== nodeKey)
        .map(node => {
          if (node.subdirectories && node.subdirectories.length > 0) {
            return { ...node, subdirectories: filterNodes(node.subdirectories) }
          }
          return node
        })
    }
    setTree(prev => filterNodes(prev))
    setIsTreeDirty(true)
  }, [])

  const handleAddSubdir = useCallback((parentKey: string, subdirName: string) => {
    const insertSubdir = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      if (!parentKey) {
        // 新建根节点
        const newNode: VirtualDirectoryNode = {
          name: subdirName,
          parent: null,
          files: [],
          fileCount: 0,
          totalSize: 0,
          subdirectories: []
        }
        return [...nodes, newNode]
      }
      return nodes.map(node => {
        const curKey = getNodeKey(node)
        if (curKey === parentKey) {
          const newChild: VirtualDirectoryNode = {
            name: subdirName,
            parent: curKey,
            files: [],
            fileCount: 0,
            totalSize: 0,
            subdirectories: []
          }
          return {
            ...node,
            subdirectories: [...(node.subdirectories || []), newChild]
          }
        }
        if (node.subdirectories && node.subdirectories.length > 0) {
          return { ...node, subdirectories: insertSubdir(node.subdirectories) }
        }
        return node
      })
    }
    setTree(prev => insertSubdir(prev))
    setIsTreeDirty(true)
  }, [])

  const handleMoveNodeOrFile = useCallback((draggedData: any, targetNodeKey: string) => {
    if (!draggedData || !draggedData.file) return
    const fileToMove = draggedData.file
    const sourceNodeKey = draggedData.sourceNodeKey

    setTree(prev => {
      // 1. 从原节点移除文件
      const cleanNodes = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          const curKey = getNodeKey(node)
          let files = node.files || []
          if (curKey === sourceNodeKey) {
            files = files.filter(f => {
              if (f.id && fileToMove.id) return f.id !== fileToMove.id
              const fPath = f.originalPath || (f as any).path
              const mPath = fileToMove.originalPath || fileToMove.path
              return fPath !== mPath
            })
          }
          const subdirs = node.subdirectories ? cleanNodes(node.subdirectories) : []
          return { ...node, files, fileCount: files.length, subdirectories: subdirs }
        })
      }

      // 2. 将文件添加到目标节点
      const addFileToTarget = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          const curKey = getNodeKey(node)
          let files = node.files || []
          if (curKey === targetNodeKey) {
            const exists = files.some(f => {
              if (f.id && fileToMove.id) return f.id === fileToMove.id
              const fPath = f.originalPath || (f as any).path
              const mPath = fileToMove.originalPath || fileToMove.path
              return fPath === mPath
            })
            if (!exists) {
              files = [...files, fileToMove]
            }
          }
          const subdirs = node.subdirectories ? addFileToTarget(node.subdirectories) : []
          return { ...node, files, fileCount: files.length, subdirectories: subdirs }
        })
      }

      const cleaned = cleanNodes(prev)
      return addFileToTarget(cleaned)
    })
    setIsTreeDirty(true)
  }, [])

  // 保存为虚拟目录
  const handleSave = async () => {
    if (tree.length === 0 || isSaving) return
    setIsSaving(true)
    try {
      const vdirName =
        prompt.trim() ||
        t('智能聚类整理 {date}', {
          date: new Date().toLocaleDateString()
        })
      await onSaveVirtualDirectory(vdirName, tree)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full w-full overflow-hidden bg-background">
      {/* ─── 左栏：通俗直白意图输入与示例词 (Left Control Panel) ─── */}
      <div className="w-full md:w-88 lg:w-96 border-b md:border-b-0 md:border-r border-border/60 bg-muted/20 flex flex-col shrink-0 p-5 space-y-6 overflow-y-auto">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 flex items-center gap-1">
              <MaterialIcon icon="hub" className="text-xs" />
              {t('智能聚类')}
            </span>
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
              >
                <MaterialIcon icon="arrow_back" className="text-xs mr-1" />
                {t('返回')}
              </Button>
            )}
          </div>
          <h3 className="text-lg font-bold text-foreground tracking-tight">
            {t('无监督语义聚类')}
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t(
              '无需复杂选择，输入您期望的整理目标或主题，AI 将基于文件内容特征自动聚类并生成结构。'
            )}
          </p>
        </div>

        {/* 提示词输入区域 */}
        <div className="space-y-3">
          <label className="text-xs font-semibold text-foreground/90 flex items-center justify-between">
            <span>{t('整理意图或主题 (可选)')}</span>
            {prompt && (
              <button
                type="button"
                onClick={() => handleRequestClustering('')}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('清空')}
              </button>
            )}
          </label>
          <Textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleRequestClustering(prompt)
              }
            }}
            placeholder={t('如：按年份和财务归类、项目文档归档... (回车立即聚类)')}
            className="min-h-[90px] text-xs resize-none bg-background focus-visible:ring-1"
          />
          <Button
            onClick={() => handleRequestClustering(prompt)}
            disabled={isGenerating}
            size="sm"
            className="w-full h-8 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground flex items-center justify-center gap-1.5 shadow-xs"
          >
            <MaterialIcon
              icon={isGenerating ? 'progress_activity' : 'auto_fix_high'}
              className={cn('text-sm', isGenerating && 'animate-spin')}
            />
            <span>{isGenerating ? t('正在聚类分析...') : t('重新生成聚类')}</span>
          </Button>
        </div>

        {/* 6 组精选场景示例词 */}
        <div className="space-y-2.5 pt-2 border-t border-border/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground/80">
              {t('精选示例 (点击一键填入)')}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESET_EXAMPLE_PROMPTS.map((ex, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleRequestClustering(ex)}
                className="text-[11px] px-2.5 py-1 rounded-lg border border-border/70 bg-card hover:border-blue-500/50 hover:bg-blue-500/5 hover:text-blue-600 dark:hover:text-blue-400 transition-all text-left flex items-center gap-1 shadow-2xs"
              >
                <MaterialIcon icon="lightbulb" className="text-xs text-amber-500 shrink-0" />
                <span>{ex}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 脏状态保护指示器 */}
        {isTreeDirty && (
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-2">
            <MaterialIcon icon="edit_note" className="text-sm shrink-0" />
            <span>{t('已手动微调目录树，重新聚类将提示覆盖确认。')}</span>
          </div>
        )}
      </div>

      {/* ─── 右栏：即时聚类树与保存 (Right Tree Panel) ─── */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-card/40">
        {/* 顶部工具栏与统计 */}
        <div className="h-14 px-6 border-b border-border/60 flex items-center justify-between shrink-0 bg-background/80 backdrop-blur-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-sm font-bold text-foreground truncate">
              {t('生成结果目录树')}
            </span>
            {summary && (
              <Badge variant="secondary" className="text-[11px] font-normal truncate max-w-md">
                {summary}
              </Badge>
            )}
            {durationMs > 0 && (
              <span className="text-[11px] text-muted-foreground shrink-0">
                ({durationMs}ms)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              onClick={handleSave}
              disabled={tree.length === 0 || isGenerating || isSaving}
              size="sm"
              className="h-8 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5 shadow-xs"
            >
              <MaterialIcon
                icon={isSaving ? 'progress_activity' : 'bookmark_add'}
                className={cn('text-sm', isSaving && 'animate-spin')}
              />
              <span>{isSaving ? t('正在保存...') : t('保存为虚拟目录')}</span>
            </Button>
          </div>
        </div>

        {/* 目录树展示与内联微调区 */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 relative">
          {isGenerating ? (
            <div className="h-full flex flex-col items-center justify-center space-y-3 py-20 text-muted-foreground">
              <MaterialIcon icon="progress_activity" className="text-3xl animate-spin text-primary" />
              <p className="text-sm font-medium">{t('端侧 HAC 聚类引擎正在计算...')}</p>
            </div>
          ) : errorMsg ? (
            <div className="h-full flex flex-col items-center justify-center space-y-3 py-20 text-center max-w-sm mx-auto">
              <div className="w-12 h-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
                <MaterialIcon icon="error_outline" className="text-2xl" />
              </div>
              <p className="text-sm font-semibold text-foreground">{t('未生成有效聚类')}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{errorMsg}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => executeClustering('')}
                className="mt-2 text-xs"
              >
                {t('重试聚类')}
              </Button>
            </div>
          ) : tree.length > 0 ? (
            <div className="space-y-4 max-w-4xl mx-auto">
              <VDirTree
                nodes={tree}
                allowEdit={true}
                onRenameNode={handleRenameNode}
                onDeleteNode={handleDeleteNode}
                onAddSubdir={handleAddSubdir}
                onMoveNodeOrFile={handleMoveNodeOrFile}
              />
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center space-y-3 py-20 text-muted-foreground text-center">
              <MaterialIcon icon="folder_open" className="text-4xl opacity-50" />
              <p className="text-sm">{t('暂无目录数据，请点击左侧重新生成聚类')}</p>
            </div>
          )}
        </div>
      </div>

      {/* ─── 脏状态防覆盖确认对话框 (Dirty Overwrite Dialog) ─── */}
      <AlertDialog open={showDirtyDialog} onOpenChange={setShowDirtyDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <MaterialIcon icon="warning" className="text-amber-500" />
              <span>{t('覆盖微调确认')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                '检测到您已手动微调过当前目录树（如重命名或移动文件）。重新聚类将基于新提示词覆盖所有手动调整成果，是否继续？'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingPrompt(null)}>
              {t('取消')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDirtyOverwrite}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {t('覆盖并重新聚类')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
