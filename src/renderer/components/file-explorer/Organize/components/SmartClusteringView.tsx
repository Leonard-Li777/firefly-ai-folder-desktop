import React, { useState, useEffect, useCallback, useImperativeHandle } from 'react'
import { VirtualDirectoryNode } from '@firefly/types'
import { SENTINEL_NAMES } from '@firefly/shared'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { Button } from '../../../ui/button'
import { Badge } from '../../../ui/badge'
import { Textarea } from '../../../ui/textarea'
import { VDirTree } from './VDirTree'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { isUnclassifiedNodeName } from '../utils/helpers'
import {
  reconcileClusteringWithUserEdits,
  UserAddedDirectoryItem,
  UserMovedFileItem,
  getNodeKey,
  getFileUniqueId
} from '../utils/reconcile-clustering'

import { useOrganizeStore } from '../../../../stores/organize-store'

/**
 * 智能聚类视图命令式句柄。
 * 「保存为虚拟目录」主操作按钮已统一迁至面包屑栏右侧，保存动作经此句柄触发，
 * 完整沿用视图内部命名规则（提示词优先、默认名兜底）与防重复保存逻辑。
 */
export type ClusteringMode = 'precise' | 'balanced' | 'complete'

/**
 * 根据文件数量 N 动态平滑推导推荐聚类参数 (Spec v2.1 §3.3)
 */
export function computeAdaptiveClusteringParams(fileCount: number): {
  maxDepth: number
  maxRootDirectories: number
  maxSubdirectories: number
} {
  const n = Math.max(1, fileCount || 0)
  const maxRoots = Math.max(3, Math.min(20, Math.round(Math.sqrt(n) * 0.8)))
  const maxSubdirs = Math.max(2, Math.min(12, Math.round(Math.sqrt(n) * 0.6)))
  const maxDepth = n > 500 ? 4 : (n > 100 ? 3 : 2)
  return { maxDepth, maxRootDirectories: maxRoots, maxSubdirectories: maxSubdirs }
}

export interface SmartClusteringViewHandle {
  save: () => void | Promise<void>
}

export interface SmartClusteringViewProps {
  workspaceId?: number
  workspaceDirectoryPath: string
  fileIds?: number[]
  onSaveVirtualDirectory: (name: string, tree: VirtualDirectoryNode[]) => Promise<void>
  /** 保存按钮可用态/保存中态变更上报，供面包屑栏右侧按钮同步禁用与「正在保存...」文案 */
  onSaveStateChange?: (state: { canSave: boolean; isSaving: boolean }) => void
  onBack?: () => void
}

/**
 * 6 组精选场景示例词。
 * 必须通过函数动态返回，确保切换语言后示例词实时刷新（静态字面量中的 t() 不会响应语言变更）。
 */
function getPresetExamplePrompts(): string[] {
  return [
    t('按年份与财务类型归类'),
    t('按项目与设计稿归档'),
    t('个人学习与技术笔记'),
    t('合同与商务往来凭据'),
    t('媒体素材与拍摄产出'),
    t('会议纪要与周报总结')
  ]
}

function getSimilarityLabel(percent: number): string {
  if (percent > 75) return `${percent}% (${t('精细匹配')})`
  if (percent < 40) return `${percent}% (${t('松散匹配')})`
  return `${percent}% (${t('标准匹配')})`
}

function getSubdirectoryLabel(count: number): string {
  if (count <= 1) return t('仅一级')
  return t('≤ {count} 个', { count })
}

function getRootDirectoryLabel(count: number): string {
  return t('≤ {count} 个', { count })
}

function getMaxDepthLabel(depth: number): string {
  return t('{depth} 级', { depth })
}

/** 本地日期戳 YYYYMMDD（避免 toLocaleDateString 产生斜杠污染目录名） */
function formatDateStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/**
 * 虚拟目录默认命名策略（ADR-0056 §5）：
 * 用户提示词 → 最大簇 Top-1 主题词 + “整理” → “智能聚类整理_YYYYMMDD”。
 */
function pickDefaultVirtualDirectoryName(
  prompt: string,
  tree: VirtualDirectoryNode[]
): string {
  const trimmed = prompt.trim()
  if (trimmed) return trimmed

  const candidates: Array<{ name: string; fileCount: number }> = []
  const collect = (nodes: VirtualDirectoryNode[]) => {
    for (const node of nodes) {
      if (node?.name) {
        candidates.push({ name: node.name, fileCount: node.fileCount || 0 })
      }
      if (node?.subdirectories?.length) collect(node.subdirectories)
    }
  }
  collect(tree)

  candidates.sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name))
  const largest = candidates.find(
    item =>
      item.fileCount > 0 &&
      item.name !== '其他' && // locale-invariant-ok: Omni 聚类兜底目录名哨兵
      item.name !== SENTINEL_NAMES.UNCLASSIFIED
  )
  if (largest) {
    return t('{name} 整理', { name: largest.name })
  }
  return t('智能聚类整理_{date}', { date: formatDateStamp() })
}

