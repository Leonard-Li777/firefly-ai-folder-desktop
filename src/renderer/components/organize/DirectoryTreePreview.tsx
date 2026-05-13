import React, { useState } from 'react'
import { DirectoryNode, FileInfoForAI } from '@yonuc/types/organize-types'
import { MaterialIcon } from '../../lib/utils'
import { t } from '@app/languages'

interface DirectoryTreePreviewProps {
  directories: DirectoryNode[]
  fileMap?: Map<number, FileInfoForAI>  // 文件ID到文件信息的映射
}

/**
 * 目录树预览组件
 * 用于在整理前显示目录结构预览
 * 支持parent链式结构
 */
export const DirectoryTreePreview: React.FC<DirectoryTreePreviewProps> = ({ directories, fileMap }) => {
  // 参数验证：确保directories是有效的数组
  if (!directories || !Array.isArray(directories)) {
    return (
      <div className="text-muted-foreground text-sm">
        {t('暂无目录结构预览')}
      </div>
    )
  }

  if (directories.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        {t('目录结构为空')}
      </div>
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
      {treeStructure.map((dir, index) => (
        <DirectoryNodeItem key={index} node={dir} level={0} fileMap={fileMap} />
      ))}
    </div>
  )
}

interface DirectoryNodeItemProps {
  node: DirectoryNode
  level: number
  fileMap?: Map<number, FileInfoForAI>
}

const DirectoryNodeItem: React.FC<DirectoryNodeItemProps> = ({ node, level, fileMap }) => {
  const [isExpanded, setIsExpanded] = useState(true)
  // 支持临时构建的subdirectories字段（从parent链式结构转换而来）
  const nodeWithSubdirs = node as DirectoryNode & { subdirectories?: DirectoryNode[] }
  const hasSubdirectories = nodeWithSubdirs.subdirectories && nodeWithSubdirs.subdirectories.length > 0
  const hasFiles = node.files && node.files.length > 0
  const hasContent = hasSubdirectories || hasFiles

  return (
    <div>
      <div
        className="flex items-center py-1 px-2 hover:bg-accent/50 rounded cursor-pointer"
        style={{ paddingLeft: `${level * 20 + 8}px` }}
        onClick={() => setIsExpanded(!isExpanded)}
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
        <span className="ml-2 text-xs text-muted-foreground">
          {t('({count}) 个文件', { count: node.fileCount || node.files?.length || 0 })}
        </span>
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
                    <MaterialIcon icon="insert_drive_file" className="text-muted-foreground/70 text-sm mr-2" />
                    <span className="truncate" title={typeof fileName === 'string' ? fileName : fileName.name}>
                      {typeof fileName === 'string' ? fileName : (fileName.smartName || fileName.name)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {/* 显示子目录 */}
          {hasSubdirectories && (
            <div>
              {nodeWithSubdirs.subdirectories!.map((subdir, index) => (
                <DirectoryNodeItem key={index} node={subdir} level={level + 1} fileMap={fileMap} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

