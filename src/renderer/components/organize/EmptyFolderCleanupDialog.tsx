import React, { useState, useEffect } from 'react'
import { MaterialIcon } from '../../lib/utils'
import { toast } from '../common/Toast'
import { t } from '@app/languages'

interface EmptyFolderNode {
  name: string
  path: string
  parent: string
  isEmpty: boolean
  children: EmptyFolderNode[]
}

interface EmptyFolderCleanupDialogProps {
  isOpen: boolean
  onClose: () => void
  workspaceDirectoryPath: string
  /** 可选的扫描路径，如果提供则使用此路径而非 workspaceDirectoryPath */
  scanPath?: string
}

/**
 * 空文件夹清理对话框
 * 支持树形展示、勾选/反选、批量删除
 */
export const EmptyFolderCleanupDialog: React.FC<EmptyFolderCleanupDialogProps> = ({
  isOpen,
  onClose,
  workspaceDirectoryPath,
  scanPath,
}) => {
  const [emptyFolders, setEmptyFolders] = useState<EmptyFolderNode[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [tree, setTree] = useState<EmptyFolderNode[]>([]);

  // 实际扫描路径
  const actualScanPath = scanPath || workspaceDirectoryPath

  // 加载空文件夹列表
  const loadEmptyFolders = async () => {
    if (!actualScanPath) return

    setIsLoading(true)
    try {
      const scanResult = await window.electronAPI!.emptyFolder.scan(actualScanPath)
      // scanResult 直接是数组，不是 { emptyFolders: [...] }
      const folders = Array.isArray(scanResult) ? scanResult : []
      setEmptyFolders(folders as any)

      // 默认选中所有空文件夹（存储路径字符串）
      const defaultSelected = new Set<string>(folders.map((f: any) => f.path))
      setSelectedPaths(defaultSelected)

      // 默认展开所有节点
      const allPaths = new Set<string>()
      folders.forEach((folder: any) => {
        allPaths.add(folder.path)
      })
      setExpandedNodes(allPaths)
    } catch (error: any) {
      console.error('扫描空文件夹失败:', error)
      const message = error?.message?.replace(/^Error invoking remote method.*?: Error: /, '') || String(error)
      toast.error(t('扫描失败: {message}', { message }))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      // 清空之前的状态，确保每次打开都是全新扫描
      setEmptyFolders([])
      setSelectedPaths(new Set())
      setTree([])
      setExpandedNodes(new Set())
      // 开始扫描
      loadEmptyFolders()
    }
  }, [isOpen, actualScanPath])

  // 当空文件夹列表变化时，异步构建树
  useEffect(() => {
    const buildTreeAsync = async () => {
      if (emptyFolders.length === 0) {
        setTree([]);
        return;
      }

      const rootNodes: EmptyFolderNode[] = []
      const nodeMap = new Map<string, EmptyFolderNode>()

      // 第一步：创建节点映射
      emptyFolders.forEach((folder) => {
        nodeMap.set(folder.path, { ...folder, children: [] })
      })

      // 第二步：构建父子关系
      for (const folder of emptyFolders) {
        const node = nodeMap.get(folder.path)
        if (!node) continue

        if (folder.parent === '') {
          rootNodes.push(node)
        } else {
          const parentFullPath = await window.electronAPI!.utils.joinPath(actualScanPath, folder.parent)
          const parentNode = nodeMap.get(parentFullPath)
          
          if (parentNode) {
            parentNode.children.push(node)
          } else {
            rootNodes.push(node)
          }
        }
      }
      setTree(rootNodes);
    }

    buildTreeAsync();
  }, [emptyFolders, actualScanPath]);


  // 处理勾选/反选
  const handleToggleSelect = (path: string, isEmpty: boolean) => {
    if (!isEmpty) return // 非空文件夹不可选

    const newSelected = new Set(selectedPaths)
    if (newSelected.has(path)) {
      newSelected.delete(path)
    } else {
      newSelected.add(path)
    }
    setSelectedPaths(newSelected)
  }

  // 反选所有可选项
  const handleInvertSelection = () => {
    const newSelected = new Set<string>()
    emptyFolders.forEach((folder) => {
      if (folder.isEmpty) {
        if (!selectedPaths.has(folder.path)) {
          newSelected.add(folder.path)
        }
      }
    })
    setSelectedPaths(newSelected)
  }

  // 切换展开/折叠
  const handleToggleExpand = (path: string) => {
    const newExpanded = new Set(expandedNodes)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
    }
    setExpandedNodes(newExpanded)
  }

  // 删除选中的文件夹
  const handleDeleteSelected = async () => {
    if (selectedPaths.size === 0) {
      toast.warning(t('请至少选择一个文件夹'))
      return
    }

    setIsDeleting(true)
    try {
      const pathsToDelete = Array.from(selectedPaths)
      const result = await window.electronAPI!.emptyFolder.delete(pathsToDelete)

      // 显示结果
      if (result.deletedFolders === (result as any).totalFolders) {
        toast.success(t('成功删除 {count} 个空文件夹', { count: result.deletedFolders }))
      } else {
        toast.warning(
          t('删除完成: 成功 {deleted}/{total}，失败 {failed}', { deleted: result.deletedFolders, total: (result as any).totalFolders, failed: result.failedFolders })
        )
      }

      // 重新加载剩余的空文件夹
      await loadEmptyFolders()

      // 检查是否还有可删除的空目录（isEmpty=true）
      const remainingDeletableFolders = emptyFolders.filter(f => f.isEmpty && !pathsToDelete.includes(f.path))
      if (remainingDeletableFolders.length === 0) {
        // 没有剩余可删除的空目录，自动关闭弹窗
        toast.success(t('所有可删除的空文件夹已处理完成'))
        onClose()
      }
    } catch (error: any) {
      console.error('删除空文件夹失败:', error)
      const message = error?.message?.replace(/^Error invoking remote method.*?: Error: /, '') || String(error)
      toast.error(t('删除失败: {message}', { message }))
    } finally {
      setIsDeleting(false)
    }
  }

  // 树形节点组件
  const TreeNode: React.FC<{ node: EmptyFolderNode; level: number }> = ({ node, level }) => {
    const isExpanded = expandedNodes.has(node.path)
    const isSelected = selectedPaths.has(node.path)
    const hasChildren = node.children.length > 0

    return (
      <div>
        {/* 节点行 */}
        <div
          className="flex items-center py-1.5 px-2 hover:bg-accent dark:hover:bg-accent rounded transition-colors"
          style={{ paddingLeft: `${level * 16 + 8}px` }}
        >
          {/* 展开/折叠图标 */}
          {hasChildren ? (
            <MaterialIcon
              icon={isExpanded ? 'expand_more' : 'chevron_right'}
              className="text-base text-muted-foreground dark:text-muted-foreground mr-1 cursor-pointer"
              onClick={() => handleToggleExpand(node.path)}
            />
          ) : (
            <span className="w-5 mr-1" />
          )}

          {/* 复选框 */}
          <input
            type="checkbox"
            checked={isSelected}
            disabled={!node.isEmpty}
            onChange={() => handleToggleSelect(node.path, node.isEmpty)}
            className={`w-4 h-4 rounded border-border dark:border-border mr-2 ${
              node.isEmpty ? 'cursor-pointer accent-primary' : 'cursor-not-allowed opacity-50'
            }`}
          />

          {/* 文件夹图标 */}
          <MaterialIcon
            icon="folder"
            className={`text-base mr-2 ${
              node.isEmpty ? 'text-primary dark:text-primary' : 'text-muted-foreground dark:text-muted-foreground'
            }`}
          />

          {/* 文件夹名称 */}
          <span
            className={`text-sm flex-1 ${
              node.isEmpty ? 'text-foreground dark:text-foreground' : 'text-muted-foreground dark:text-muted-foreground'
            }`}
            title={node.path}
          >
            {node.name}
          </span>

          {/* 标记（非空） */}
          {!node.isEmpty && (
            <span className="text-xs text-muted-foreground dark:text-muted-foreground ml-2 italic">
              {t('(非空)')}
            </span>
          )}
        </div>

        {/* 渲染子节点 */}
        {isExpanded && hasChildren && (
          <div>
            {node.children.map((child, index) => (
              <TreeNode key={`${child.path}-${index}`} node={child} level={level + 1} />
            ))}
          </div>
        )}
      </div>
    )
  }

  if (!isOpen) return null

  const selectableCount = emptyFolders.filter((f) => f.isEmpty).length

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[85vh] flex flex-col border border-border">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border dark:border-border">
          <div>
            <h2 className="text-xl font-semibold text-foreground dark:text-foreground">
              {t('清理空文件夹')}
            </h2>
            <p className="text-sm text-muted-foreground dark:text-muted-foreground mt-1">
              {t('检测并删除工作目录中的空文件夹')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-accent dark:hover:bg-accent rounded-full transition-colors"
          >
            <MaterialIcon icon="close" className="text-xl text-muted-foreground dark:text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary dark:border-primary mb-2"></div>
              <p className="text-sm text-muted-foreground dark:text-muted-foreground">{t('扫描空文件夹中...')}</p>
            </div>
          ) : tree.length === 0 ? (
            <div className="text-center py-8">
              <MaterialIcon icon="folder" className="text-6xl text-muted-foreground dark:text-muted-foreground mb-3" />
              <p className="text-foreground dark:text-foreground mb-1">{t('未发现空文件夹')}</p>
              <p className="text-sm text-muted-foreground dark:text-muted-foreground">
                {t('该目录中没有空文件夹需要清理')}
              </p>
            </div>
          ) : (
            <>
              {/* 统计信息 */}
              <div className="mb-4 p-4 bg-muted/50 dark:bg-muted/50 rounded-lg">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-foreground dark:text-foreground">
                    {t('发现 {count} 个空文件夹', { count: selectableCount })}
                  </span>
                  <span className="text-muted-foreground dark:text-muted-foreground">
                    {t('已选中 {selected} 个', { selected: selectedPaths.size })}
                  </span>
                </div>
              </div>

              {/* 树形列表 */}
              <div className="border border-border dark:border-border rounded-lg p-4 bg-background dark:bg-background max-h-[400px] overflow-y-auto">
                {tree.map((node, index) => (
                  <TreeNode key={`${node.path}-${index}`} node={node} level={0} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end space-x-3 p-6 border-t border-border dark:border-border">
          {!isLoading && tree.length > 0 && (
            <>
              <button
                onClick={handleInvertSelection}
                className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors"
                disabled={isDeleting}
              >
                {t('反选')}
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors"
                disabled={isDeleting}
              >
                {t('关闭')}
              </button>
              <button
                onClick={handleDeleteSelected}
                disabled={selectedPaths.size === 0 || isDeleting}
                className="px-4 py-2 bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {isDeleting ? (
                  <>
                    <div className="inline-block animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                    {t('正在删除...')}
                  </>
                ) : (
                  <>
                    <MaterialIcon icon="delete" className="text-base mr-1" />
                    {t('删除选中 ({count} 个)', { count: selectedPaths.size })}
                  </>
                )}
              </button>
            </>
          )}
          {(isLoading || tree.length === 0) && (
            <button
              onClick={onClose}
              className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors"
            >
              {t('关闭')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
