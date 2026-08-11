import React, { useCallback, useState } from 'react'
import { DirectoryNode, FileInfoForAI } from '@firefly/types/organize-types'
import { MaterialIcon } from '../../lib/utils'
import { EmptyState } from '../common/EmptyState'
import { t } from '@app/languages'
import { useSettingsStore } from '../../stores/settings-store'

interface DirectoryTreePreviewProps {
  directories: DirectoryNode[]
  fileMap?: Map<number, FileInfoForAI> // 文件ID到文件信息的映射
  isReadOnly?: boolean
  onDeleteNode?: (nodeKey: string) => void // 删除节点回调，nodeKey为 "name::parent" 格式
}

/**
 * 目录树预览组件
 * 用于在整理前显示目录结构预览
 * 支持parent链式结构
 */
export const DirectoryTreePreview: React.FC<DirectoryTreePreviewProps> = ({
  directories,
  fileMap,
  isReadOnly = false,
  onDeleteNode
}) => {
  // 参数验证：确保directories是有效的数组
  if (!directories || !Array.isArray(directories)) {
    return (
      <EmptyState
        icon="folder_off"
        title={t('暂无目录结构预览')}
        className="h-40 p-4 bg-transparent"
      />
    )
  }

  if (directories.length === 0) {
    return (
      <EmptyState icon="folder_off" title={t('目录结构为空')} className="h-40 p-4 bg-transparent" />
    )
  }

  // 构建目录层级关系
  // 使用parent字段重建树形结构
  const buildTree = (dirs: DirectoryNode[]): DirectoryNode[] => {
    // 找出所有顶级目录（parent为空）
    const topLevel = dirs.filter(dir => !dir.parent || dir.parent === '')

    // 为每个目录添加subdirectories属性（临时用于渲染）
    const enrichedDirs = dirs.map(dir => ({ ...dir, subdirectories: [] as DirectoryNode[] }))

    // 构建父子关系
    enrichedDirs.forEach(dir => {
      if (dir.parent && dir.parent !== '') {
        const parentDir = enrichedDirs.find(d => d.name === dir.parent)
        if (parentDir) {
          parentDir.subdirectories.push(dir)
        }
      }
    })

    return enrichedDirs.filter(dir => !dir.parent || dir.parent === '')
  }

  const treeStructure = buildTree(directories)

  return (
    <div className="space-y-1">
      {isReadOnly && (
        <div className="text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200/50 p-1.5 rounded flex items-center gap-1.5 mb-2">
          <MaterialIcon icon="lock" className="text-sm shrink-0" />
          <span className="font-medium">{t('快速整理只读预览，不支持微调交互')}</span>
        </div>
      )}
      {treeStructure.map((dir, index) => (
        <DirectoryNodeItem
          key={index}
          node={dir}
          level={0}
          fileMap={fileMap}
          isReadOnly={isReadOnly}
          onDeleteNode={onDeleteNode}
        />
      ))}
    </div>
  )
}

interface DirectoryNodeItemProps {
  node: DirectoryNode
  level: number
  fileMap?: Map<number, FileInfoForAI>
  isReadOnly?: boolean
  onDeleteNode?: (nodeKey: string) => void
}

const DirectoryNodeItem: React.FC<DirectoryNodeItemProps> = ({
  node,
  level,
  fileMap,
  isReadOnly = false,
  onDeleteNode
}) => {
  const [isExpanded, setIsExpanded] = useState(true)
  const [isHovered, setIsHovered] = useState(false)
  const getConfigValue = useSettingsStore.getState().getConfigValue
  const swapFileNameDisplay = getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
  // 支持临时构建的subdirectories字段（从parent链式结构转换而来）
  const nodeWithSubdirs = node as DirectoryNode & { subdirectories?: DirectoryNode[] }
  const hasSubdirectories =
    nodeWithSubdirs.subdirectories && nodeWithSubdirs.subdirectories.length > 0
  const hasFiles = node.files && node.files.length > 0
  const hasContent = hasSubdirectories || hasFiles

  const handleMouseEnter = useCallback(() => setIsHovered(true), [])
  const handleMouseLeave = useCallback(() => setIsHovered(false), [])

  return (
    <div>
      <div
        className="flex items-center py-1 px-2 hover:bg-accent/50 rounded cursor-pointer relative"
        style={{ paddingLeft: `${level * 20 + 8}px` }}
        onClick={() => setIsExpanded(!isExpanded)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {hasContent && (
          <MaterialIcon
            icon={isExpanded ? 'expand_more' : 'chevron_right'}
            className="text-muted-foreground text-sm mr-1"
          />
        )}
        {!hasContent && <span className="w-5 mr-1" />}
        <MaterialIcon icon="folder" className="text-blue-500 text-base mr-2" />
        <span className="text-sm font-medium text-foreground">{node.name}</span>
        {isReadOnly && (
          <MaterialIcon
            icon="lock"
            className="text-muted-foreground/45 text-xs ml-1.5 opacity-60"
            title={t('只读')}
          />
        )}
        <span className="ml-2 text-xs text-muted-foreground">
          {t('({count}) 个文件', { count: node.fileCount || node.files?.length || 0 })}
        </span>
        {/* 删除按钮 - hover显示 */}
        {onDeleteNode && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-destructive/10 hover:bg-destructive/20 flex items-center justify-center transition-opacity duration-200"
            style={{ opacity: isHovered ? 1 : 0 }}
            onClick={e => {
              e.stopPropagation()
              const nodeKey = `${node.name}::${node.parent || ''}`
              onDeleteNode(nodeKey)
            }}
            title={t('删除目录')}
          >
            <MaterialIcon icon="close" className="text-destructive text-xs" />
          </button>
        )}
      </div>
      {isExpanded && (
        <div>
          {/* 显示文件列表 */}
          {hasFiles && (
            <div className="ml-5">
              {node.files?.map((fileName, index) => {
                return (
                  <div
                    key={`file-${fileName}-${index}`}
                    className="flex items-center py-1 px-2 text-sm text-muted-foreground"
                    style={{ paddingLeft: `${level * 20 + 8}px` }}
                  >
                    <span className="w-5 mr-1" />
                    <MaterialIcon
                      icon="insert_drive_file"
                      className="text-muted-foreground/70 text-sm mr-2"
                    />
                    <span
                      className="truncate"
                      title={typeof fileName === 'string' ? fileName : fileName.name}
                    >
                      {typeof fileName === 'string'
                        ? fileName
                        : swapFileNameDisplay
                          ? fileName.name
                          : fileName.smartName || fileName.name}
                    </span>
                    {isReadOnly && (
                      <MaterialIcon
                        icon="lock"
                        className="text-muted-foreground/30 text-[10px] ml-1.5 opacity-50"
                        title={t('只读')}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {/* 显示子目录 */}
          {hasSubdirectories && (
            <div>
              {nodeWithSubdirs.subdirectories!.map((subdir, index) => (
                <DirectoryNodeItem
                  key={index}
                  node={subdir}
                  level={level + 1}
                  fileMap={fileMap}
                  isReadOnly={isReadOnly}
                  onDeleteNode={onDeleteNode}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
