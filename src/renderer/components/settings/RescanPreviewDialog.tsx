import React, { useState, useEffect, useRef, useCallback, memo } from 'react'
import type { IIgnoreRule } from '@yonuc/types/settings-types'
import { shouldIgnoreFileByRules } from '@yonuc/shared'
import { MaterialIcon } from '../../lib/utils'
import { toast } from '../common/Toast'
import { t } from '@app/languages'

/**
 * 文件变更类型
 */
type ChangeType = 'added' | 'modified'

/**
 * 文件变更信息
 */
interface FileChange {
  path: string
  name: string
  size: number
  type: string
  changeType: ChangeType
  relativePath: string // 相对于工作目录的路径
}

/**
 * 树节点（目录或文件）
 */
interface TreeNode {
  name: string
  path: string
  type: 'directory' | 'file'
  changeType?: ChangeType
  children: TreeNode[]
  file?: FileChange
}

interface RescanPreviewDialogProps {
  isOpen: boolean
  onClose: () => void
  workspaceDirectoryPath: string
  workspaceDirectoryName: string
  newFiles: Array<{ path: string; name: string; size: number; type: string }>
  modifiedFiles: Array<{ path: string; name: string; size: number; type: string }>
  onAddToQueue: (files: Array<{ path: string; name: string; size: number; type: string }>) => Promise<void>
}

