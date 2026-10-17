import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { Button } from '../../../ui/button'
import { Badge } from '../../../ui/badge'
import { Input } from '../../../ui/input'
import { Checkbox } from '../../../ui/checkbox'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'

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

  // 执行身份与结构协同推荐
  const executeMatching = useCallback(
    async (userPrompt: string) => {
      setIsLoading(true)
      try {
        const res = await window.electronAPI.organizeRealDirectory.matchPerspectivesAndStructures({
          workspaceId,
          fileIds: fileIds || [],
          naturalLanguagePrompt: userPrompt.trim(),
          language: (activeLanguage as any) || 'zh-CN'
        })

        if (res) {
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

          // 默认展开所有领域，使全量分类与结构一览无余；同时展开 Top-1 推荐分类
          if (idents.length > 0) {
            const allDomains = new Set(idents.map(i => i.domainId))
            setExpandedDomains(allDomains)
            const top1 = idents[0]
            setExpandedCategories(new Set([top1.categoryId]))
          }
        }
      } catch (err) {
        console.error('Failed to match perspectives and structures:', err)
      } finally {
        setIsLoading(false)
      }
    },
    [workspaceId, fileIds, activeLanguage]
  )

  // 首启触发初始匹配
  useEffect(() => {
    executeMatching('')
  }, [executeMatching])

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

  // 搜索态下自动展开所有命中结果所在的领域与分类，清空时重置为初始状态
  useEffect(() => {
    if (searchKeyword) {
      if (filteredIdentities.length > 0) {
        const matchedDomainIds = new Set(filteredIdentities.map(i => i.domainId))
        const matchedCatIds = new Set(filteredIdentities.map(i => i.categoryId))
        setExpandedDomains(matchedDomainIds)
        setExpandedCategories(matchedCatIds)
      }
    } else if (recommendedIdentities.length > 0) {
      const allDomains = new Set(recommendedIdentities.map(i => i.domainId))
      setExpandedDomains(allDomains)
      const top1 = recommendedIdentities[0]
      if (top1) {
        setExpandedCategories(new Set([top1.categoryId]))
      }
    }
  }, [searchKeyword, filteredIdentities, recommendedIdentities])

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

  // 过滤或协同提升右侧结构卡片
  const displayStructures = useMemo(() => {
    // 优先采用勾选的身份，若无勾选但在搜索中命中身份，则优先提升命中身份的模板
    let effectiveTargetIds = selectedIdentityIds
    if (effectiveTargetIds.length === 0 && searchKeyword && filteredIdentities.length > 0) {
      effectiveTargetIds = filteredIdentities.map(i => i.identityId)
    }

    if (effectiveTargetIds.length === 0) {
      return recommendedStructures
    }

    // 若勾选了具体身份或搜索命中了身份，优先将契合的模板排在前列
    const set = new Set(effectiveTargetIds)
    const sorted = [...recommendedStructures].sort((a, b) => {
      const aHit = a.targetIdentities.some(tid => set.has(tid))
      const bHit = b.targetIdentities.some(tid => set.has(tid))
      if (aHit && !bHit) return -1
      if (!aHit && bHit) return 1
      return b.score - a.score
    })
    return sorted
  }, [selectedIdentityIds, searchKeyword, filteredIdentities, recommendedStructures])

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
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
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
              icon={isLoading ? 'progress_activity' : 'tune'}
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
              <MaterialIcon icon="progress_activity" className="text-3xl animate-spin text-primary" />
              <p className="text-sm">{t('正在协同计算最契合的目录模板...')}</p>
            </div>
          ) : displayStructures.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 max-w-4xl">
              {displayStructures.map((struct, idx) => {
                const matchPct = Math.round((struct.score || 0) * 100)
                return (
                  <div
                    key={struct.templateId || idx}
                    className="p-5 rounded-2xl border-2 border-border/70 hover:border-primary/60 bg-card hover:bg-card/90 transition-all duration-200 shadow-xs flex flex-col justify-between space-y-4"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
                            {idx + 1}
                          </div>
                          <div>
                            <h4 className="text-base font-bold text-foreground flex items-center gap-2">
                              {struct.name}
                            </h4>
                          </div>
                        </div>

                        <span
                          className={cn(
                            'text-xs font-bold px-2.5 py-0.5 rounded-full border flex items-center gap-1',
                            matchPct >= 80
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                              : 'bg-primary/10 text-primary border-primary/20'
                          )}
                        >
                          <MaterialIcon icon="verified" className="text-xs" />
                          <span>{t('{pct}% 契合度', { pct: matchPct })}</span>
                        </span>
                      </div>

                      {/* 理由说明 */}
                      <p className="text-xs text-muted-foreground leading-relaxed bg-muted/40 p-2.5 rounded-xl border border-border/40">
                        <span className="font-semibold text-foreground/85 mr-1">{t('推荐理由:')}</span>
                        {struct.rationale}
                      </p>

                      {/* 生命周期阶段标签 */}
                      {struct.lifecycleStages && struct.lifecycleStages.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="text-[11px] text-muted-foreground mr-1">
                            {t('全周期阶段:')}
                          </span>
                          {struct.lifecycleStages.map((stage, sIdx) => (
                            <Badge
                              key={sIdx}
                              variant="outline"
                              className="text-[10px] font-normal px-2 py-0.2 bg-background"
                            >
                              {stage}
                            </Badge>
                          ))}
                        </div>
                      )}

                      {/* 目录路径预览 */}
                      <div className="space-y-1.5 pt-2">
                        <span className="text-[11px] font-semibold text-foreground/80 block">
                          {t('包含的典型目录结构 ({count} 个):', { count: struct.paths.length })}
                        </span>
                        <div className="max-h-36 overflow-y-auto p-2.5 rounded-xl bg-muted/20 border border-border/40 grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-muted-foreground">
                          {struct.paths.slice(0, 10).map((path, pIdx) => (
                            <div key={pIdx} className="flex items-center gap-1.5 truncate">
                              <MaterialIcon icon="folder" className="text-xs text-amber-500 shrink-0" />
                              <span className="truncate font-mono text-[11px]">{path}</span>
                            </div>
                          ))}
                          {struct.paths.length > 10 && (
                            <div className="text-[11px] text-muted-foreground italic col-span-2 pt-1">
                              {t('... 以及另外 {more} 个子目录', {
                                more: struct.paths.length - 10
                              })}
                            </div>
                          )}
                        </div>
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
                        className="h-8 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground flex items-center gap-1.5 shadow-xs px-4"
                      >
                        <MaterialIcon icon="check" className="text-sm" />
                        <span>{t('使用此结构')}</span>
                      </Button>
                    </div>
                  </div>
                )
              })}
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
