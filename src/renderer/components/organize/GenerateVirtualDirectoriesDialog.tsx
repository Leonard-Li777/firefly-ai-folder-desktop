import { DimensionGroup, SelectedTag } from '@firefly/types'
import { MaterialIcon, cn } from '../../lib/utils'
import React, { useEffect, useState } from 'react'
import { CATEGORY_EXT_MAP } from '@firefly/shared'

import { DirectoryNode } from '@firefly/types/organize-types'
import { t } from '@app/languages'

interface DirectoryPreviewNode {
  name: string
  path: string[]
  fileCount: number
  parent?: string
  files?: Array<{ name: string; smartName?: string; path?: string }> // 修改：存储文件对象（包含智能文件名和路径）
  dimensionId?: number // 新增：标签所属维度ID
}

interface GenerateVirtualDirectoriesDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (options: {
    deduplicateFiles: boolean
    openAfterGeneration: boolean
    flattenToRoot: boolean
    skipEmptyDirectories: boolean
    enableNestedClassification: boolean // 新增：嵌套分类选项
    directoryTree: DirectoryNode[] // 新增：传递预览生成的目录树结构
    tagFileMap: Map<string, Array<{ name: string; smartName?: string; path?: string }>> // 新增：文件映射表
  }) => void
  selectedTags: Array<{
    dimensionId: number
    dimensionName: string
    tagValue: string
    fileCount: number
  }>
  dimensionGroups: DimensionGroup[]
  workspaceDirectoryPath?: string // 新增：工作目录路径，用于获取文件列表
  selectionStack: string[] // 新增：标签选择顺序栈，用于实现"后选优先"去重
}