// 提取并优化TreeNode组件
const MemoizedTreeNode: React.FC<{
  node: TreeNode;
  level: number;
  expandedNodes: Set<string>;
  selectedPaths: Set<string>;
  isDirectoryFullySelected: (node: TreeNode) => boolean;
  isDirectoryPartiallySelected: (node: TreeNode) => boolean;
  handleToggleExpand: (path: string) => void;
  handleToggleDirectorySelect: (node: TreeNode) => void;
  handleToggleFileSelect: (path: string) => void;
}> = memo(({
  node,
  level,
  expandedNodes,
  selectedPaths,
  isDirectoryFullySelected,
  isDirectoryPartiallySelected,
  handleToggleExpand,
  handleToggleDirectorySelect,
  handleToggleFileSelect
}) => {
  const isExpanded = expandedNodes.has(node.path)
  const hasChildren = node.children.length > 0

  const isFullySelected = node.type === 'directory' && isDirectoryFullySelected(node)
  const isPartiallySelected = node.type === 'directory' && isDirectoryPartiallySelected(node)
  const isFileSelected = node.file ? selectedPaths.has(node.file.path) : false

  const getChangeLabel = (changeType: ChangeType) => {
    switch (changeType) {
      case 'added':
        return { text: '[New]', color: 'text-green-600 dark:text-green-400' }
      case 'modified':
        return { text: '[Mod]', color: 'text-yellow-600 dark:text-yellow-400' }
    }
  }

  return (
    <div>
      <div
        className={`flex items-center py-1.5 px-2 hover:bg-accent dark:hover:bg-accent rounded transition-colors ${node.type === 'directory' ? 'cursor-pointer' : ''}`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => node.type === 'directory' && handleToggleExpand(node.path)}
      >
        {hasChildren ? (
          <MaterialIcon
            icon={isExpanded ? 'expand_more' : 'chevron_right'}
            className="text-base text-muted-foreground dark:text-muted-foreground mr-1 cursor-pointer hover:bg-muted/50 rounded"
            onClick={(e) => {
              e.stopPropagation()
              handleToggleExpand(node.path)
            }}
          />
        ) : (
          <span className="w-5 mr-1" />
        )}
        {node.type === 'directory' ? (
          <input
            type="checkbox"
            checked={isFullySelected}
            ref={(input) => {
              if (input) input.indeterminate = isPartiallySelected
            }}
            onChange={() => handleToggleDirectorySelect(node)}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 rounded border-border dark:border-border mr-2 cursor-pointer accent-primary"
          />
        ) : (
          <input
            type="checkbox"
            checked={isFileSelected}
            onChange={() => node.file && handleToggleFileSelect(node.file.path)}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 rounded border-border dark:border-border mr-2 cursor-pointer accent-primary"
          />
        )}
        <MaterialIcon
          icon={node.type === 'directory' ? 'folder' : 'insert_drive_file'}
          className={`text-base mr-2 ${node.type === 'directory'
            ? 'text-blue-600 dark:text-blue-400'
            : node.changeType === 'added'
              ? 'text-green-600 dark:text-green-400'
              : 'text-yellow-600 dark:text-yellow-400'
            }`}
        />
        <span
          className={`text-sm flex-1 ${node.changeType === 'added'
            ? 'text-green-700 dark:text-green-300 font-medium'
            : node.changeType === 'modified'
              ? 'text-yellow-700 dark:text-yellow-300 font-medium'
              : 'text-foreground dark:text-foreground'
            }`}
          title={node.path}
        >
          {node.name}
        </span>
        {node.changeType && (
          <span className={`text-xs ml-2 font-semibold ${getChangeLabel(node.changeType).color}`}>
            {getChangeLabel(node.changeType).text}
          </span>
        )}
      </div>
      {isExpanded && hasChildren && (
        <div>
          {node.children.map((child, index) => (
            <MemoizedTreeNode
              key={`${child.path}-${index}`}
              node={child}
              level={level + 1}
              expandedNodes={expandedNodes}
              selectedPaths={selectedPaths}
              isDirectoryFullySelected={isDirectoryFullySelected}
              isDirectoryPartiallySelected={isDirectoryPartiallySelected}
              handleToggleExpand={handleToggleExpand}
              handleToggleDirectorySelect={handleToggleDirectorySelect}
              handleToggleFileSelect={handleToggleFileSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
});

export const RescanPreviewDialog: React.FC<RescanPreviewDialogProps> = ({
  isOpen,
  onClose,
  workspaceDirectoryPath,
  workspaceDirectoryName,
  newFiles,
  modifiedFiles,
  onAddToQueue,
}) => {
  const [fileChanges, setFileChanges] = useState<FileChange[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [isAdding, setIsAdding] = useState(false)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [tree, setTree] = useState<TreeNode[]>([])
  const [ignoreRules, setIgnoreRules] = useState<IIgnoreRule[]>([])

  // 加载忽略规则（用于预览列表过滤显示）
  useEffect(() => {
    if (!isOpen) {
      return
    }

    let canceled = false

    const load = async () => {
      try {
        const rules = await window.electronAPI!.getAnalysisIgnoreRules()
        if (!canceled) {
          // 类型断言：将后端返回的类型转换为 IIgnoreRule[]
          setIgnoreRules(Array.isArray(rules) ? (rules as unknown as IIgnoreRule[]) : [])
        }
      } catch {
        if (!canceled) {
          setIgnoreRules([])
        }
      }
    }

    load()

    return () => {
      canceled = true
    }
  }, [isOpen])

  // 构建文件变更列表
  useEffect(() => {
    if (isOpen) {
      const changes: FileChange[] = []

      // 添加新增文件（按忽略规则过滤）
      newFiles.forEach((file) => {
        const relativePath = file.path.replace(workspaceDirectoryPath, '').replace(/^[\\/]+/, '')
        if (!shouldIgnoreFileByRules(file.path, file.name, ignoreRules)) {
          changes.push({ ...file, changeType: 'added', relativePath })
        }
      })

      // 添加修改文件（按忽略规则过滤）
      modifiedFiles.forEach((file) => {
        const relativePath = file.path.replace(workspaceDirectoryPath, '').replace(/^[\\/]+/, '')
        if (!shouldIgnoreFileByRules(file.path, file.name, ignoreRules)) {
          changes.push({ ...file, changeType: 'modified', relativePath })
        }
      })
      setFileChanges(changes)

      // 默认全选所有变更文件
      const defaultSelected = new Set<string>()
      changes.forEach((change) => defaultSelected.add(change.path))
      setSelectedPaths(defaultSelected)
    }
  }, [isOpen, newFiles, modifiedFiles, workspaceDirectoryPath, ignoreRules])

  // 构建树形结构
  useEffect(() => {
    if (fileChanges.length === 0) {
      setTree([])
      return
    }
    const buildTree = () => {
      const root: TreeNode[] = [];
      const pathMap = new Map<string, TreeNode>();
      fileChanges.forEach((change) => {
        const parts = change.relativePath.split(/[\\/]/);
        let currentPath = '';
        let currentLevel = root;
        parts.forEach((part, index) => {
          const isLast = index === parts.length - 1;
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          if (isLast) {
            currentLevel.push({ name: part, path: currentPath, type: 'file', changeType: change.changeType, children: [], file: change });
          } else {
            let dirNode = pathMap.get(currentPath);
            if (!dirNode) {
              dirNode = { name: part, path: currentPath, type: 'directory', children: [] };
              pathMap.set(currentPath, dirNode);
              currentLevel.push(dirNode);
            }
            currentLevel = dirNode.children;
          }
        });
      });
      return root;
    };
    const treeData = buildTree();
    setTree(treeData);
    const topLevelPaths = new Set<string>();
    treeData.forEach((node) => {
      if (node.type === 'directory') {
        topLevelPaths.add(node.path)
      }
    });
    setExpandedNodes(topLevelPaths);
  }, [fileChanges]);

  const getAllFilesInDirectory = useCallback((node: TreeNode): string[] => {
    const files: string[] = [];
    const traverse = (n: TreeNode) => {
      if (n.type === 'file' && n.file) files.push(n.file.path);
      else if (n.type === 'directory') n.children.forEach(traverse);
    };
    traverse(node);
    return files;
  }, []);

  const isDirectoryFullySelected = useCallback((node: TreeNode): boolean => {
    if (node.type === 'file') return false;
    const allFiles = getAllFilesInDirectory(node);
    return allFiles.length > 0 && allFiles.every(path => selectedPaths.has(path));
  }, [getAllFilesInDirectory, selectedPaths]);

  const isDirectoryPartiallySelected = useCallback((node: TreeNode): boolean => {
    if (node.type === 'file') return false;
    const allFiles = getAllFilesInDirectory(node);
    const selectedCount = allFiles.filter(path => selectedPaths.has(path)).length;
    return selectedCount > 0 && selectedCount < allFiles.length;
  }, [getAllFilesInDirectory, selectedPaths]);

  const handleToggleFileSelect = useCallback((filePath: string) => {
    setSelectedPaths(prevSelected => {
      const newSelected = new Set(prevSelected);
      if (newSelected.has(filePath)) {
        newSelected.delete(filePath);
      } else {
        newSelected.add(filePath);
      }
      return newSelected;
    });
  }, []);

  const handleToggleDirectorySelect = useCallback((node: TreeNode) => {
    if (node.type === 'file') return;
    const allFiles = getAllFilesInDirectory(node);
    const isFullySelected = allFiles.length > 0 && allFiles.every(path => selectedPaths.has(path));
    setSelectedPaths(prevSelected => {
      const newSelected = new Set(prevSelected);
      if (isFullySelected) {
        allFiles.forEach(path => newSelected.delete(path));
      } else {
        allFiles.forEach(path => newSelected.add(path));
      }
      return newSelected;
    });
  }, [getAllFilesInDirectory, selectedPaths]);

  const handleInvertSelection = useCallback(() => {
    const newSelected = new Set<string>();
    fileChanges.forEach((change) => {
      if (!selectedPaths.has(change.path)) {
        newSelected.add(change.path);
      }
    });
    setSelectedPaths(newSelected);
  }, [fileChanges, selectedPaths]);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedNodes(prevExpanded => {
      const newExpanded = new Set(prevExpanded);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
      } else {
        newExpanded.add(path);
      }
      return newExpanded;
    });
  }, []);

  const handleAddToQueue = useCallback(async () => {
    if (selectedPaths.size === 0) {
      toast.warning(t('请至少选择一个文件'));
      return;
    }
    setIsAdding(true);
    try {
      const filesToAdd = fileChanges.filter((change) => selectedPaths.has(change.path));
      const filesForQueue = filesToAdd.map((change) => ({ path: change.path, name: change.name, size: change.size, type: change.type }));
      await onAddToQueue(filesForQueue);
      toast.success(t('{count} 个文件已加入AI分析队列', { count: filesToAdd.length }));
      const newFileChanges = fileChanges.filter((change) => !selectedPaths.has(change.path));
      setFileChanges(newFileChanges);
      setSelectedPaths(new Set());
      if (newFileChanges.length === 0) {
        toast.success(t('所有变更文件已处理完成'));
        onClose();
      }
    } catch (error: any) {
      console.error('加入分析队列失败:', error);
      toast.error(t('加入分析队列失败: {error}', {error: error instanceof Error ? error.message : String(error)}));
    } finally {
      setIsAdding(false);
    }
  }, [selectedPaths, fileChanges, onAddToQueue, onClose]);

  if (!isOpen) return null;

  const newFilesCount = fileChanges.filter((f) => f.changeType === 'added').length;
  const modifiedFilesCount = fileChanges.filter((f) => f.changeType === 'modified').length;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[85vh] flex flex-col border border-border">
        <div className="flex items-center justify-between p-6 border-b border-border dark:border-border">
          <div>
            <h2 className="text-xl font-semibold text-foreground dark:text-foreground">{t('发现文件变更')}</h2>
            <p className="text-sm text-muted-foreground dark:text-muted-foreground mt-1">{t('工作目录: ')}{workspaceDirectoryName}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-accent dark:hover:bg-accent rounded-full transition-colors">
            <MaterialIcon icon="close" className="text-xl text-muted-foreground dark:text-muted-foreground" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {fileChanges.length === 0 ? (
            <div className="text-center py-8">
              <MaterialIcon icon="check_circle" className="text-6xl text-green-600 dark:text-green-400 mb-3" />
              <p className="text-foreground dark:text-foreground mb-1">{t('所有变更已处理完成')}</p>
              <p className="text-sm text-muted-foreground dark:text-muted-foreground">{t('可以关闭此对话框')}</p>
            </div>
          ) : (
            <>
              <div className="mb-4 p-4 bg-muted/50 dark:bg-muted/50 rounded-lg">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-4">
                    <span className="text-foreground dark:text-foreground">{t('新增文件:')} <span className="font-semibold text-green-600 dark:text-green-400">{newFilesCount}</span></span>
                    <span className="text-foreground dark:text-foreground">{t('修改文件:')} <span className="font-semibold text-yellow-600 dark:text-yellow-400">{modifiedFilesCount}</span></span>
                  </div>
                  <span className="text-muted-foreground dark:text-muted-foreground">{t('已选中')} <span className="font-semibold">{selectedPaths.size}</span> / {fileChanges.length}</span>
                </div>
              </div>
              <div className="mb-4 p-3 bg-muted/30 dark:bg-muted/30 rounded text-xs flex items-center gap-4">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-600 dark:bg-green-400"></span><span className="text-muted-foreground dark:text-muted-foreground">{t('新增文件')}</span></span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-600 dark:bg-yellow-400"></span><span className="text-muted-foreground dark:text-muted-foreground">{t('修改文件')}</span></span>
                <span className="flex items-center gap-1"><MaterialIcon icon="folder" className="text-sm text-blue-600 dark:text-blue-400" /><span className="text-muted-foreground dark:text-muted-foreground">{t('勾选目录可级联选择所有子文件')}</span></span>
              </div>
              <div className="border border-border dark:border-border rounded-lg p-4 bg-background dark:bg-background max-h-[400px] overflow-y-auto">
                {tree.map((node, index) => (
                  <MemoizedTreeNode
                    key={`${node.path}-${index}`}
                    node={node}
                    level={0}
                    expandedNodes={expandedNodes}
                    selectedPaths={selectedPaths}
                    isDirectoryFullySelected={isDirectoryFullySelected}
                    isDirectoryPartiallySelected={isDirectoryPartiallySelected}
                    handleToggleExpand={handleToggleExpand}
                    handleToggleDirectorySelect={handleToggleDirectorySelect}
                    handleToggleFileSelect={handleToggleFileSelect}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        <div className="flex justify-end space-x-3 p-6 border-t border-border dark:border-border">
          {fileChanges.length > 0 && (
            <>
              <button onClick={handleInvertSelection} className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors" disabled={isAdding}>{t('反选')}</button>
              <button onClick={onClose} className="px-4 py-2 border border-input rounded hover:bg-accent hover:text-accent-foreground text-foreground transition-colors" disabled={isAdding}>{t('关闭')}</button>
              <button onClick={handleAddToQueue} disabled={selectedPaths.size === 0 || isAdding} className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center">
                {isAdding ? (
                  <><div className="inline-block animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>{t('正在加入队列...')}</>
                ) : (
                  <><MaterialIcon icon="playlist_add" className="text-base mr-1" />{t('加入队列 ({count})', {count: selectedPaths.size})}</>
                )}
              </button>
            </>
          )}
          {fileChanges.length === 0 && (
            <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors">{t('关闭')}</button>
          )}
        </div>
      </div>
    </div>
  )
}

