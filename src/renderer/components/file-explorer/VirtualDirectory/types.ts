import {
  AIDirectoryStructure,
  BatchProgress,
  ConflictResolutionOptions,
  DirectoryNode,
  FileConflict,
  FileInfoForAI,
  OrganizeStatistics,
  WorkspaceDirectory,
  DimensionGroup,
  DimensionTag
} from '@firefly/types'

export interface VirtualDirectoryProps {
  onFileSelect?: (files: any[], isFromCheckbox?: boolean) => void
}

export interface DimensionTreeNode extends DimensionGroup {
  id: number
  name: string
  children?: DimensionTreeNode[]
  childTags?: Map<string, DimensionTreeNode[]> // 标签 -> 子维度映射
  level: number
}

export interface OrganizeProgress {
  currentFile: string
  processedCount: number
  totalCount: number
  percentage: number
  estimatedTimeRemaining: number
}

export interface OrganizePreview {
  fileCount: number
  directoryStructure: DirectoryNode[]
}
