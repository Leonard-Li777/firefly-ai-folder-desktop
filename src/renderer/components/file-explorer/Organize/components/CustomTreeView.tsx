import React, {
  useState,
  useEffect,
  useMemo,
  useDeferredValue,
  forwardRef,
  useImperativeHandle
} from 'react'
import { VirtualDirectoryNode } from '@firefly/types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Textarea } from '../../../ui/textarea'
import { t } from '@app/languages'
import { extractVirtualDirName, parseStrategyToTree, sanitizeDirectoryName } from '../utils/helpers'

export interface CustomTreeViewHandle {
  /** 命令式触发提交（供面包屑栏「下一步」按钮调用） */
  submit: () => void
}

interface CustomTreeViewProps {
  initialName?: string
  initialStrategy?: string
  workspaceDirectoryPath?: string
  isExternalAi?: boolean
  onBack: () => void
  onSubmit: (name: string, strategy: string, tree: VirtualDirectoryNode[]) => void
  /** 上报「下一步」按钮可用态，驱动面包屑栏按钮禁用 */
  onCanSubmitChange?: (canSubmit: boolean) => void
}

const DEFAULT_STRATEGY = `以办公文员视角，按以下目录结构整理文档：

- 办公文档
  - 行政人事
    - 考勤记录
    - 请假审批
    - 员工档案
  - 财务报表
    - 月度报表
    - 预算审批
    - 发票管理
  - 合同协议
    - 采购合同
    - 服务协议
    - 保密协议
  - 会议纪要
    - 周会记录
    - 项目评审
    - 年度总结`

/** 递归统计目录树中总目录数量 */
function countDirectories(nodes: VirtualDirectoryNode[]): number {
  let count = 0
  for (const node of nodes) {
    count++
    if (node.subdirectories && node.subdirectories.length > 0) {
      count += countDirectories(node.subdirectories)
    }
  }
  return count
}