export const GenerateVirtualDirectoriesDialog: React.FC<GenerateVirtualDirectoriesDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  selectedTags,
  dimensionGroups,
  workspaceDirectoryPath,
  selectionStack
}) => {
  // 从localStorage读取用户上次的选择，默认都勾选
  const [deduplicateFiles, setDeduplicateFiles] = useState(() => {
    const saved = localStorage.getItem('generateVirtualDir_deduplicateFiles')
    return saved !== null ? saved === 'true' : true
  })

  const [openAfterGeneration, setOpenAfterGeneration] = useState(() => {
    const saved = localStorage.getItem('generateVirtualDir_openAfterGeneration')
    return saved !== null ? saved === 'true' : true
  })

  // 平铺到虚拟目录选项，默认不勾选
  const [flattenToRoot, setFlattenToRoot] = useState(() => {
    const saved = localStorage.getItem('generateVirtualDir_flattenToRoot')
    return saved !== null ? saved === 'true' : false
  })

  // 新增：不生成空目录选项，默认勾选
  const [skipEmptyDirectories, setSkipEmptyDirectories] = useState(() => {
    const saved = localStorage.getItem('generateVirtualDir_skipEmptyDirectories')
    return saved !== null ? saved === 'true' : true
  })

  // 新增：开启多级分类嵌套选项，默认勾选
  const [enableNestedClassification, setEnableNestedClassification] = useState(() => {
    const saved = localStorage.getItem('generateVirtualDir_enableNestedClassification')
    return saved !== null ? saved === 'true' : true
  })

  // 保存用户选择到localStorage
  useEffect(() => {
    localStorage.setItem('generateVirtualDir_deduplicateFiles', String(deduplicateFiles))
  }, [deduplicateFiles])

  useEffect(() => {
    localStorage.setItem('generateVirtualDir_openAfterGeneration', String(openAfterGeneration))
  }, [openAfterGeneration])

  useEffect(() => {
    localStorage.setItem('generateVirtualDir_flattenToRoot', String(flattenToRoot))
  }, [flattenToRoot])

  useEffect(() => {
    localStorage.setItem('generateVirtualDir_skipEmptyDirectories', String(skipEmptyDirectories))
  }, [skipEmptyDirectories])

  useEffect(() => {
    localStorage.setItem(
      'generateVirtualDir_enableNestedClassification',
      String(enableNestedClassification)
    )
  }, [enableNestedClassification])

  // 新增：文件列表状态（按标签存储）- 修改为存储完整文件对象
  const [tagFileMap, setTagFileMap] = useState<
    Map<string, Array<{ name: string; smartName?: string; path?: string }>>
  >(new Map())
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)

  // 加载所有选中标签的文件列表（规则A：获取智能文件名）
  useEffect(() => {
    if (!isOpen || !workspaceDirectoryPath) return

    const loadTagFiles = async () => {
      setIsLoadingFiles(true)
      const newTagFileMap = new Map<
        string,
        Array<{ name: string; smartName?: string; path?: string }>
      >()

      try {
        // 为每个标签并发获取文件列表，优化 N+1 IPC 调用性能
        // Parallelizing IPC calls reduces total latency from O(N) to O(1) round-trips
        await Promise.all(
          selectedTags.map(async tag => {
            const files = await window.electronAPI!.analyzedDirectory.getFilteredFiles({
              selectedTags: [
                {
                  dimensionId: tag.dimensionId,
                  dimensionName: tag.dimensionName,
                  tagValue: tag.tagValue,
                  level: 0
                }
              ],
              sortBy: 'name',
              sortOrder: 'asc',
              workspaceDirectoryPath
            })

            // 存储完整文件对象（包含smartName和path用于去重）
            const fileObjects = files.map((f: any) => ({
              name: f.name || '',
              smartName: f.smartName,
              path: f.path
            }))
            newTagFileMap.set(`${tag.dimensionId}-${tag.tagValue}`, fileObjects)
          })
        )

        setTagFileMap(newTagFileMap)
      } catch (error) {
        console.error('Failed to load tag files:', error)
      } finally {
        setIsLoadingFiles(false)
      }
    }

    loadTagFiles()
  }, [isOpen, workspaceDirectoryPath, selectedTags])

  // 构建目录树预览（新逻辑：支持扁平化模式和后选优先去重）
  const buildDirectoryTree = (): DirectoryNode[] => {
    // 规则B：扁平化模式
    if (flattenToRoot) {
      // 收集所有文件，使用path去重
      const allFilesMap = new Map<string, { name: string; smartName?: string; path?: string }>()

      selectedTags.forEach(tag => {
        const tagKey = `${tag.dimensionId}-${tag.tagValue}`
        const files = tagFileMap.get(tagKey) || []

        files.forEach(file => {
          // 使用文件路径作为唯一标识，确保物理文件唯一
          const fileKey = file.path || file.name
          if (!allFilesMap.has(fileKey)) {
            allFilesMap.set(fileKey, {
              name: file.name,
              smartName: file.smartName,
              path: file.path
            }) // 重要：保留path信息
          }
        })
      })

      // 返回一个虚拟根节点，包含所有去重后的文件
      return [
        {
          name: t('虚拟目录根'),
          parent: '',
          description: t('扁平化文件列表'),
          files: Array.from(allFilesMap.values()),
          fileCount: allFilesMap.size
        }
      ]
    }

    // 树状模式
    const tagNodes = new Map<string, DirectoryNode>()

    // 第一步：为每个选中的标签创建节点
    selectedTags.forEach(tag => {
      const group = dimensionGroups.find(g => g.id === tag.dimensionId)
      if (!group) return

      const tagKey = `${tag.dimensionId}-${tag.tagValue}`
      const files = tagFileMap.get(tagKey) || []

      const node: DirectoryNode = {
        id: tagKey, // 新增：保存唯一标识
        name: tag.tagValue,
        parent: '',
        description: t('{tag}标签目录', { tag: tag.tagValue }),
        files: files.map(f => ({ name: f.name, smartName: f.smartName, path: f.path })),
        fileCount: files.length,
        // 保存标签信息供后端生成数据库记录 (串起业务逻辑)
        dimensionId: tag.dimensionId,
        dimensionName: tag.dimensionName,
        tagValue: tag.tagValue
      }

      tagNodes.set(tagKey, node)
    })

    // 第二步：根据标签选择顺序确定层级结构（串起业务逻辑）
    // 修改：同维度标签及其后代不形成嵌套关系，确保任何路径中一个维度只出现一次
    const tagParentKeys = new Map<string, string>() // tagKey -> parentKey

    // 只有在非扁平化模式且开启了嵌套分类时，才执行嵌套逻辑
    if (!flattenToRoot && enableNestedClassification && selectionStack.length > 1) {
      for (let i = 1; i < selectionStack.length; i++) {
        const childKey = selectionStack[i]
        const childNode = tagNodes.get(childKey)
        if (!childNode) continue

        // 获取当前标签的维度ID
        const childDimId = parseInt(childKey.split('-')[0])

        // 从紧邻的前一个标签开始寻找合适的父目录
        let parentKey: string | undefined = selectionStack[i - 1]

        while (parentKey) {
          // 检查候选父目录及其所有祖先，是否包含与当前标签相同的维度
          let hasDimensionConflict = false
          let runner: string | undefined = parentKey
          while (runner) {
            const runnerDimId = parseInt(runner.split('-')[0])
            if (runnerDimId === childDimId) {
              hasDimensionConflict = true
              break
            }
            runner = tagParentKeys.get(runner)
          }

          if (hasDimensionConflict) {
            // 如果存在维度冲突，则向上移动到候选父目录的父级继续寻找
            parentKey = tagParentKeys.get(parentKey)
          } else {
            // 找到一个安全的父目录
            break
          }
        }

        if (parentKey) {
          // 修改：parent 字段指向父节点的唯一标识 (ID)，而不是名称
          childNode.parent = parentKey
          tagParentKeys.set(childKey, parentKey)
        } else {
          childNode.parent = ''
          // 不设置 tagParentKeys，表示该标签是根目录
        }
      }
    }

    // 第二点半：如果存在父节点，且该节点是“题材”维度，需要根据其父级节点的标签，过滤文件类型
    tagNodes.forEach((node, tagKey) => {
      if (!node.files) return

      const isThemeNode =
        node.dimensionName === t('题材') ||
        node.dimensionName === '题材' ||
        node.dimensionName === 'Genre / Theme' ||
        (node.dimensionName &&
          (node.dimensionName.toLowerCase().includes('theme') ||
            node.dimensionName.toLowerCase().includes('genre'))) ||
        node.dimensionName === t('游戏类型') ||
        node.dimensionName === '游戏类型' ||
        node.dimensionName === 'Game Type' ||
        (node.dimensionName &&
          (node.dimensionName.toLowerCase().includes('game type') ||
            node.dimensionName.toLowerCase().includes('game genre')))
      if (!isThemeNode) return

      // 向上寻找父级或祖先节点的标签值，确定对应的物理文件分类
      let parentKey = tagParentKeys.get(tagKey)
      const allowedExtensions: string[] = []

      while (parentKey) {
        const parentNode = tagNodes.get(parentKey)
        if (parentNode) {
          const parentTagValue = parentNode.name
          const isVideoTag =
            parentTagValue === t('视频') ||
            parentTagValue === t('影视') ||
            parentTagValue === '视频' ||
            parentTagValue === '影视' ||
            parentTagValue.toLowerCase().includes('video') ||
            parentTagValue.toLowerCase().includes('movie')
          const isEbookTag =
            parentTagValue === t('电子书') ||
            parentTagValue === t('小说') ||
            parentTagValue === '电子书' ||
            parentTagValue === '小说' ||
            parentTagValue.toLowerCase().includes('ebook') ||
            parentTagValue.toLowerCase().includes('novel')
          const isGameTag =
            parentTagValue === t('游戏娱乐') ||
            parentTagValue === '游戏娱乐' ||
            parentTagValue.toLowerCase().includes('game')

          if (isEbookTag) {
            allowedExtensions.push(
              ...(CATEGORY_EXT_MAP['ebook'] || []),
              ...(CATEGORY_EXT_MAP['document'] || []),
              ...(CATEGORY_EXT_MAP['text'] || [])
            )
            break
          } else if (isGameTag) {
            allowedExtensions.push(
              ...(CATEGORY_EXT_MAP['archive'] || []),
              ...(CATEGORY_EXT_MAP['executable'] || [])
            )
            break
          } else if (isVideoTag) {
            allowedExtensions.push(
              ...(CATEGORY_EXT_MAP['video'] || []),
              ...(CATEGORY_EXT_MAP['audio'] || [])
            )
            break
          }
        }
        parentKey = tagParentKeys.get(parentKey)
      }

      if (allowedExtensions.length > 0) {
        node.files = node.files.filter((f: any) => {
          const filePath = f.path || f.name || String(f)
          const ext = '.' + filePath.split('.').pop()?.toLowerCase()
          return allowedExtensions.includes(ext)
        })
        node.fileCount = node.files.length
      }
    })

    // 第三步：规则C - 后选优先去重逻辑
    if (deduplicateFiles) {
      // 构建文件到标签的映射（一个文件可能属于多个标签）
      const fileToTagsMap = new Map<string, string[]>()

      tagNodes.forEach((node, tagKey) => {
        if (!node.files) return

        node.files?.forEach(file => {
          // 修正：使用文件路径作为唯一标识，确保物理文件唯一
          const fileKey = typeof file === 'string' ? file : file.path || file.name
          const tags = fileToTagsMap.get(fileKey) || []
          tags.push(tagKey)
          fileToTagsMap.set(fileKey, tags)
        })
      })

      // 为每个文件确定优先级最高的标签（selectionStack中索引最大的）
      const fileToWinnerTagMap = new Map<string, string>()

      fileToTagsMap.forEach((tags, fileKey) => {
        if (tags.length === 1) {
          // 只属于一个标签，直接分配
          fileToWinnerTagMap.set(fileKey, tags[0])
        } else {
          // 属于多个标签，找出selectionStack中最晚选中的
          let winnerTag = tags[0]
          let maxIndex = selectionStack.indexOf(tags[0])

          tags.forEach(tag => {
            const index = selectionStack.indexOf(tag)
            if (index > maxIndex) {
              maxIndex = index
              winnerTag = tag
            }
          })

          fileToWinnerTagMap.set(fileKey, winnerTag)
        }
      })

      // 重新分配文件到各个节点
      tagNodes.forEach((node, tagKey) => {
        if (!node.files) return

        // 只保留winner标签为当前标签的文件
        node.files = node.files?.filter(file => {
          const fileKey = typeof file === 'string' ? file : file.path || file.name
          return fileToWinnerTagMap.get(fileKey) === tagKey
        })

        node.fileCount = node.files?.length || 0
      })
    }

    // 第四步：递归过滤空目录（需求2：不生成空目录）
    let result = Array.from(tagNodes.values())
    if (skipEmptyDirectories) {
      // 递归检查节点是否为空（考虑子节点）
      const isNodeEmpty = (node: DirectoryNode, allNodes: DirectoryNode[]): boolean => {
        // 如果节点本身有文件，不为空
        if (node.files && node.files.length > 0) {
          return false
        }

        // 检查所有子节点（使用 ID 或名称进行安全匹配，并排除自身以防无限递归）
        const nodeIdentifier = node.id || node.name
        const children = allNodes.filter(n => n !== node && n.parent === nodeIdentifier)

        if (children.length === 0) {
          // 没有子节点且没有文件，为空
          return true
        }

        // 递归检查：如果所有子节点都为空，则该节点也为空
        return children.every(child => isNodeEmpty(child, allNodes))
      }

      // 过滤掉所有空节点
      result = result.filter(node => !isNodeEmpty(node, result))
    }

    return result
  }

  const directoryTree = buildDirectoryTree()
  const totalFileCount = selectedTags.reduce((sum, tag) => sum + tag.fileCount, 0)

  if (!isOpen) return null

  const handleConfirm = async () => {
    // 验证授权状态
    if (window.electronAPI?.license) {
      const statusResult = await window.electronAPI.license.getStatus()
      if (statusResult.status !== 'AUTHORIZED') {
        // 派发自定义事件，由 App.tsx 捕获并弹出 LicenseGateway
        window.dispatchEvent(new CustomEvent('app:unauthorized', { detail: statusResult }))
        return
      }
    }

    onConfirm({
      deduplicateFiles,
      openAfterGeneration,
      flattenToRoot,
      skipEmptyDirectories,
      enableNestedClassification, // 新增：传递嵌套分类选项
      directoryTree, // 传递预览生成的目录树结构
      tagFileMap // 传递文件映射表
    })
  }

  // 树形结构节点组件（修改：显示文件列表）
  const TreeNode: React.FC<{ node: DirectoryNode; level: number }> = ({ node, level }) => {
    const [isExpanded, setIsExpanded] = useState(true)

    // 构建子节点（使用 ID 或名称进行安全匹配，并排除自身）
    const nodeIdentifier = node.id || node.name
    const children = directoryTree.filter(n => n !== node && n.parent === nodeIdentifier)
    const hasChildren = children.length > 0
    const hasFiles = node.files && node.files.length > 0

    return (
      <div>
        {/* 目录节点 */}
        <div
          className="flex items-center py-1.5 px-2 hover:bg-accent dark:hover:bg-accent rounded transition-colors cursor-pointer"
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {hasChildren || hasFiles ? (
            <MaterialIcon
              icon={isExpanded ? 'expand_more' : 'chevron_right'}
              className="text-base text-muted-foreground dark:text-muted-foreground mr-1"
            />
          ) : (
            <span className="w-5 mr-1" />
          )}
          <MaterialIcon icon="folder" className="text-base text-primary dark:text-primary mr-2" />
          <span className="text-sm text-foreground dark:text-foreground flex-1">{node.name}</span>
          <span className="text-xs text-muted-foreground dark:text-muted-foreground ml-2">
            {t('{fileCount} 个文件', { fileCount: node.fileCount })}
          </span>
        </div>

        {isExpanded && (
          <div>
            {/* 渲染子目录 */}
            {hasChildren &&
              children.map((child, index) => (
                <TreeNode key={index} node={child} level={level + 1} />
              ))}

            {/* 渲染文件列表（规则A：必须显示智能文件名） */}
            {hasFiles &&
              node.files?.map((file, index) => {
                // 规则A：优先显示智能文件名，如果没有则显示原始文件名
                const displayName = typeof file === 'string' ? file : file.smartName || file.name

                return (
                  <div
                    key={`file-${index}`}
                    className="flex items-center py-1 px-2"
                    style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}
                  >
                    <span className="w-5 mr-1" />
                    <MaterialIcon
                      icon="insert_drive_file"
                      className="text-sm text-muted-foreground dark:text-muted-foreground mr-2"
                    />
                    <span className="text-xs text-foreground/80 dark:text-foreground/80">
                      {displayName}
                    </span>
                  </div>
                )
              })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col border border-border">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border dark:border-border">
          <h2 className="text-xl font-semibold text-foreground dark:text-foreground">
            {t('导出虚拟目录预览')}
          </h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-accent dark:hover:bg-accent rounded-full transition-colors"
          >
            <MaterialIcon
              icon="close"
              className="text-xl text-muted-foreground dark:text-muted-foreground"
            />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* 统计信息 */}
          <div className="mb-4 p-4 bg-muted/50 dark:bg-muted/50 rounded-lg">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground dark:text-foreground">
                {t('将创建 {count} 个虚拟目录', { count: directoryTree.length })}
              </span>
              <span className="text-muted-foreground dark:text-muted-foreground">
                {t('共 {count} 个文件', { count: totalFileCount })}
              </span>
            </div>
          </div>

          {/* 目录树预览 */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground dark:text-foreground mb-2">
              {flattenToRoot ? t('文件列表预览（扁平化）：') : t('目录结构预览：')}
            </h3>
            <div className="border border-border dark:border-border rounded-lg p-4 bg-background dark:bg-background max-h-80 overflow-y-auto">
              {isLoadingFiles ? (
                <div className="text-center py-8">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary dark:border-primary mb-2"></div>
                  <p className="text-sm text-muted-foreground dark:text-muted-foreground">
                    {t('加载文件列表中...')}
                  </p>
                </div>
              ) : flattenToRoot ? (
                // 规则B：扁平化模式 - 直接显示文件列表，不显示目录结构
                <div className="space-y-1">
                  {directoryTree[0]?.files?.map((file, index) => {
                    const displayName =
                      typeof file === 'string' ? file : file.smartName || file.name

                    return (
                      <div
                        key={`flat-file-${index}`}
                        className="flex items-center py-1 px-2 hover:bg-accent/50 dark:hover:bg-accent/50 rounded"
                      >
                        <MaterialIcon
                          icon="insert_drive_file"
                          className="text-sm text-muted-foreground dark:text-muted-foreground mr-2"
                        />
                        <span className="text-xs text-foreground/80 dark:text-foreground/80">
                          {displayName}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                // 树状模式 - 显示目录树结构
                directoryTree
                  .filter(node => !node.parent || node.parent === '')
                  .map((node, index) => <TreeNode key={index} node={node} level={0} />)
              )}
            </div>
          </div>

          {/* 选项 */}
          <div className="mt-6 space-y-3">
            {/* 平铺到虚拟目录选项 */}
            <label className="flex items-center space-x-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={flattenToRoot}
                onChange={e => setFlattenToRoot(e.target.checked)}
                className="w-4 h-4 rounded border-border dark:border-border cursor-pointer accent-primary"
              />
              <span className="text-sm text-foreground dark:text-foreground group-hover:text-primary dark:group-hover:text-primary transition-colors">
                {t('平铺到虚拟目录')}
              </span>
              <div className="relative group/tooltip">
                <MaterialIcon
                  icon="help_outline"
                  className="text-base text-muted-foreground dark:text-muted-foreground cursor-help"
                />
                <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 hidden group-hover/tooltip:block z-10 w-64 p-2 bg-popover dark:bg-popover text-popover-foreground dark:text-popover-foreground text-xs rounded-md shadow-lg border border-border dark:border-border">
                  {t('勾选后，隐藏所有目录层级，将所有文件展示为单一层级的纯文件列表（自动去重）')}
                </div>
              </div>
            </label>

            {/* 开启多级分类嵌套选项 - 只在未勾选平铺时显示 */}
            {!flattenToRoot && (
              <label className="flex items-center space-x-2 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={enableNestedClassification}
                  onChange={e => setEnableNestedClassification(e.target.checked)}
                  className="w-4 h-4 rounded border-border dark:border-border cursor-pointer accent-primary"
                />
                <span className="text-sm text-foreground dark:text-foreground group-hover:text-primary dark:group-hover:text-primary transition-colors">
                  {t('目录按勾选顺序嵌套')}
                </span>
                <div className="relative group/tooltip">
                  <MaterialIcon
                    icon="help_outline"
                    className="text-base text-muted-foreground dark:text-muted-foreground cursor-help"
                  />
                  <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 hidden group-hover/tooltip:block z-10 w-70 p-2 bg-popover dark:bg-popover text-popover-foreground dark:text-popover-foreground text-xs rounded-md shadow-lg border border-border dark:border-border">
                    {t(
                      '勾选后，点选的多个不同维度（分类）的标签将按点击顺序变成父子文件夹（如：{文件类型} > {文件用途}）。不选中时，它们将分别作为独立的一级文件夹并列显示{文件类型} {文件用途}。'
                    )}
                  </div>
                </div>
              </label>
            )}

            {/* 文件去重选项 - 只在未勾选平铺时显示 */}
            {!flattenToRoot && (
              <label className="flex items-center space-x-2 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={deduplicateFiles}
                  onChange={e => setDeduplicateFiles(e.target.checked)}
                  className="w-4 h-4 rounded border-border dark:border-border cursor-pointer accent-primary"
                />
                <span className="text-sm text-foreground dark:text-foreground group-hover:text-primary dark:group-hover:text-primary transition-colors">
                  {t('文件去重')}
                </span>
                <div className="relative group/tooltip">
                  <MaterialIcon
                    icon="help_outline"
                    className="text-base text-muted-foreground dark:text-muted-foreground cursor-help"
                  />
                  <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 hidden group-hover/tooltip:block z-10 w-80 p-2 bg-popover dark:bg-popover text-popover-foreground dark:text-popover-foreground text-xs rounded-md shadow-lg border border-border dark:border-border">
                    {t(
                      '勾选后，同一文件在整个虚拟目录树中仅出现一次。采用"后选优先"原则：文件归属到最后勾选的标签目录（例如：先选A后选B，文件归入B目录）。未勾选时，文件可在多个标签目录下重复显示。'
                    )}
                  </div>
                </div>
              </label>
            )}

            {/* 新增：不生成空目录选项 */}
            <label className="flex items-center space-x-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={skipEmptyDirectories}
                onChange={e => setSkipEmptyDirectories(e.target.checked)}
                className="w-4 h-4 rounded border-border dark:border-border cursor-pointer accent-primary"
              />
              <span className="text-sm text-foreground dark:text-foreground group-hover:text-primary dark:group-hover:text-primary transition-colors">
                {t('不生成空目录')}
              </span>
              <div className="relative group/tooltip">
                <MaterialIcon
                  icon="help_outline"
                  className="text-base text-muted-foreground dark:text-muted-foreground cursor-help"
                />
                <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 hidden group-hover/tooltip:block z-10 w-64 p-2 bg-popover dark:bg-popover text-popover-foreground dark:text-popover-foreground text-xs rounded-md shadow-lg border border-border dark:border-border">
                  {t('勾选后，预览和最终生成的虚拟目录都不会包含没有文件的空目录')}
                </div>
              </div>
            </label>

            {/* 生成后打开目录选项 */}
            <label className="flex items-center space-x-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={openAfterGeneration}
                onChange={e => setOpenAfterGeneration(e.target.checked)}
                className="w-4 h-4 rounded border-border dark:border-border cursor-pointer accent-primary"
              />
              <span className="text-sm text-foreground dark:text-foreground group-hover:text-primary dark:group-hover:text-primary transition-colors">
                {t('生成后打开虚拟目录')}
              </span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end space-x-3 p-6 border-t border-border dark:border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-foreground bg-background border border-border rounded-md hover:bg-accent transition-colors"
          >
            {t('取消')}
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 text-sm font-medium text-white bg-primary dark:bg-primary rounded-md hover:bg-primary/90 dark:hover:bg-primary/90 transition-colors"
          >
            {t('确认生成')}
          </button>
        </div>
      </div>
    </div>
  )
}
