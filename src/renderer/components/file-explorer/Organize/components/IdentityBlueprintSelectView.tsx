import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { Button } from '../../../ui/button'
import { Badge } from '../../../ui/badge'
import { Input } from '../../../ui/input'
import { Checkbox } from '../../../ui/checkbox'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { VirtualDirectoryNode } from '@firefly/types'
import { pathsToDirectoryNodes } from '../utils/treeFromPaths'

export interface RecommendedIdentityItem {
  identityId: string
  domainId: string
  categoryId: string
  name: string
  description?: string
  score: number
  breadcrumbs: string[]
  taskTags: string[]
  associatedTemplateIds: string[]
  aliases?: string[]
}

export interface RecommendedStructureItem {
  templateId: string
  name: string
  templateType?: 'classification' | 'workflow'
  targetIdentities: string[]
  paths: string[]
  score: number
  rationale: string
  lifecycleStages?: string[]
}

export interface IdentityBlueprintSelectViewProps {
  workspaceId?: number
  workspaceDirectoryPath: string
  fileIds?: number[]
  onSelectStructure: (structure: {
    templateId: string
    name: string
    paths: string[]
    rationale: string
    identities: string[]
  }) => void
  onBack?: () => void
}

/**
 * 递归渲染只读目录结构树（带层级缩进与树导引线）
 */