const SmartClusteringViewInner = (
  {
    workspaceId,
    workspaceDirectoryPath,
    fileIds,
    onSaveVirtualDirectory,
    onSaveStateChange,
    onBack
  }: SmartClusteringViewProps,
  ref: React.Ref<SmartClusteringViewHandle>
) => {
  const initialCount = fileIds?.length || 0
  const initialAdaptive = initialCount > 0
    ? computeAdaptiveClusteringParams(initialCount)
    : { maxDepth: 3, maxRootDirectories: 5, maxSubdirectories: 5 }
  const [prompt, setPrompt] = useState<string>('')
  const [maxDepth, setMaxDepth] = useState<number>(initialAdaptive.maxDepth)
  const [maxRootDirectories, setMaxRootDirectories] = useState<number>(initialAdaptive.maxRootDirectories)
  const [maxSubdirectories, setMaxSubdirectories] = useState<number>(initialAdaptive.maxSubdirectories)
  const [similarityThreshold, setSimilarityThreshold] = useState<number>(60)
  const [clusteringMode, setClusteringMode] = useState<ClusteringMode>('balanced')
  const hasUserModifiedSlidersRef = React.useRef<boolean>(false)

  const presetExamplePrompts = getPresetExamplePrompts()
  const [tree, setTree] = useState<VirtualDirectoryNode[]>([])
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [isTreeDirty, setIsTreeDirty] = useState<boolean>(false)
  const [summary, setSummary] = useState<string>('')
  const [durationMs, setDurationMs] = useState<number>(0)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [isSaving, setIsSaving] = useState<boolean>(false)

// 自动融合模式：已移除侵入式弹窗

  // 用户手动微调记忆（增、删、改），供聚类重算时融合保留
  const userAddedDirsRef = React.useRef<UserAddedDirectoryItem[]>([])
  const userDeletedDirsRef = React.useRef<Set<string>>(new Set())
  const userRenamedDirsRef = React.useRef<Map<string, string>>(new Map())
  const userMovedFilesRef = React.useRef<Map<string, UserMovedFileItem>>(new Map())

  const isFirstMount = React.useRef(true)
  const currentRequestIdRef = React.useRef<number>(0)

  // 记录最近一次已提交并在跑或跑完的有效参数
  const lastCommittedParamsRef = React.useRef({
    prompt: '',
    maxDepth: initialAdaptive.maxDepth,
    maxRootDirectories: initialAdaptive.maxRootDirectories,
    maxSubdirectories: initialAdaptive.maxSubdirectories,
    similarityThreshold: 60,
    clusteringMode: 'balanced' as ClusteringMode
  })

  // 引用最新参数，供 executeClustering 使用
  const maxDepthRef = React.useRef(maxDepth)
  maxDepthRef.current = maxDepth
  const maxRootDirectoriesRef = React.useRef(maxRootDirectories)
  maxRootDirectoriesRef.current = maxRootDirectories
  const maxSubdirectoriesRef = React.useRef(maxSubdirectories)
  maxSubdirectoriesRef.current = maxSubdirectories
  const similarityThresholdRef = React.useRef(similarityThreshold)
  similarityThresholdRef.current = similarityThreshold
  const clusteringModeRef = React.useRef(clusteringMode)
  clusteringModeRef.current = clusteringMode

  // 始终持有最新 props 引用，确保 executeClustering 句柄永久稳定，杜绝父组件渲染导致死循环重聚类
  const paramsRef = React.useRef({ workspaceId, workspaceDirectoryPath, fileIds })
  paramsRef.current = { workspaceId, workspaceDirectoryPath, fileIds }

  // 执行聚类请求核心函数
  const executeClustering = useCallback(
    async (
      userPrompt: string,
      customOptions?: {
        maxDepth?: number
        maxRootDirectories?: number
        maxSubdirectories?: number
        similarityThreshold?: number
        clusteringMode?: ClusteringMode
      }
    ) => {
      const requestId = ++currentRequestIdRef.current
      setIsGenerating(true)
      setErrorMsg('')
      try {
        const { workspaceId: wsId, workspaceDirectoryPath: wsPath, fileIds: fIds } = paramsRef.current
        const effectiveDepth = customOptions?.maxDepth ?? maxDepthRef.current
        const effectiveRoots = customOptions?.maxRootDirectories ?? maxRootDirectoriesRef.current
        const effectiveSubdirs = customOptions?.maxSubdirectories ?? maxSubdirectoriesRef.current
        const effectiveSim = customOptions?.similarityThreshold ?? (similarityThresholdRef.current / 100)
        const effectiveMode = customOptions?.clusteringMode ?? clusteringModeRef.current

        const res = await window.electronAPI.organizeRealDirectory.smartClusterHac({
          workspaceId: wsId,
          workspaceDirectoryPath: wsPath,
          fileIds: fIds,
          prompt: userPrompt.trim(),
          maxDepth: effectiveDepth,
          maxRootDirectories: effectiveRoots,
          maxSubdirectories: effectiveSubdirs,
          similarityThreshold: effectiveSim,
          clusteringMode: effectiveMode,
          force: useOrganizeStore.getState().bypassCapacityLimit
        })

        // 若请求已过时（用户后续输入已触发新请求），丢弃该次响应
        if (requestId !== currentRequestIdRef.current) {
          return
        }

        if (!res || !res.success) {
          setErrorMsg(res?.summary || t('智能聚类执行失败或有效向量文件数不足'))
          setTree([])
          setSummary('')
          setDurationMs(0)
        } else {
          const rawDirs = res.directories || []
          const mergedTree = reconcileClusteringWithUserEdits(rawDirs, {
            addedNodes: userAddedDirsRef.current,
            deletedNodeKeys: userDeletedDirsRef.current,
            renamedNodes: userRenamedDirsRef.current,
            pinnedFiles: userMovedFilesRef.current
          })

          // 后置滑块同步：若因自定义节点或子目录提升为根导致实际数量超出滑块设定，静默向上对齐
          const businessRoots = mergedTree.filter(
            n => !(n as any).isUnclassified && !isUnclassifiedNodeName(n.name)
          ).length
          if (businessRoots > maxRootDirectoriesRef.current) {
            const clamped = Math.min(100, businessRoots)
            setMaxRootDirectories(clamped)
            maxRootDirectoriesRef.current = clamped
            lastCommittedParamsRef.current.maxRootDirectories = clamped
          }

          let maxSub = 0
          let maxD = 1
          const checkTreeBounds = (nodes: VirtualDirectoryNode[], depth = 1) => {
            if (depth > maxD) maxD = depth
            for (const n of nodes) {
              const subs = (n.subdirectories || []).filter(
                s => !(s as any).isUnclassified && !isUnclassifiedNodeName(s.name)
              )
              if (subs.length > maxSub) maxSub = subs.length
              if (subs.length > 0) checkTreeBounds(subs, depth + 1)
            }
          }
          checkTreeBounds(mergedTree, 1)

          if (maxSub > maxSubdirectoriesRef.current) {
            const clamped = Math.min(100, maxSub)
            setMaxSubdirectories(clamped)
            maxSubdirectoriesRef.current = clamped
            lastCommittedParamsRef.current.maxSubdirectories = clamped
          }
          if (maxD > maxDepthRef.current) {
            const clamped = Math.min(10, maxD)
            setMaxDepth(clamped)
            maxDepthRef.current = clamped
            lastCommittedParamsRef.current.maxDepth = clamped
          }

          setTree(mergedTree)
          setSummary(res.summary || '')
          setDurationMs(res.durationMs || 0)
          const hasCustomizations =
            userAddedDirsRef.current.length > 0 ||
            userDeletedDirsRef.current.size > 0 ||
            userRenamedDirsRef.current.size > 0 ||
            userMovedFilesRef.current.size > 0
          setIsTreeDirty(hasCustomizations)
        }
      } catch (err: any) {
        if (requestId === currentRequestIdRef.current) {
          setErrorMsg(err?.message || t('智能聚类调用异常'))
        }
      } finally {
        if (requestId === currentRequestIdRef.current) {
          setIsGenerating(false)
        }
      }
    },
    []
  )

  // 首启自动生成基准聚类（通过 workspaceKey 守卫，仅工作区或待整理集合实质变动时初始化一次，杜绝重复渲染死循环）
  const fileIdsKey = Array.isArray(fileIds) ? fileIds.join(',') : ''
  const workspaceKey = `${workspaceId ?? ''}::${workspaceDirectoryPath ?? ''}::${fileIdsKey}`
  const lastInitializedKeyRef = React.useRef<string | null>(null)

  useEffect(() => {
    if (lastInitializedKeyRef.current !== workspaceKey) {
      lastInitializedKeyRef.current = workspaceKey
      const initialCount = fileIds?.length || 0
      const adaptive = !hasUserModifiedSlidersRef.current && initialCount > 0
        ? computeAdaptiveClusteringParams(initialCount)
        : { maxDepth: maxDepthRef.current, maxRootDirectories: maxRootDirectoriesRef.current, maxSubdirectories: maxSubdirectoriesRef.current }

      if (!hasUserModifiedSlidersRef.current && initialCount > 0) {
        setMaxDepth(adaptive.maxDepth)
        setMaxRootDirectories(adaptive.maxRootDirectories)
        setMaxSubdirectories(adaptive.maxSubdirectories)
      }

      lastCommittedParamsRef.current = {
        prompt: '',
        maxDepth: adaptive.maxDepth,
        maxRootDirectories: adaptive.maxRootDirectories,
        maxSubdirectories: adaptive.maxSubdirectories,
        similarityThreshold: 60,
        clusteringMode: 'balanced'
      }
      executeClustering('', {
        maxDepth: adaptive.maxDepth,
        maxRootDirectories: adaptive.maxRootDirectories,
        maxSubdirectories: adaptive.maxSubdirectories,
        similarityThreshold: 0.6,
        clusteringMode: 'balanced'
      })
    }
  }, [workspaceKey, executeClustering])

  // 聚类参数防抖联动 (400ms)（全自动静默融合模式：无需拦截 isTreeDirty）
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false
      return
    }
    const timer = setTimeout(() => {
      const last = lastCommittedParamsRef.current
      if (
        prompt.trim() !== last.prompt ||
        maxDepth !== last.maxDepth ||
        maxRootDirectories !== last.maxRootDirectories ||
        maxSubdirectories !== last.maxSubdirectories ||
        similarityThreshold !== last.similarityThreshold ||
        clusteringMode !== last.clusteringMode
      ) {
        lastCommittedParamsRef.current = {
          prompt: prompt.trim(),
          maxDepth,
          maxRootDirectories,
          maxSubdirectories,
          similarityThreshold,
          clusteringMode
        }
        executeClustering(prompt, {
          maxDepth,
          maxRootDirectories,
          maxSubdirectories,
          similarityThreshold: similarityThreshold / 100,
          clusteringMode
        })
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [prompt, maxDepth, maxRootDirectories, maxSubdirectories, similarityThreshold, clusteringMode, executeClustering])

  // 用户请求触发聚类（全自动静默融合，保留用户修改）
  const handleRequestClustering = (targetPrompt: string) => {
    setPrompt(targetPrompt)
    lastCommittedParamsRef.current.prompt = targetPrompt.trim()
    executeClustering(targetPrompt)
  }

  const handleSliderChange = (
    setter: (val: number) => void,
    name: 'maxDepth' | 'maxRootDirectories' | 'maxSubdirectories' | 'similarityThreshold',
    val: number
  ) => {
    // 标记用户已手动调节过滑块，后续不再被自适应默认值重置
    hasUserModifiedSlidersRef.current = true
    setter(val)
  }

  const handleModeChange = (mode: ClusteringMode) => {
    if (mode === clusteringMode) return
    setClusteringMode(mode)
    lastCommittedParamsRef.current.clusteringMode = mode
    executeClustering(prompt, { clusteringMode: mode })
  }

  // 清空手动微调账本
  const handleClearCustomizations = useCallback(() => {
    userAddedDirsRef.current = []
    userDeletedDirsRef.current.clear()
    userRenamedDirsRef.current.clear()
    userMovedFilesRef.current.clear()
    setIsTreeDirty(false)
    executeClustering(prompt)
    toast.info(t('已清空手动微调'))
  }, [executeClustering, prompt])

  // 目录树内联节点微调回调（变更即置 isTreeDirty = true）
  const handleRenameNode = useCallback((nodeKey: string, newName: string) => {
    const trimmed = newName.trim()
    if (!trimmed) return

    if (trimmed.includes('/') || trimmed.includes('\\')) {
      toast.warning(t('目录名称不能包含斜杠字符'))
      return
    }

    // 1. 如果该节点是用户自定义新建的目录
    const addedItemIndex = userAddedDirsRef.current.findIndex(item => {
      const itemKey = item.parentKey ? `${item.parentKey}/${item.name}` : item.name
      return itemKey === nodeKey
    })

    if (addedItemIndex !== -1) {
      const addedItem = userAddedDirsRef.current[addedItemIndex]
      const oldItemKey = addedItem.parentKey ? `${addedItem.parentKey}/${addedItem.name}` : addedItem.name
      const newItemKey = addedItem.parentKey ? `${addedItem.parentKey}/${trimmed}` : trimmed

      // 更新自身
      addedItem.name = trimmed
      addedItem.node.name = trimmed

      // 级联更新子节点的 parentKey
      for (const item of userAddedDirsRef.current) {
        if (item.parentKey === oldItemKey) {
          item.parentKey = newItemKey
        } else if (item.parentKey.startsWith(`${oldItemKey}/`)) {
          item.parentKey = item.parentKey.replace(oldItemKey, newItemKey)
        }
      }

      // 级联更新 pinnedFiles 的目标节点 key
      for (const [fId, pItem] of userMovedFilesRef.current.entries()) {
        if (pItem.targetNodeKey === oldItemKey) {
          userMovedFilesRef.current.set(fId, { ...pItem, targetNodeKey: newItemKey })
        } else if (pItem.targetNodeKey.startsWith(`${oldItemKey}/`)) {
          userMovedFilesRef.current.set(fId, {
            ...pItem,
            targetNodeKey: pItem.targetNodeKey.replace(oldItemKey, newItemKey)
          })
        }
      }
    } else {
      // 2. 如果是 AI 聚类生成的目录，做反向溯源与键名归一化（支持连续重命名）
      let rawKey = nodeKey
      for (const [orig, mapped] of userRenamedDirsRef.current.entries()) {
        if (mapped === nodeKey || orig === nodeKey) {
          rawKey = orig
          break
        }
      }

      userRenamedDirsRef.current.set(rawKey, trimmed)

      // 级联更新 pinnedFiles 的目标节点 key
      for (const [fId, pItem] of userMovedFilesRef.current.entries()) {
        if (pItem.targetNodeKey === nodeKey) {
          userMovedFilesRef.current.set(fId, { ...pItem, targetNodeKey: trimmed })
        } else if (pItem.targetNodeKey.startsWith(`${nodeKey}/`)) {
          userMovedFilesRef.current.set(fId, {
            ...pItem,
            targetNodeKey: pItem.targetNodeKey.replace(nodeKey, trimmed)
          })
        }
      }

      // 级联更新 addedNodes 中挂载在此目录下的子目录的 parentKey
      for (const item of userAddedDirsRef.current) {
        if (item.parentKey === nodeKey) {
          item.parentKey = trimmed
        } else if (item.parentKey.startsWith(`${nodeKey}/`)) {
          item.parentKey = item.parentKey.replace(nodeKey, trimmed)
        }
      }
    }

    const updateNodes = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return nodes.map(node => {
        const curKey = getNodeKey(node)
        if (curKey === nodeKey) {
          return { ...node, name: trimmed }
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
    // 1. 判断是否属于用户自定义新建的目录
    const isAddedNode = userAddedDirsRef.current.some(item => {
      const itemKey = item.parentKey ? `${item.parentKey}/${item.name}` : item.name
      return itemKey === nodeKey || itemKey.startsWith(`${nodeKey}/`)
    })

    if (isAddedNode) {
      // 自定义目录直接从 addedNodes 移除，不进入 deletedNodeKeys 黑名单（防误杀同名 AI 簇）
      userAddedDirsRef.current = userAddedDirsRef.current.filter(item => {
        const itemKey = item.parentKey ? `${item.parentKey}/${item.name}` : item.name
        return itemKey !== nodeKey && !itemKey.startsWith(`${nodeKey}/`)
      })
    } else {
      // 只有 AI 簇被删除时才加入黑名单
      userDeletedDirsRef.current.add(nodeKey)
    }

    // 2. 清理重命名映射
    userRenamedDirsRef.current.delete(nodeKey)
    for (const [origKey, val] of userRenamedDirsRef.current.entries()) {
      if (val === nodeKey || origKey === nodeKey || origKey.startsWith(`${nodeKey}/`)) {
        userRenamedDirsRef.current.delete(origKey)
      }
    }

    // 3. 级联清理指向该目录及其子树的所有 pinnedFiles 记录
    for (const [fId, item] of userMovedFilesRef.current.entries()) {
      if (item.targetNodeKey === nodeKey || item.targetNodeKey.startsWith(`${nodeKey}/`)) {
        userMovedFilesRef.current.delete(fId)
      }
    }

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
    const trimmed = subdirName.trim()
    if (!trimmed) return

    if (trimmed.includes('/') || trimmed.includes('\\')) {
      toast.warning(t('目录名称不能包含斜杠字符'))
      return
    }

    let adjustedSlider = false

    const isSentinel = (node: VirtualDirectoryNode) =>
      !!(node as any).isUnclassified || isUnclassifiedNodeName(node.name)

    if (!parentKey) {
      // 1. 新建根目录：计算有效业务根目录数（排除未归类等哨兵节点）
      const currentBusinessRoots = tree.filter(n => !isSentinel(n)).length
      if (currentBusinessRoots >= 100) {
        toast.warning(t('已达到最大目录数量上限'))
        return
      }

      const newRootsCount = currentBusinessRoots + 1
      if (newRootsCount > maxRootDirectoriesRef.current) {
        const nextVal = Math.min(100, newRootsCount)
        setMaxRootDirectories(nextVal)
        maxRootDirectoriesRef.current = nextVal
        lastCommittedParamsRef.current.maxRootDirectories = nextVal
        adjustedSlider = true
      }

      const newRoot: VirtualDirectoryNode = {
        name: trimmed,
        parent: null,
        fileCount: 0,
        totalSize: 0,
        files: [],
        subdirectories: []
      }

      userAddedDirsRef.current.push({
        parentKey: '',
        name: trimmed,
        node: newRoot
      })

      setTree(prev => [...prev, newRoot])
      setIsTreeDirty(true)

      if (adjustedSlider) {
        toast.info(t('已自动调整滑块目录数量以适应新增加的目录'))
      }
      return
    }

    // 2. 新建子目录
    let currentSubCount = 0
    const findParentSubCount = (nodes: VirtualDirectoryNode[]) => {
      for (const node of nodes) {
        const curKey = getNodeKey(node)
        if (curKey === parentKey) {
          currentSubCount = (node.subdirectories || []).filter(s => !isSentinel(s)).length
          return
        }
        if (node.subdirectories && node.subdirectories.length > 0) {
          findParentSubCount(node.subdirectories)
        }
      }
    }
    findParentSubCount(tree)

    const targetDepth = parentKey.split('/').length + 1
    if (targetDepth > 10) {
      toast.warning(t('已达到最大目录层级上限'))
      return
    }
    if (currentSubCount >= 100) {
      toast.warning(t('已达到最大目录数量上限'))
      return
    }

    const newSubCount = currentSubCount + 1
    if (newSubCount > maxSubdirectoriesRef.current) {
      const nextVal = Math.min(100, newSubCount)
      setMaxSubdirectories(nextVal)
      maxSubdirectoriesRef.current = nextVal
      lastCommittedParamsRef.current.maxSubdirectories = nextVal
      adjustedSlider = true
    }

    if (targetDepth > maxDepthRef.current) {
      const nextDepth = Math.min(10, targetDepth)
      setMaxDepth(nextDepth)
      maxDepthRef.current = nextDepth
      lastCommittedParamsRef.current.maxDepth = nextDepth
    }

    const newSub: VirtualDirectoryNode = {
      name: trimmed,
      parent: parentKey,
      fileCount: 0,
      totalSize: 0,
      files: [],
      subdirectories: []
    }

    userAddedDirsRef.current.push({
      parentKey,
      name: trimmed,
      node: newSub
    })

    const insertSubdir = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return nodes.map(node => {
        const curKey = getNodeKey(node)
        if (curKey === parentKey) {
          return {
            ...node,
            subdirectories: [...(node.subdirectories || []), newSub]
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

    if (adjustedSlider) {
      toast.info(t('已自动调整滑块目录数量以适应新增加的目录'))
    }
  }, [tree])

  const handleMoveNodeOrFile = useCallback((source: any, targetNodeKey: string) => {
    if (source.type === 'file' && source.file) {
      const fId = getFileUniqueId(source.file)
      userMovedFilesRef.current.set(fId, {
        file: source.file,
        targetNodeKey
      })
    }

    setTree(prev => {
      let targetFile: any = null

      const removeFromAll = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          let files = node.files || []
          if (source.type === 'file') {
            const found = files.find(f => (f.id ?? f.name) === (source.file?.id ?? source.file?.name))
            if (found) {
              targetFile = found
              files = files.filter(f => (f.id ?? f.name) !== (source.file?.id ?? source.file?.name))
            }
          }
          const subdirs = node.subdirectories ? removeFromAll(node.subdirectories) : []
          return { ...node, files, subdirectories: subdirs }
        })
      }

      const addFileToTarget = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          const curKey = getNodeKey(node)
          if (curKey === targetNodeKey && targetFile) {
            return {
              ...node,
              files: [...(node.files || []), targetFile]
            }
          }
          if (node.subdirectories && node.subdirectories.length > 0) {
            return { ...node, subdirectories: addFileToTarget(node.subdirectories) }
          }
          return node
        })
      }

      const recomputeFileCounts = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          const subdirs = recomputeFileCounts(node.subdirectories || [])
          const files = node.files || []
          const fileCount =
            files.length + subdirs.reduce((sum, sub) => sum + (sub.fileCount || 0), 0)
          return { ...node, files, subdirectories: subdirs, fileCount }
        })
      }

      return recomputeFileCounts(addFileToTarget(removeFromAll(prev)))
    })
    setIsTreeDirty(true)
  }, [])

  // 解锁被用户手动固定的文件，交还 AI 重新聚类
  const handleUnpinFile = useCallback((file: any) => {
    const fId = getFileUniqueId(file)
    userMovedFilesRef.current.delete(fId)

    const updatePinnedInTree = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      return nodes.map(node => ({
        ...node,
        files: (node.files || []).map(f =>
          getFileUniqueId(f) === fId ? { ...f, isPinned: false } : f
        ),
        subdirectories: node.subdirectories ? updatePinnedInTree(node.subdirectories) : []
      }))
    }
    setTree(prev => updatePinnedInTree(prev))

    const hasCustomizations =
      userAddedDirsRef.current.length > 0 ||
      userDeletedDirsRef.current.size > 0 ||
      userRenamedDirsRef.current.size > 0 ||
      userMovedFilesRef.current.size > 0
    setIsTreeDirty(hasCustomizations)
    toast.success(t('已解锁文件，下次重新聚类时将交还 AI 自动整理'))
  }, [])

  // 保存为虚拟目录
  const handleSave = async () => {
    if (tree.length === 0 || isSaving) return
    setIsSaving(true)
    try {
      const vdirName = pickDefaultVirtualDirectoryName(prompt, tree)
      await onSaveVirtualDirectory(vdirName, tree)
    } finally {
      setIsSaving(false)
    }
  }

  // 暴露保存动作给面包屑栏右侧按钮（命令式触发，逻辑仍收敛在本视图内）
  useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave])

  // 保存按钮可用态/保存中态上报，驱动面包屑栏按钮的禁用与「正在保存...」文案
  const lastReportedStateRef = React.useRef<{ canSave: boolean; isSaving: boolean }>({ canSave: false, isSaving: false })
  useEffect(() => {
    const nextCanSave = tree.length > 0 && !isGenerating && !isSaving
    if (
      lastReportedStateRef.current.canSave !== nextCanSave ||
      lastReportedStateRef.current.isSaving !== isSaving
    ) {
      lastReportedStateRef.current = { canSave: nextCanSave, isSaving }
      onSaveStateChange?.({ canSave: nextCanSave, isSaving })
    }
  }, [tree.length, isGenerating, isSaving, onSaveStateChange])

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full w-full overflow-hidden bg-background">
      {/* ─── 左栏：通俗直白意图输入、微调滑块与示例词 (Left Control Panel) ─── */}
      <div className="w-full md:w-88 lg:w-96 border-b md:border-b-0 md:border-r border-border/60 bg-muted/20 flex flex-col shrink-0 p-5 space-y-5 overflow-y-auto">
        <div className="space-y-2">
          <h3 className="text-lg font-bold text-foreground tracking-tight">
            {t('智能聚类')}
          </h3>
        </div>

        {/* 提示词输入区域 */}
        <div className="space-y-3">
          <label className="text-xs font-semibold text-foreground/90 flex items-center justify-between">
            <span>{t('整理意图或主题 (可选)')}</span>
            {prompt && (
              <button
                type="button"
                onClick={() => {
                  setPrompt('')
                  handleRequestClustering('')
                }}
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
            placeholder={t('如：按年份和财务归类、项目文档归档... ')}
            className="min-h-[40px] text-xs resize-none bg-background focus-visible:ring-1"
          />
          <Button
            onClick={() => handleRequestClustering(prompt)}
            disabled={isGenerating}
            size="sm"
            className="w-full h-8 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground flex items-center justify-center gap-1.5 shadow-xs"
          >
            <MaterialIcon
              icon={isGenerating ? 'sync' : 'auto_fix_high'}
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
            {presetExamplePrompts.map((ex, idx) => (
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

        {/* 四维聚类调节滑块面板 */}
        <div className="space-y-3.5 pt-3 pb-1 border-t border-border/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground/85 flex items-center gap-1">
              <MaterialIcon icon="tune" className="text-xs text-primary" />
              {t('结构与聚类参数微调')}
            </span>
          </div>

          {/* 聚类策略模式三选一胶囊单选控件 (Segmented Control) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t('聚类策略')}</span>
              <span className="text-[11px] text-muted-foreground/70">
                {clusteringMode === 'precise' && t('单轮单阈值，不降级')}
                {clusteringMode === 'balanced' && t('降级车门焊死，仅抱团')}
                {clusteringMode === 'complete' && t('降级吸收+抱团，全收纳')}
              </span>
            </div>
            <div role="radiogroup" aria-label={t('聚类策略')} className="grid grid-cols-3 p-1 bg-muted/60 rounded-xl border border-border/50 text-xs">
              <button
                type="button"
                disabled={isGenerating}
                role="radio" aria-checked={clusteringMode === 'precise'} onClick={() => handleModeChange('precise')}
                className={cn(
                  'py-1.5 px-2 rounded-lg text-center transition-all flex items-center justify-center gap-1 text-xs select-none',
                  clusteringMode === 'precise'
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                title={t('🎯 精准严谨：单轮严格按相似度基准聚类，不触发任何降级，未达到阈值的文件全量归入「未归类」')}
              >
                <span>🎯</span>
                <span>{t('精准严谨')}</span>
              </button>
              <button
                type="button"
                disabled={isGenerating}
                role="radio" aria-checked={clusteringMode === 'balanced'} onClick={() => handleModeChange('balanced')}
                className={cn(
                  'py-1.5 px-2 rounded-lg text-center transition-all flex items-center justify-center gap-1 text-xs select-none',
                  clusteringMode === 'balanced'
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                title={t('⭐ 平衡推荐：多轮阶梯降级且车门焊死，降级文件绝不掺入已有目录，仅自行抱团；同名同路径自然汇入')}
              >
                <span>⭐</span>
                <span>{t('平衡推荐')}</span>
              </button>
              <button
                type="button"
                disabled={isGenerating}
                role="radio" aria-checked={clusteringMode === 'complete'} onClick={() => handleModeChange('complete')}
                className={cn(
                  'py-1.5 px-2 rounded-lg text-center transition-all flex items-center justify-center gap-1 text-xs select-none',
                  clusteringMode === 'complete'
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                title={t('📦 全量收纳：阶梯降级双引擎（种子内向吸收 + 剩余抱团），最大化收敛消灭未归类文件')}
              >
                <span>📦</span>
                <span>{t('全量收纳')}</span>
              </button>
            </div>
          </div>

          {/* 1. 相似度基准 (0%..=100%) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t('相似度基准')}</span>
            <Badge variant="outline" className="text-[11px] h-5 px-1.5 font-mono">
              {getSimilarityLabel(similarityThreshold)}
            </Badge>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={similarityThreshold}
            disabled={isGenerating}
            onChange={e => handleSliderChange(setSimilarityThreshold, 'similarityThreshold', Number(e.target.value))}
            className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground/60 px-0.5">
            <span>0% ({t('松散')})</span>
            <span>60% ({t('标准')})</span>
            <span>100% ({t('精细')})</span>
          </div>
        </div>

          {/* 2. 目录层级深度 (1..=10) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t('目录层级深度')}</span>
            <Badge variant="outline" className="text-[11px] h-5 px-1.5 font-mono">
              {getMaxDepthLabel(maxDepth)}
            </Badge>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={maxDepth}
            disabled={isGenerating}
            onChange={e => handleSliderChange(setMaxDepth, 'maxDepth', Number(e.target.value))}
            className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground/60 px-0.5">
            <span>1</span>
            <span>3 ({t('默认')})</span>
            <span>10</span>
          </div>
        </div>

        {/* 3. 根目录数上限 (1..=100) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t('根目录数上限')}</span>
            <Badge variant="outline" className="text-[11px] h-5 px-1.5 font-mono">
              {getRootDirectoryLabel(maxRootDirectories)}
            </Badge>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={maxRootDirectories}
            disabled={isGenerating}
            onChange={e => handleSliderChange(setMaxRootDirectories, 'maxRootDirectories', Number(e.target.value))}
            className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground/60 px-0.5">
            <span>1</span>
            <span>5 ({t('默认')})</span>
            <span>100</span>
          </div>
        </div>

        {/* 4. 子目录数上限 (0..=100) */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t('子目录数上限')}</span>
            <Badge variant="outline" className="text-[11px] h-5 px-1.5 font-mono">
              {getSubdirectoryLabel(maxSubdirectories)}
            </Badge>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={maxSubdirectories}
            disabled={isGenerating}
            onChange={e => handleSliderChange(setMaxSubdirectories, 'maxSubdirectories', Number(e.target.value))}
            className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground/60 px-0.5">
            <span>{t('仅一级')}</span>
            <span>5 ({t('默认')})</span>
            <span>100</span>
          </div>
        </div>
        </div>

{/* 脏状态与手动微调保留提示栏 */}
        {isTreeDirty && (
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <MaterialIcon icon="edit_note" className="text-sm shrink-0" />
              <span className="truncate">{t('已手动微调目录树，重新聚类将自动融合保留修改。')}</span>
            </div>
            <button
              onClick={handleClearCustomizations}
              className="text-[11px] underline hover:text-amber-700 dark:hover:text-amber-300 shrink-0 cursor-pointer"
            >
              {t('清空微调')}
            </button>
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
        </div>

        {/* 目录树展示与内联微调区 */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 relative">
          {isGenerating ? (
            <div className="h-full flex flex-col items-center justify-center space-y-3 py-20 text-muted-foreground">
              <MaterialIcon icon="sync" className="text-3xl animate-spin text-primary" />
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
                onUnpinFile={handleUnpinFile}
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


    </div>
  )
}

/**
 * 智能聚类视图。保存主操作按钮由面包屑栏右侧统一承载，
 * 故以 forwardRef 暴露 save 句柄并上报按钮可用态。
 */
export const SmartClusteringView = React.forwardRef<SmartClusteringViewHandle, SmartClusteringViewProps>(
  SmartClusteringViewInner
)
