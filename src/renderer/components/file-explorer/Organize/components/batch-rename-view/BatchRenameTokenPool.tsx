import React from 'react'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import { Input } from '../../../../ui/input'
import {
  getCommonCategoriesPartitioned,
  type DimensionTreeNode,
  type TokenCategory,
  type TokenItem
} from '../batch-rename-tokens'
import { isTokenInTemplate } from '../useBatchRenameDerived'

interface BatchRenameTokenPoolProps {
  tokenCategories: TokenCategory[]
  tokenSearch: string
  onTokenSearchChange: (value: string) => void
  selectedTokenCategory: string
  onSelectTokenCategory: (categoryId: string) => void
  template: string
  onInsertToken: (tokenValue: string) => void
}

/**
 * 批量重命名中栏下半部：属性标签资源池面板
 */
export const BatchRenameTokenPool: React.FC<BatchRenameTokenPoolProps> = ({
  tokenCategories,
  tokenSearch,
  onTokenSearchChange,
  selectedTokenCategory,
  onSelectTokenCategory,
  template,
  onInsertToken
}) => {
  const { t: scopeT } = useVoerkaI18n(i18nScope)

  let candidateCategories = tokenCategories
  if (tokenSearch.trim()) {
    if (selectedTokenCategory === 'common' || selectedTokenCategory === 'all') {
      // 搜索模式下自动扩展至全量类别，确保用户能检索到系统内所有可用属性
      candidateCategories = tokenCategories
    } else {
      candidateCategories = tokenCategories.filter(cat => cat.key === selectedTokenCategory)
    }
  } else {
    if (selectedTokenCategory === 'common') {
      candidateCategories = getCommonCategoriesPartitioned(tokenCategories, scopeT)
    } else if (selectedTokenCategory === 'all') {
      candidateCategories = tokenCategories
    } else {
      candidateCategories = tokenCategories.filter(cat => cat.key === selectedTokenCategory)
    }
  }

  const visibleCategories = candidateCategories
    .map(cat => ({
      ...cat,
      tokens: cat.tokens.filter(token =>
        tokenSearch.trim()
          ? token.label.toLowerCase().includes(tokenSearch.toLowerCase()) ||
            token.value.toLowerCase().includes(tokenSearch.toLowerCase()) ||
            (token.parentName && token.parentName.toLowerCase().includes(tokenSearch.toLowerCase()))
          : true
      )
    }))
    .filter(cat => cat.tokens.length > 0)

  const renderTokenButton = (token: TokenItem, keySuffix: string | number) => {
    const isSelfNamed = token.value.startsWith('{TAG:') || token.value.startsWith('{META:')
    const isInTemplate = isTokenInTemplate(token.value, template)

    return (
      <button
        key={keySuffix}
        type="button"
        title={
          isInTemplate
            ? t('已选入命名模板: {desc}', {
                desc: token.parentName
                  ? t('所属「{parent}」维度: {desc}', {
                      parent: token.parentName,
                      desc: token.desc
                    })
                  : token.desc
              })
            : token.parentName
              ? t('所属「{parent}」维度: {desc}', {
                  parent: token.parentName,
                  desc: token.desc
                })
              : token.desc
        }
        onClick={() => onInsertToken(token.value)}
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-all duration-150',
          'hover:-translate-y-0.5 hover:shadow-2xs active:scale-95 cursor-pointer',
          token.pillClass || 'bg-muted/30 hover:bg-primary/15 border-border/40 text-foreground',
          isInTemplate &&
            'opacity-40 hover:opacity-75 bg-muted/20 border-dashed saturate-50 ring-1 ring-primary/20'
        )}
      >
        {isSelfNamed ? (
          <span className="font-mono">{token.value}</span>
        ) : (
          <>
            <span>{token.label}</span>
            <span className="text-[10px] font-mono opacity-60 ml-0.5">{token.value}</span>
          </>
        )}
      </button>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background overflow-hidden">
      <div className="p-3 pb-2.5 border-b border-border/40 space-y-2.5 shrink-0 bg-background">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <MaterialIcon icon="touch_app" className="text-xs text-primary" />
            <span>{t('属性标签资源池')}</span>
          </div>
          <div className="relative w-36">
            <Input
              value={tokenSearch}
              onChange={e => onTokenSearchChange(e.target.value)}
              placeholder={t('过滤属性...')}
              className="h-6 text-[11px] pl-6 bg-background shadow-2xs border-border/40"
            />
            <MaterialIcon
              icon="filter_list"
              className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
            />
          </div>
        </div>

        {/* 属性分类快捷 Tab 过滤栏 */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pt-0.5">
          {[
            { id: 'common', label: t('常用'), icon: 'star' },
            { id: 'all', label: t('全部'), icon: 'apps' },
            { id: 'core', label: t('核心与作者'), icon: 'person' },
            { id: 'datetime', label: t('时间日期'), icon: 'calendar_today' },
            { id: 'dimension', label: t('分类维度'), icon: 'category' },
            { id: 'meta', label: t('元数据'), icon: 'aspect_ratio' },
            { id: 'seq', label: t('自增序号'), icon: 'format_list_numbered' }
          ].map(tab => {
            const isSelected = selectedTokenCategory === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onSelectTokenCategory(tab.id)}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium shrink-0 transition-all cursor-pointer border',
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary shadow-2xs font-semibold'
                    : 'bg-muted/25 text-muted-foreground hover:text-foreground hover:bg-muted/50 border-border/30'
                )}
              >
                <MaterialIcon icon={tab.icon} className="text-[11px]" />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
        {visibleCategories.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-xs text-muted-foreground gap-1.5 text-center px-4">
            <MaterialIcon icon="check_circle" className="text-2xl text-primary/60" />
            <span>
              {tokenSearch.trim() ? t('没有找到匹配的属性') : t('所有属性标签均已添加至上方模板')}
            </span>
          </div>
        ) : (
          visibleCategories.map((cat, catIdx) => {
            // ─── 维度体系：专用的原生维度树状层级导轨渲染 ───────────────
            if (cat.tree && cat.tree.length > 0) {
              const searchLower = tokenSearch.trim().toLowerCase()
              const filterNode = (node: DimensionTreeNode): DimensionTreeNode | null => {
                const isSelfMatch =
                  !searchLower ||
                  node.token.label.toLowerCase().includes(searchLower) ||
                  node.token.value.toLowerCase().includes(searchLower) ||
                  (node.token.parentName &&
                    node.token.parentName.toLowerCase().includes(searchLower))

                const matchedChildren =
                  !searchLower || isSelfMatch
                    ? node.children || []
                    : ((node.children || [])
                        .map(child => filterNode(child))
                        .filter(Boolean) as DimensionTreeNode[])

                if (!searchLower || isSelfMatch || matchedChildren.length > 0) {
                  return {
                    ...node,
                    children: matchedChildren
                  }
                }
                return null
              }

              const visibleRoots = cat.tree
                .map(rootNode => filterNode(rootNode))
                .filter(Boolean) as DimensionTreeNode[]

              return (
                <div key={catIdx} className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        'px-2 py-0.5 rounded text-[10px] font-bold border',
                        cat.badgeColor
                      )}
                    >
                      {cat.category}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70 font-mono">
                      {t('{count} 个可用', { count: cat.tokens.length })}
                    </span>
                  </div>

                  <div className="space-y-3">
                    {visibleRoots.map(root => (
                      <div
                        key={root.id}
                        className="rounded-lg border border-border/50 bg-muted/15 p-3 space-y-2.5 transition-all shadow-2xs"
                      >
                        {/* 顶层根节点：根维度本身即树根，无需多余 title 与 '根维度:' 文本 */}
                        <div className="flex items-center gap-1.5 pb-1.5 border-b border-border/40">
                          <MaterialIcon
                            icon="category"
                            className="text-emerald-500 text-sm shrink-0"
                          />
                          {renderTokenButton(root.token, `root-${root.id}`)}
                        </div>

                        {/* 主树干导轨 */}
                        {root.children && root.children.length > 0 && (
                          <div className="pl-3.5 ml-1 border-l-2 border-emerald-500/30 space-y-3">
                            {root.children.map((child, cIdx) => (
                              <div key={child.id} className="space-y-1.5">
                                {/* 二级节点 */}
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-[11px] text-emerald-600/70 dark:text-emerald-400/70 font-mono select-none">
                                    ├─
                                  </span>
                                  {renderTokenButton(child.token, `child-${child.id}-${cIdx}`)}
                                </div>

                                {/* 三级细分叶子节点（在二级节点下方，次级虚线导轨缩进） */}
                                {child.children && child.children.length > 0 && (
                                  <div className="pl-4 ml-3 border-l border-dashed border-emerald-500/30 flex flex-wrap gap-2 py-0.5">
                                    {child.children.map((grandChild, gIdx) => (
                                      <div key={grandChild.id} className="flex items-center gap-1">
                                        <span className="text-[10px] text-emerald-600/50 dark:text-emerald-400/50 font-mono select-none">
                                          └─
                                        </span>
                                        {renderTokenButton(
                                          grandChild.token,
                                          `sub-${child.id}-${gIdx}`
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            }

            // ─── 其他分类（核心、时间、元数据、序号）：标准网格/胶囊流 ───────
            return (
              <div key={catIdx} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      'px-2 py-0.5 rounded text-[10px] font-bold border',
                      cat.badgeColor
                    )}
                  >
                    {cat.category}
                  </span>
                  <span className="text-[10px] text-muted-foreground/70 font-mono">
                    {t('{count} 个可用', { count: cat.tokens.length })}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {cat.tokens.map((token, tIdx) =>
                    renderTokenButton(token, `cat-${catIdx}-${tIdx}`)
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