/** 树形预览节点单项 */
function TreePreviewItem({
  node,
  depth = 0
}: {
  node: VirtualDirectoryNode
  depth?: number
}) {
  const hasChildren = Boolean(node.subdirectories && node.subdirectories.length > 0)

  return (
    <div className="select-none">
      <div
        className={cn(
          'flex items-center gap-2 py-1 px-2 rounded-lg text-xs font-medium transition-colors hover:bg-muted/40 group',
          depth === 0 ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <MaterialIcon
          icon={hasChildren ? 'folder_open' : 'folder'}
          className={cn(
            'text-[15px] shrink-0 transition-colors',
            depth === 0 ? 'text-primary' : 'text-primary/70 group-hover:text-primary'
          )}
        />
        <span className="truncate">{node.name}</span>
        {hasChildren && (
          <span className="text-[10px] text-muted-foreground/60 ml-auto font-mono">
            {node.subdirectories.length}
          </span>
        )}
      </div>

      {hasChildren && (
        <div className="border-l border-border/40 ml-4">
          {node.subdirectories.map((child, idx) => (
            <TreePreviewItem key={`${child.name}-${idx}`} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

const DRAFT_NAME_KEY_PREFIX = 'organize_custom_name_'
const DRAFT_STRATEGY_KEY_PREFIX = 'organize_custom_strategy_'

const getDraftName = (workspacePath?: string) => {
  if (!workspacePath) return ''
  try {
    return localStorage.getItem(`${DRAFT_NAME_KEY_PREFIX}${workspacePath}`) || ''
  } catch {
    return ''
  }
}

const getDraftStrategy = (workspacePath?: string) => {
  if (!workspacePath) return ''
  try {
    return localStorage.getItem(`${DRAFT_STRATEGY_KEY_PREFIX}${workspacePath}`) || ''
  } catch {
    return ''
  }
}

const saveDraft = (workspacePath?: string, name?: string, strategy?: string) => {
  if (!workspacePath) return
  try {
    if (name !== undefined) {
      localStorage.setItem(`${DRAFT_NAME_KEY_PREFIX}${workspacePath}`, name)
    }
    if (strategy !== undefined) {
      localStorage.setItem(`${DRAFT_STRATEGY_KEY_PREFIX}${workspacePath}`, strategy)
    }
  } catch {}
}

const clearDraft = (workspacePath?: string) => {
  if (!workspacePath) return
  try {
    localStorage.removeItem(`${DRAFT_NAME_KEY_PREFIX}${workspacePath}`)
    localStorage.removeItem(`${DRAFT_STRATEGY_KEY_PREFIX}${workspacePath}`)
  } catch {}
}

export const CustomTreeView = forwardRef<CustomTreeViewHandle, CustomTreeViewProps>(
  ({ initialName = '', initialStrategy = '', workspaceDirectoryPath, isExternalAi = false, onBack, onSubmit, onCanSubmitChange }, ref) => {
  const defaultFallbackName = workspaceDirectoryPath
    ? `${workspaceDirectoryPath.replace(/[/\\]$/, '').split(/[/\\]/).pop() || ''} ${t('整理方案')}`
    : t('自定义整理方案')

  const [name, setName] = useState(() => {
    if (initialName) return initialName
    if (!isExternalAi && workspaceDirectoryPath) {
      const cached = getDraftName(workspaceDirectoryPath)
      if (cached) return cached
    }
    return ''
  })
  const [strategy, setStrategy] = useState(() => {
    if (initialStrategy) return initialStrategy
    if (isExternalAi) return ''
    if (workspaceDirectoryPath) {
      const cached = getDraftStrategy(workspaceDirectoryPath)
      if (cached) return cached
    }
    return DEFAULT_STRATEGY
  })
  const [isDirty, setIsDirty] = useState(() => {
    if (initialStrategy) return true
    if (!isExternalAi && workspaceDirectoryPath) {
      const cached = getDraftStrategy(workspaceDirectoryPath)
      if (cached && cached !== DEFAULT_STRATEGY) return true
    }
    return false
  })

  // 当为外部 AI 导入初次进入且有初始策略时，自动解析首行
  useEffect(() => {
    if (initialStrategy) {
      const { name: extractedName, cleanStrategy } = extractVirtualDirName(initialStrategy)
      if (extractedName && !initialName) {
        setName(extractedName)
      }
      setStrategy(cleanStrategy || initialStrategy)
      setIsDirty(true)
    }
  }, [initialStrategy, initialName])

  const handleNameChange = (val: string) => {
    setName(val)
    if (!isExternalAi && workspaceDirectoryPath) {
      saveDraft(workspaceDirectoryPath, val, undefined)
    }
  }

  // 处理文本输入并自动提取首行虚拟目录名
  const handleStrategyChange = (newVal: string) => {
    setIsDirty(true)
    const { name: extractedName, cleanStrategy } = extractVirtualDirName(newVal)
    if (extractedName) {
      setName(extractedName)
      setStrategy(cleanStrategy)
      if (!isExternalAi && workspaceDirectoryPath) {
        saveDraft(workspaceDirectoryPath, extractedName, cleanStrategy)
      }
    } else {
      setStrategy(newVal)
      if (!isExternalAi && workspaceDirectoryPath) {
        saveDraft(workspaceDirectoryPath, undefined, newVal)
      }
    }
  }

  // 使用 React 18 useDeferredValue 进行轻量防抖解析，防大文本输入卡顿
  const deferredStrategy = useDeferredValue(strategy)

  const parsedTree = useMemo(() => {
    const rawText = isExternalAi
      ? deferredStrategy.trim()
      : isDirty
        ? deferredStrategy.trim()
        : DEFAULT_STRATEGY.trim()

    if (!rawText) return []
    try {
      const tree = parseStrategyToTree(rawText, name.trim())
      return Array.isArray(tree) ? tree : []
    } catch {
      return []
    }
  }, [deferredStrategy, isExternalAi, isDirty, name])

  const dirCount = useMemo(() => countDirectories(parsedTree), [parsedTree])
  const canSubmit = parsedTree.length > 0

  // 向父级上报「下一步」可用态（面包屑栏按钮禁用态由此驱动）
  useEffect(() => {
    onCanSubmitChange?.(canSubmit)
  }, [canSubmit, onCanSubmitChange])

  const handleResetSample = () => {
    setName(initialName || defaultFallbackName)
    setStrategy(DEFAULT_STRATEGY)
    setIsDirty(false)
    if (!isExternalAi && workspaceDirectoryPath) {
      clearDraft(workspaceDirectoryPath)
    }
  }

  const handleClear = () => {
    setName('')
    setStrategy('')
    setIsDirty(true)
    if (!isExternalAi && workspaceDirectoryPath) {
      clearDraft(workspaceDirectoryPath)
    }
  }

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!canSubmit) return

    let finalStrategy = isExternalAi
      ? strategy.trim()
      : isDirty
        ? strategy.trim()
        : DEFAULT_STRATEGY.trim()

    const { name: extractedName, cleanStrategy } = extractVirtualDirName(finalStrategy)
    if (cleanStrategy) {
      finalStrategy = cleanStrategy
    }

    let finalName = name.trim() || extractedName || ''
    if (!finalName) {
      if (parsedTree.length === 1 && parsedTree[0].name) {
        finalName = parsedTree[0].name
      } else if (workspaceDirectoryPath) {
        finalName = defaultFallbackName
      } else {
        finalName = t('自定义整理方案')
      }
    }

    const cleanSafeName = sanitizeDirectoryName(finalName)
    if (!isExternalAi && workspaceDirectoryPath) {
      saveDraft(workspaceDirectoryPath, cleanSafeName, finalStrategy)
    }
    onSubmit(cleanSafeName, finalStrategy, parsedTree)
  }

  // 暴露 submit 句柄：面包屑栏「下一步」按钮命令式触发，命名/草稿保存逻辑仍收敛在视图内
  useImperativeHandle(
    ref,
    () => ({
      submit: () => handleSubmit()
    }),
    // handleSubmit 依赖的均为渲染期内状态，此处按渲染快照捕获
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, strategy, isExternalAi, isDirty, parsedTree, workspaceDirectoryPath, onSubmit]
  )

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden p-6 md:p-8 bg-background">
      {/* 头部区域 */}
      <div className="mb-4 shrink-0 flex items-center justify-between">
        <div>
          <h2 className="text-xl md:text-2xl font-black tracking-tight flex items-center gap-2.5">
            <span
              className={cn(
                'p-2 rounded-xl',
                isExternalAi
                  ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                  : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              )}
            >
              <MaterialIcon
                icon={isExternalAi ? 'travel_explore' : 'account_tree'}
                className="text-xl"
              />
            </span>
            <span>
              {isExternalAi ? t('导入外部 AI 生成的目录结构') : t('自定义目录树')}
            </span>
            <span
              className={cn(
                'text-xs font-bold px-2.5 py-0.5 rounded-full border',
                isExternalAi
                  ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20'
                  : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
              )}
            >
              {isExternalAi ? t('外部AI生成') : t('所见即所得 · 实时解析')}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            {isExternalAi
              ? t('粘贴外部大模型生成的 Markdown 目录树，右侧将实时解析；首行支持附带【虚拟目录名称：xxxx】自动识别')
              : t('自由书写或粘贴 Markdown 格式目录树，右侧将实时解析预览，满意后进入微调')}
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          className="rounded-xl text-xs gap-1 h-9 px-3 shrink-0"
        >
          <MaterialIcon icon="arrow_back" className="text-sm" />
          <span>{isExternalAi ? t('返回外部AI引导') : t('返回模式选择')}</span>
        </Button>
      </div>

      {/* 主体左右双栏（自适应） */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-5 overflow-hidden">
        {/* 左栏：输入与配置 (50%) */}
        <div className="flex-1 lg:max-w-[50%] flex flex-col h-full bg-card rounded-2xl border border-border/60 p-5 shadow-xs overflow-hidden">
          <div className="space-y-4 flex-1 flex flex-col min-h-0">
            {/* 虚拟目录名 */}
            <div className="space-y-1.5 shrink-0">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <span>{t('虚拟目录名')}</span>
                  <span className="text-destructive font-bold">*</span>
                </span>
                <span className="text-[11px] text-muted-foreground/60 font-normal">
                  {t('将作为最终物理文件夹的名字')}
                </span>
              </label>
              <Input
                value={name}
                onChange={e => handleNameChange(e.target.value)}
                placeholder={t('例：办公文员视角、行政综合、研发项目')}
                className="h-10 rounded-xl border-border/60 bg-background/50 focus-visible:ring-primary focus-visible:border-primary placeholder:text-muted-foreground/50 transition-all font-medium text-xs"
              />
            </div>

            {/* 目录树文本输入 */}
            <div className="space-y-1.5 flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between shrink-0">
                <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <MaterialIcon icon="edit_note" className="text-sm text-primary" />
                  <span>{t('整理策略与 Markdown 目录树')}</span>
                </label>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleResetSample}
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground rounded-lg"
                  >
                    <MaterialIcon icon="restart_alt" className="text-xs mr-1" />
                    <span>{t('恢复示例')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleClear}
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive rounded-lg"
                  >
                    <MaterialIcon icon="clear_all" className="text-xs mr-1" />
                    <span>{t('清空')}</span>
                  </Button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative rounded-xl border border-border/60 bg-background/50 overflow-hidden flex flex-col">
                <Textarea
                  value={strategy}
                  onChange={e => handleStrategyChange(e.target.value)}
                  placeholder={
                    isExternalAi
                      ? t('请直接粘贴外部AI生成的目录树，首行可写：虚拟目录名称：xxxx\n- 文件夹1\n  - 子文件夹A\n- 文件夹2')
                      : t('请直接输入或粘贴目录树结构（支持标准 Markdown 列表 - 或 * 与缩进）：\n- 顶级目录1\n  - 子目录A\n- 顶级目录2')
                  }
                  className="flex-1 w-full p-3 font-mono text-xs leading-relaxed text-foreground bg-transparent resize-none border-0 focus-visible:ring-0 focus-visible:border-0 custom-scrollbar"
                />
              </div>

              <p className="text-[11px] text-muted-foreground/75 px-1 shrink-0">
                {t('支持 Markdown 列表（- 目录名）、制表符/空格层级缩进，以及树形符号（├ └ │）')}
              </p>
            </div>
          </div>
        </div>

        {/* 右栏：实时解析树结构预览 (50%) */}
        <div className="flex-1 lg:max-w-[50%] flex flex-col h-full bg-card rounded-2xl border border-border/60 p-5 shadow-xs overflow-hidden">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-border/40 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <MaterialIcon icon="account_tree" className="text-primary text-base shrink-0" />
              <h3 className="text-sm font-bold text-foreground truncate">
                {t('实时目录树预览')}
              </h3>
              {dirCount > 0 && (
                <span className="text-[10px] text-primary font-mono bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-full font-bold shrink-0">
                  {t('共 {count} 个目录', { count: dirCount })}
                </span>
              )}
            </div>

            <span className="text-[11px] text-muted-foreground/70">
              {parsedTree.length > 0
                ? t('解析就绪，可随时进入微调')
                : t('等待输入有效目录格式')}
            </span>
          </div>

          <div className="flex-1 min-h-0 relative rounded-xl border border-border/40 bg-muted/20 overflow-y-auto p-3 custom-scrollbar">
            {parsedTree.length > 0 ? (
              <div className="space-y-0.5">
                {parsedTree.map((node, idx) => (
                  <TreePreviewItem key={`${node.name}-${idx}`} node={node} depth={0} />
                ))}
              </div>
            ) : (
              <div className="flex-1 h-full flex flex-col items-center justify-center gap-2.5 text-center p-6 text-muted-foreground">
                <div className="w-12 h-12 rounded-2xl bg-muted/40 border border-border/60 flex items-center justify-center text-muted-foreground/60">
                  <MaterialIcon icon="folder_off" className="text-2xl" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-xs font-bold text-foreground">
                    {t('暂无解析生成的目录结构')}
                  </h4>
                  <p className="text-[11px] text-muted-foreground max-w-xs leading-relaxed">
                    {t('请在左侧输入 Markdown 列表格式的目录树结构（如 - 一级目录），右侧将实时渲染树形大纲。')}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* 底部状态条（主操作按钮已统一至面包屑栏右侧） */}
          <div className="pt-4 mt-3 border-t border-border/40 flex items-center shrink-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MaterialIcon
                icon={canSubmit ? 'check_circle' : 'info'}
                className={cn('text-sm', canSubmit ? 'text-emerald-500' : 'text-amber-500')}
              />
              <span>
                {canSubmit
                  ? t('已完成实时语法解析')
                  : t('请输入至少一个有效目录后继续')}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})
CustomTreeView.displayName = 'CustomTreeView'