export function ReadonlyDirectoryTree({
  nodes,
  depth = 0
}: {
  nodes: VirtualDirectoryNode[]
  depth?: number
}) {
  if (!nodes || nodes.length === 0) return null
  return (
    <div className={cn('space-y-0.5', depth > 0 && 'border-l border-border/50 ml-2 pl-1.5')}>
      {nodes.map((node, idx) => {
        const hasChildren = Boolean(node.subdirectories && node.subdirectories.length > 0)
        return (
          <div key={`${node.name}_${idx}`} className="text-xs">
            <div
              className="flex items-center gap-1.5 py-0.5 px-1.5 rounded-md hover:bg-muted/40 transition-colors select-none"
              title={node.name}
            >
              <MaterialIcon
                icon={hasChildren ? 'folder_open' : 'folder'}
                className={cn(
                  'text-xs shrink-0',
                  depth === 0 ? 'text-amber-500' : 'text-amber-500/80'
                )}
              />
              <span className="font-medium text-foreground/90 truncate">{node.name}</span>
            </div>
            {hasChildren && (
              <ReadonlyDirectoryTree nodes={node.subdirectories} depth={depth + 1} />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 推荐候选目录结构卡片：
 * 仅展示虚拟目录名（结构名）与真实的目录结构树，空间充裕时一行多卡，不足自动换行
 */
const StructureCard: React.FC<{
  struct: RecommendedStructureItem
  selectedIdentityNames: string[]
  onSelectStructure: IdentityBlueprintSelectViewProps['onSelectStructure']
}> = ({ struct, selectedIdentityNames, onSelectStructure }) => {
  const treeNodes = useMemo(() => pathsToDirectoryNodes(struct.paths || []), [struct.paths])

  return (
    <div className="p-4 rounded-xl border border-border/70 hover:border-primary/60 bg-card hover:bg-card/90 transition-all duration-200 shadow-xs flex flex-col justify-between space-y-3 h-full">
      <div className="space-y-2.5 flex-1 flex flex-col min-h-0">
        {/* 目录结构名（虚拟目录名） */}
        <div className="flex items-center gap-2 min-w-0">
          <MaterialIcon icon="folder_special" className="text-primary text-base shrink-0" />
          <h4 className="text-sm font-bold text-foreground truncate flex-1 min-w-0" title={struct.name}>
            {struct.name}
          </h4>
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] px-1.5 py-0 h-4.5 font-medium shrink-0',
              struct.templateType === 'classification'
                ? 'border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10'
                : 'border-border/60 text-muted-foreground bg-muted/40'
            )}
          >
            {struct.templateType === 'classification' ? t('资产分类') : t('工作流')}
          </Badge>
        </div>

        {/* 真实的目录结构树 */}
        <div className="flex-1 min-h-[140px] max-h-[260px] overflow-y-auto p-2.5 rounded-lg bg-muted/20 border border-border/40 custom-scrollbar">
          {treeNodes.length > 0 ? (
            <ReadonlyDirectoryTree nodes={treeNodes} />
          ) : (
            <div className="flex items-center justify-center h-full py-6 text-muted-foreground text-xs italic">
              {t('暂无目录结构')}
            </div>
          )}
        </div>
      </div>

      {/* 卡片底部操作按钮 */}
      <div className="pt-2 border-t border-border/40 flex items-center justify-end">
        <Button
          onClick={() =>
            onSelectStructure({
              templateId: struct.templateId,
              name: struct.name,
              paths: struct.paths,
              rationale: struct.rationale,
              identities: selectedIdentityNames
            })
          }
          className="w-full h-8 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground flex items-center justify-center gap-1.5 shadow-xs px-3"
        >
          <MaterialIcon icon="check" className="text-sm" />
          <span>{t('使用此结构')}</span>
        </Button>
      </div>
    </div>
  )
}

export const IdentityBlueprintSelectView: React.FC<IdentityBlueprintSelectViewProps> = ({
  workspaceId,
  workspaceDirectoryPath,
  fileIds,
  onSelectStructure,
  onBack
}) => {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const [prompt, setPrompt] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [recommendedIdentities, setRecommendedIdentities] = useState<RecommendedIdentityItem[]>([])
  const [recommendedStructures, setRecommendedStructures] = useState<RecommendedStructureItem[]>([])
  const [selectedIdentityIds, setSelectedIdentityIds] = useState<string[]>([])

  // 折叠展开状态：默认展开首个领域与分类
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set())
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())

  // 单调递增请求序列防护与防抖计时器 (防乱序与丢弃无感知)
  const searchSeqRef = useRef<number>(0)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isFirstRenderRef = useRef<boolean>(true)
  const hasInitializedTreeRef = useRef<boolean>(false)

  // 执行身份与结构协同推荐
  const executeMatching = useCallback(
    async (userPrompt: string) => {
      const currentSeq = ++searchSeqRef.current
      setIsLoading(true)
      try {
        const res = await window.electronAPI.organizeRealDirectory.matchPerspectivesAndStructures({
          workspaceId,
          fileIds: fileIds || [],
          naturalLanguagePrompt: userPrompt.trim(),
          language: (activeLanguage as any) || 'zh-CN'
        })

        if (currentSeq === searchSeqRef.current && res) {
          const idents: RecommendedIdentityItem[] =
            res.allIdentities && res.allIdentities.length > 0
              ? res.allIdentities
              : res.recommendedIdentities || []
          const structs: RecommendedStructureItem[] =
            res.allStructures && res.allStructures.length > 0
              ? res.allStructures
              : res.recommendedStructures || []
          setRecommendedIdentities(idents)
          setRecommendedStructures(structs)

          // 仅在初始加载或清空搜索时默认展开
          if (!userPrompt.trim() && idents.length > 0 && !hasInitializedTreeRef.current) {
            hasInitializedTreeRef.current = true
            const allDomains = new Set(idents.map(i => i.domainId))
            setExpandedDomains(allDomains)
            const top1 = idents[0]
            if (top1) {
              setExpandedCategories(new Set([top1.categoryId]))
            }
          }
        }
      } catch (err) {
        if (currentSeq === searchSeqRef.current) {
          console.error('Failed to match perspectives and structures:', err)
        }
      } finally {
        if (currentSeq === searchSeqRef.current) {
          setIsLoading(false)
        }
      }
    },
    [workspaceId, fileIds, activeLanguage]
  )

  // 首启与防抖触发匹配
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    // 仅组件第一次挂载时立即执行一次，后续输入严格 300ms 防抖
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      executeMatching('')
      return
    }

    debounceTimerRef.current = setTimeout(() => {
      executeMatching(prompt)
    }, 300)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [prompt, executeMatching])

  // 实时搜索关键词
  const searchKeyword = prompt.trim().toLowerCase()

  // 基于搜索词过滤身份列表
  const filteredIdentities = useMemo(() => {
    if (!searchKeyword) return recommendedIdentities
    return recommendedIdentities.filter(item => {
      const nameMatch = (item.name || '').toLowerCase().includes(searchKeyword)
      const descMatch = (item.description || '').toLowerCase().includes(searchKeyword)
      const tagMatch = (item.taskTags || []).some(t => t.toLowerCase().includes(searchKeyword))
      const breadcrumbMatch = (item.breadcrumbs || []).some(b => b.toLowerCase().includes(searchKeyword))
      const idMatch = (item.identityId || '').toLowerCase().includes(searchKeyword)
      const aliasMatch = (item.aliases || []).some(a => a.toLowerCase().includes(searchKeyword))
      return nameMatch || descMatch || tagMatch || breadcrumbMatch || idMatch || aliasMatch
    })
  }, [searchKeyword, recommendedIdentities])

  // 按 Domain -> Category 聚类当前展示的身份列表
  const domainGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        domainId: string
        domainName: string
        categories: Map<
          string,
          {
            categoryId: string
            categoryName: string
            identities: RecommendedIdentityItem[]
          }
        >
      }
    >()

    for (const item of filteredIdentities) {
      const dName = item.breadcrumbs[0] || item.domainId
      const cName = item.breadcrumbs[1] || item.categoryId

      if (!groups.has(item.domainId)) {
        groups.set(item.domainId, {
          domainId: item.domainId,
          domainName: dName,
          categories: new Map()
        })
      }
      const dGroup = groups.get(item.domainId)!

      if (!dGroup.categories.has(item.categoryId)) {
        dGroup.categories.set(item.categoryId, {
          categoryId: item.categoryId,
          categoryName: cName,
          identities: []
        })
      }
      dGroup.categories.get(item.categoryId)!.identities.push(item)
    }

    return Array.from(groups.values()).map(d => ({
      ...d,
      categories: Array.from(d.categories.values())
    }))
  }, [filteredIdentities])

  // 搜索态下自动展开所有命中结果所在的领域与分类 (Union 并集模式，保护手动折叠)
  useEffect(() => {
    if (searchKeyword && filteredIdentities.length > 0) {
      const matchedDomainIds = new Set(filteredIdentities.map(i => i.domainId))
      const matchedCatIds = new Set(filteredIdentities.map(i => i.categoryId))
      setExpandedDomains(prev => new Set([...prev, ...matchedDomainIds]))
      setExpandedCategories(prev => new Set([...prev, ...matchedCatIds]))
    }
  }, [searchKeyword, filteredIdentities])

  // 切换勾选身份
  const handleToggleIdentity = (id: string) => {
    setSelectedIdentityIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  // 展开/收起 Domain
  const toggleDomain = (domainId: string) => {
    setExpandedDomains(prev => {
      const next = new Set(prev)
      if (next.has(domainId)) next.delete(domainId)
      else next.add(domainId)
      return next
    })
  }

  // 展开/收起 Category
  const toggleCategory = (catId: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(catId)) next.delete(catId)
      else next.add(catId)
      return next
    })
  }

  // 已勾选的身份名称列表
  const selectedIdentityNames = useMemo(() => {
    const set = new Set(selectedIdentityIds)
    return recommendedIdentities.filter(i => set.has(i.identityId)).map(i => i.name)
  }, [selectedIdentityIds, recommendedIdentities])

  // 一键全部展开 / 全部收起状态管理
  const allDomainIds = useMemo(() => domainGroups.map(d => d.domainId), [domainGroups])
  const allCategoryIds = useMemo(
    () => domainGroups.flatMap(d => d.categories.map(c => c.categoryId)),
    [domainGroups]
  )
  const isAllExpanded = useMemo(() => {
    if (allDomainIds.length === 0) return false
    return (
      allDomainIds.every(id => expandedDomains.has(id)) &&
      allCategoryIds.every(id => expandedCategories.has(id))
    )
  }, [allDomainIds, allCategoryIds, expandedDomains, expandedCategories])

  const handleToggleAll = () => {
    if (isAllExpanded) {
      setExpandedDomains(new Set())
      setExpandedCategories(new Set())
    } else {
      setExpandedDomains(new Set(allDomainIds))
      setExpandedCategories(new Set(allCategoryIds))
    }
  }

  // 0ms 纯内存分层置顶重排 (Zero-IPC Tiered Sort)
  const displayStructures = useMemo(() => {
    // 1. 无勾选身份时：搜索态或全局推荐态，直接按后端算法相似度降序展示
    if (selectedIdentityIds.length === 0) {
      return recommendedStructures
    }

    // 2. 有勾选身份时：按 Tier 1 (首选分类版) -> Tier 2 (次选工作流版) -> Tier 3 (其他) 绝对置顶
    const selectedSet = new Set(selectedIdentityIds)
    const selectedIdents = recommendedIdentities.filter(i => selectedSet.has(i.identityId))

    const tier1Ids = new Set<string>() // 首选专属分类模板
    const tier2Ids = new Set<string>() // 次选工作流模板

    for (const ident of selectedIdents) {
      const assocs = ident.associatedTemplateIds || []
      if (assocs.length > 0) {
        tier1Ids.add(assocs[0])
        for (let i = 1; i < assocs.length; i++) {
          tier2Ids.add(assocs[i])
        }
      }
    }

    return [...recommendedStructures].sort((a, b) => {
      const aTier = tier1Ids.has(a.templateId) ? 1 : tier2Ids.has(a.templateId) ? 2 : 3
      const bTier = tier1Ids.has(b.templateId) ? 1 : tier2Ids.has(b.templateId) ? 2 : 3
      if (aTier !== bTier) {
        return aTier - bTier
      }
      return b.score - a.score
    })
  }, [selectedIdentityIds, recommendedStructures, recommendedIdentities])

  return (
    <div className="flex-1 flex flex-col h-full w-full overflow-hidden bg-background">
      {/* ─── 顶部意图搜索与导航栏 ─── */}
      <div className="border-b border-border/60 bg-muted/15 p-4 md:px-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3">
          {onBack && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="h-8 text-xs text-muted-foreground hover:text-foreground"
            >
              <MaterialIcon icon="arrow_back" className="text-sm mr-1" />
              {t('返回')}
            </Button>
          )}
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-foreground">{t('身份蓝图 · 结构推荐')}</h2>
              <Badge className="text-[11px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30">
                <MaterialIcon icon="star" className="text-xs mr-0.5" />
                {t('推荐模式')}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('左侧选定您的数字职业或生活身份，右侧即时协同生成最匹配的标准目录结构。')}
            </p>
          </div>
        </div>

        {/* 意图输入框 */}
        <div className="flex items-center gap-2 w-full md:w-96">
          <div className="relative flex-1">
            <MaterialIcon
              icon="search"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
            />
            <Input
              value={prompt}
              onChange={e => {
                const val = e.target.value
                setPrompt(val)
                // 输入时立即取消左侧身份选择，切回双侧独立意图匹配模式
                if (selectedIdentityIds.length > 0) {
                  setSelectedIdentityIds([])
                }
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  if (debounceTimerRef.current) {
                    clearTimeout(debounceTimerRef.current)
                  }
                  executeMatching(prompt)
                }
              }}
              placeholder={t('搜索身份或输入诉求 (如 UI设计师、开发者)...')}
              className="h-8 pl-8 pr-7 text-xs bg-background"
            />
            {prompt && (
              <button
                type="button"
                onClick={() => {
                  if (debounceTimerRef.current) {
                    clearTimeout(debounceTimerRef.current)
                  }
                  setPrompt('')
                  executeMatching('')
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
              >
                <MaterialIcon icon="close" className="text-xs" />
              </button>
            )}
          </div>
          <Button
            size="sm"
            onClick={() => executeMatching(prompt)}
            disabled={isLoading}
            className="h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
          >
            <MaterialIcon
              icon={isLoading ? 'sync' : 'tune'}
              className={cn('text-xs mr-1', isLoading && 'animate-spin')}
            />
            <span>{isLoading ? t('计算中...') : t('匹配')}</span>
          </Button>
        </div>
      </div>

      {/* ─── 主体分栏：左侧身份树 + 右侧推荐结构卡片 ─── */}
      <div className="flex-1 flex flex-col md:flex-row h-full overflow-hidden">
        {/* 左栏：分层身份树 */}
        <div className="w-full md:w-88 lg:w-96 border-b md:border-b-0 md:border-r border-border/60 bg-muted/20 flex flex-col shrink-0 p-4 space-y-4 overflow-y-auto">
          {/* 已勾选身份展示 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-semibold text-foreground/90">
              <span className="flex items-center gap-1.5">
                <MaterialIcon icon="badge" className="text-sm text-primary" />
                <span>{t('已选身份 ({count})', { count: selectedIdentityIds.length })}</span>
              </span>
              {selectedIdentityIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedIdentityIds([])}
                  className="text-[11px] text-muted-foreground hover:text-destructive transition-colors"
                >
                  {t('清除已选')}
                </button>
              )}
            </div>

            {selectedIdentityNames.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 p-2 rounded-lg bg-card border border-border/60">
                {selectedIdentityNames.map((name, idx) => (
                  <Badge
                    key={idx}
                    variant="secondary"
                    className="text-[11px] px-2 py-0.5 bg-primary/10 text-primary border-primary/20 flex items-center gap-1"
                  >
                    <span>{name}</span>
                    <button
                      type="button"
                      onClick={() => handleToggleIdentity(selectedIdentityIds[idx])}
                      className="hover:text-destructive"
                    >
                      <MaterialIcon icon="close" className="text-xs" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground italic px-1">
                {t('暂未勾选，默认基于待整理文件特征智能推荐')}
              </p>
            )}
          </div>

          {/* 身份树层级展示 */}
          <div className="space-y-2 pt-2 border-t border-border/40">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
                {searchKeyword ? (
                  <>
                    <MaterialIcon icon="filter_list" className="text-xs text-primary" />
                    <span>{t('搜索结果 ({count} 个身份)', { count: filteredIdentities.length })}</span>
                  </>
                ) : (
                  <span>{t('全量身份库 ({count} 个身份)', { count: recommendedIdentities.length })}</span>
                )}
              </span>
              {filteredIdentities.length > 0 && (
                <button
                  type="button"
                  onClick={handleToggleAll}
                  className="text-[11px] text-primary hover:text-primary/80 transition-colors font-medium select-none"
                >
                  {isAllExpanded ? t('全部折叠') : t('全部展开')}
                </button>
              )}
            </div>

            <div className="space-y-2">
              {domainGroups.map(d => {
                const isDomainOpen = expandedDomains.has(d.domainId)
                return (
                  <div key={d.domainId} className="rounded-xl border border-border/60 bg-card overflow-hidden">
                    {/* Domain L1 */}
                    <button
                      type="button"
                      onClick={() => toggleDomain(d.domainId)}
                      className="w-full px-3 py-2.5 flex items-center justify-between text-left hover:bg-muted/30 transition-colors"
                    >
                      <span className="text-xs font-bold text-foreground flex items-center gap-1.5 truncate">
                        <MaterialIcon
                          icon={isDomainOpen ? 'keyboard_arrow_down' : 'chevron_right'}
                          className="text-sm text-muted-foreground"
                        />
                        <span className="truncate">{d.domainName}</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded-full bg-muted">
                        {d.categories.reduce((acc, c) => acc + c.identities.length, 0)}
                      </span>
                    </button>

                    {/* Category L2 */}
                    {isDomainOpen && (
                      <div className="px-3 pb-2.5 space-y-2 border-t border-border/30 pt-2">
                        {d.categories.map(c => {
                          const isCatOpen = expandedCategories.has(c.categoryId)
                          return (
                            <div key={c.categoryId} className="space-y-1.5 pl-2">
                              <button
                                type="button"
                                onClick={() => toggleCategory(c.categoryId)}
                                className="w-full flex items-center justify-between text-left text-xs font-semibold text-foreground/85 hover:text-primary transition-colors py-1"
                              >
                                <span className="flex items-center gap-1">
                                  <MaterialIcon
                                    icon={isCatOpen ? 'arrow_drop_down' : 'arrow_right'}
                                    className="text-xs text-muted-foreground"
                                  />
                                  <span>{c.categoryName}</span>
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {c.identities.length}
                                </span>
                              </button>

                              {/* Identity L3 items */}
                              {isCatOpen && (
                                <div className="space-y-1 pl-4">
                                  {c.identities.map(item => {
                                    const isChecked = selectedIdentityIds.includes(item.identityId)
                                    const scorePct = Math.round((item.score || 0) * 100)
                                    return (
                                      <label
                                        key={item.identityId}
                                        className={cn(
                                          'flex items-center justify-between p-1.5 rounded-lg text-xs cursor-pointer select-none transition-colors',
                                          isChecked
                                            ? 'bg-primary/10 text-primary font-semibold'
                                            : 'hover:bg-muted/50 text-foreground/80'
                                        )}
                                      >
                                        <div className="flex items-center gap-2 min-w-0 pr-1">
                                          <Checkbox
                                            checked={isChecked}
                                            onCheckedChange={() => handleToggleIdentity(item.identityId)}
                                            className="h-3.5 w-3.5"
                                          />
                                          <span className="truncate">{item.name}</span>
                                        </div>
                                        {scorePct > 0 && (
                                          <span
                                            className={cn(
                                              'text-[10px] px-1.5 py-0.2 rounded-full shrink-0 font-medium',
                                              scorePct >= 75
                                                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                                : 'bg-muted text-muted-foreground'
                                            )}
                                          >
                                            {scorePct}%
                                          </span>
                                        )}
                                      </label>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
              {domainGroups.length === 0 && searchKeyword && (
                <div className="py-8 px-4 text-center rounded-xl border border-dashed border-border/80 bg-muted/10 space-y-2">
                  <MaterialIcon icon="search_off" className="text-3xl text-muted-foreground/60 mx-auto" />
                  <p className="text-xs font-semibold text-foreground/80">
                    {t('未找到匹配“{keyword}”的身份', { keyword: prompt.trim() })}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {t('可尝试搜索“游戏”、“音乐”、“小说”等关键词，或点击“匹配”进行意图理解')}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setPrompt('')
                      executeMatching('')
                    }}
                    className="h-7 text-xs mt-2"
                  >
                    {t('清空搜索')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右栏：推荐目录结构卡片 */}
        <div className="flex-1 flex flex-col h-full overflow-y-auto p-4 md:p-6 bg-card/40 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-foreground">
                  {t('推荐候选目录结构')}
                </h3>
                {displayStructures.length > 0 && (
                  <Badge variant="outline" className="text-xs">
                    {t('{count} 个匹配方案', { count: displayStructures.length })}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {selectedIdentityNames.length > 0
                  ? t('已绑定身份: {names}，点击“使用此结构”进入目录微调', {
                      names: selectedIdentityNames.join(' + ')
                    })
                  : t('基于文件内容与身份语义全量匹配推荐，点击“使用此结构”进入目录微调')}
              </p>
            </div>
          </div>

          {isLoading ? (
            <div className="h-64 flex flex-col items-center justify-center space-y-3 text-muted-foreground">
              <MaterialIcon icon="sync" className="text-3xl animate-spin text-primary" />
              <p className="text-sm">{t('正在协同计算最契合的目录模板...')}</p>
            </div>
          ) : displayStructures.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 w-full">
              {displayStructures.map((struct, idx) => (
                <StructureCard
                  key={struct.templateId || idx}
                  struct={struct}
                  selectedIdentityNames={selectedIdentityNames}
                  onSelectStructure={onSelectStructure}
                />
              ))}
            </div>
          ) : (
            <div className="h-64 flex flex-col items-center justify-center space-y-3 text-muted-foreground text-center">
              <MaterialIcon icon="folder_off" className="text-4xl opacity-50" />
              <p className="text-sm">{t('未检索到匹配的目录模板，请尝试更换身份或输入提示词')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
