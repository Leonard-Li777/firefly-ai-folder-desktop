import React, { useState, useEffect, useMemo } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Badge } from '../../../ui/badge'
import { toast } from '../../../common/Toast'
import { BatchRenamePreviewItem, DimensionGroup } from '@firefly/types'

const PRESET_NAMING_TEMPLATES = [
  {
    name: '智能名 + 修改日期',
    template: '{SMART_NAME}_{MOD:YYYY-MM-DD}',
    description: '标准规范，适合绝大多数工作与个人文件归档'
  },
  {
    name: '日期前缀 + 智能名',
    template: '{MOD:YYYY-MM-DD}_{SMART_NAME}',
    description: '时间线排列，按日期正序一目了然'
  },
  {
    name: '领域/主题 + 智能名',
    template: '{TAG:主题}_{SMART_NAME}',
    description: '突出主题与分类标签'
  },
  {
    name: '作者 + 智能名 + 年份',
    template: '{AUTHOR}_{SMART_NAME}_{MOD:YYYY}',
    description: '适合书籍、文献、作品集与归档素材'
  },
  {
    name: '序号 + 智能名',
    template: '{SEQ:03}_{SMART_NAME}',
    description: '三位数字序号递增（如 001_xxx）'
  },
  {
    name: '极简原名 + 时间戳',
    template: '{ORIG_NAME}_{MOD:YYYYMMDD_HHmm}',
    description: '保留原文件名并附加高精度修改时间戳'
  }
]

interface BatchRenameViewProps {
  files: any[]
  dimensionGroups?: DimensionGroup[]
  onExecuteRename: (template: string) => Promise<void>
  isExecuting?: boolean
}

export const BatchRenameView: React.FC<BatchRenameViewProps> = ({
  files,
  dimensionGroups = [],
  onExecuteRename,
  isExecuting = false
}) => {
  const [template, setTemplate] = useState<string>('{SMART_NAME}_{MOD:YYYY-MM-DD}')
  const [previewList, setPreviewList] = useState<BatchRenamePreviewItem[]>([])
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)

  // 快捷插值 Token 分类列表
  const tokenCategories = useMemo(() => {
    const dimTokens = (dimensionGroups || []).map(g => ({
      label: g.name,
      value: `{TAG:${g.name}}`,
      desc: t('匹配该文件的「{name}」维度标签', { name: g.name })
    }))

    return [
      {
        category: t('核心名称'),
        tokens: [
          { label: t('智能文件名'), value: '{SMART_NAME}', desc: t('AI 解析提取的纯净核心命名') },
          { label: t('原始文件名'), value: '{ORIG_NAME}', desc: t('文件在磁盘上的原始文件名（不含扩展名）') },
          { label: t('文件扩展名'), value: '{EXT}', desc: t('文件后缀扩展名（如 png, docx）') }
        ]
      },
      {
        category: t('时间日期'),
        tokens: [
          { label: t('修改日期(年-月-日)'), value: '{MOD:YYYY-MM-DD}', desc: t('文件最后修改日期') },
          { label: t('修改时间(年月日时分)'), value: '{MOD:YYYYMMDD_HHmm}', desc: t('精确修改时间') },
          { label: t('创建日期(年-月-日)'), value: '{CRE:YYYY-MM-DD}', desc: t('文件创建日期') }
        ]
      },
      {
        category: t('分类维度与作者'),
        tokens: [
          ...dimTokens,
          { label: t('作者/创作者'), value: '{AUTHOR}', desc: t('内容作者标签') },
          { label: t('语言代码'), value: '{LANG}', desc: t('文档语言') }
        ]
      },
      {
        category: t('元数据与序号'),
        tokens: [
          { label: t('自增序号(01)'), value: '{SEQ:01}', desc: t('两位补零序号') },
          { label: t('自增序号(001)'), value: '{SEQ:001}', desc: t('三位补零序号') },
          { label: t('质量评分'), value: '{QUALITY_SCORE}', desc: t('AI 质量分值') },
          { label: t('文件大小'), value: '{SIZE}', desc: t('友好文件大小 (如 12MB)') },
          { label: t('分辨率'), value: '{META:分辨率}', desc: t('图片/视频分辨率') }
        ]
      }
    ]
  }, [dimensionGroups])

  // 实时更新重命名预览
  useEffect(() => {
    let isMounted = true
    const updatePreview = async () => {
      if (!files || files.length === 0) {
        setPreviewList([])
        return
      }
      setIsLoadingPreview(true)
      try {
        if (window.electronAPI?.organizeBatch?.previewRename) {
          const previews = await window.electronAPI.organizeBatch.previewRename(template, files)
          if (isMounted) setPreviewList(previews)
        }
      } catch (e) {
        console.error('生成重命名预览失败:', e)
      } finally {
        if (isMounted) setIsLoadingPreview(false)
      }
    }

    const timer = setTimeout(updatePreview, 150)
    return () => {
      isMounted = false
      clearTimeout(timer)
    }
  }, [template, files])

  // 插入 Token 到当前模板末尾
  const handleInsertToken = (tokenValue: string) => {
    setTemplate(prev => {
      if (!prev) return tokenValue
      return `${prev}_${tokenValue}`
    })
  }

  // 切换随机模板
  const handleRandomTemplate = async () => {
    try {
      if (window.electronAPI?.organizeBatch?.getRandomTemplate) {
        const rand = await window.electronAPI.organizeBatch.getRandomTemplate()
        if (rand) {
          setTemplate(rand)
          toast.success(t('已应用随机命名模板'))
        }
      }
    } catch {
      const presets = PRESET_NAMING_TEMPLATES
      const rand = presets[Math.floor(Math.random() * presets.length)].template
      setTemplate(rand)
    }
  }

  return (
    <div className="flex-1 flex overflow-hidden bg-background">
      {/* ─── 左栏：常用模板候选列表 ────────────────────────────────────────── */}
      <div className="w-64 border-r border-border/60 flex flex-col bg-muted/10 shrink-0">
        <div className="p-3 border-b border-border/50 flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <MaterialIcon icon="bookmarks" className="text-sm text-primary" />
            {t('推荐命名模板')}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {PRESET_NAMING_TEMPLATES.map((item, idx) => {
            const isSelected = template === item.template
            return (
              <div
                key={idx}
                onClick={() => setTemplate(item.template)}
                className={cn(
                  'p-2.5 rounded-xl border text-left cursor-pointer transition-all duration-200',
                  isSelected
                    ? 'border-primary/50 bg-primary/10 text-primary shadow-xs'
                    : 'border-border/40 hover:border-border hover:bg-muted/30 text-foreground'
                )}
              >
                <div className="font-medium text-xs truncate">{item.name}</div>
                <div className="text-[11px] font-mono text-muted-foreground mt-1 truncate bg-background/60 px-1.5 py-0.5 rounded border border-border/30">
                  {item.template}
                </div>
                <div className="text-[10px] text-muted-foreground/80 mt-1 line-clamp-1">
                  {item.description}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ─── 中栏：DSL 模板编排与变量选择 ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col border-r border-border/60 min-w-[340px] overflow-hidden bg-card/40">
        <div className="p-4 border-b border-border/50 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <MaterialIcon icon="edit" className="text-sm text-primary" />
              {t('模板编排编辑区')}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRandomTemplate}
              className="h-7 text-xs gap-1 rounded-lg border-primary/30 hover:bg-primary/10 text-primary"
            >
              <MaterialIcon icon="casino" className="text-sm" />
              {t('🎲 随机模板')}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Input
              value={template}
              onChange={e => setTemplate(e.target.value)}
              placeholder={t('输入或点击下方标签组合重命名模板')}
              className="font-mono text-xs h-9 bg-background focus-visible:ring-primary"
            />
            <div className="text-[11px] text-muted-foreground flex items-center gap-1">
              <MaterialIcon icon="info" className="text-xs text-primary/70" />
              <span>{t('重命名时将自动折叠连续下划线并清除两端冗余符号')}</span>
            </div>
          </div>
        </div>

        {/* 插值 Label 分组选择区 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="text-xs font-semibold text-muted-foreground">
            {t('点击属性标签插入至模板：')}
          </div>

          {tokenCategories.map((cat, catIdx) => (
            <div key={catIdx} className="space-y-2">
              <div className="text-[11px] font-medium text-foreground/80">{cat.category}</div>
              <div className="flex flex-wrap gap-1.5">
                {cat.tokens.map((token, tIdx) => (
                  <button
                    key={tIdx}
                    type="button"
                    title={token.desc}
                    onClick={() => handleInsertToken(token.value)}
                    className={cn(
                      'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium',
                      'bg-muted/40 hover:bg-primary/15 border border-border/50 hover:border-primary/40',
                      'text-foreground transition-all duration-150 active:scale-95'
                    )}
                  >
                    <MaterialIcon icon="add" className="text-[11px] text-muted-foreground" />
                    <span>{token.label}</span>
                    <span className="text-[10px] font-mono text-muted-foreground opacity-60">
                      {token.value}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── 右栏：实时文件更名预览双栏对照 ────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-[360px] overflow-hidden bg-background">
        <div className="p-3 border-b border-border/50 flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <MaterialIcon icon="preview" className="text-sm text-primary" />
            {t('更名效果实时对照 ({count})', { count: previewList.length })}
          </span>
          {isLoadingPreview && (
            <span className="text-[11px] text-muted-foreground flex items-center gap-1">
              <MaterialIcon icon="sync" className="text-xs animate-spin" />
              {t('计算中...')}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {previewList.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">
              {t('暂无待重命名文件')}
            </div>
          ) : (
            previewList.map((item, idx) => (
              <div
                key={item.fileId || idx}
                className={cn(
                  'p-2.5 rounded-xl border text-xs space-y-1.5 transition-colors',
                  item.hasError
                    ? 'border-destructive/40 bg-destructive/5'
                    : 'border-border/50 bg-card/60 hover:border-border'
                )}
              >
                <div className="flex items-center justify-between text-muted-foreground text-[11px]">
                  <span className="truncate max-w-[200px]" title={item.currentName}>
                    {item.currentName}
                  </span>
                  <MaterialIcon icon="arrow_forward" className="text-xs shrink-0 text-primary/60" />
                </div>
                <div className="font-mono font-medium text-foreground text-xs break-all flex items-center gap-1">
                  <MaterialIcon icon="description" className="text-xs text-primary shrink-0" />
                  <span className="text-primary font-semibold">{item.newName}</span>
                </div>
                {item.hasError && (
                  <div className="text-[10px] text-destructive">{item.errorMessage}</div>
                )}
              </div>
            ))
          )}
        </div>

        {/* 底部操作区 */}
        <div className="p-3 border-t border-border/50 bg-muted/10 flex items-center justify-between shrink-0">
          <span className="text-xs text-muted-foreground">
            {t('共 {count} 个文件准备就绪', { count: previewList.length })}
          </span>
          <Button
            id="btn-execute-rename-trigger"
            size="sm"
            onClick={() => onExecuteRename(template)}
            disabled={isExecuting || previewList.length === 0}
            className="h-8 px-4 text-xs font-bold gap-1.5 bg-primary hover:bg-primary/90 shadow-xs"
          >
            <MaterialIcon
              icon={isExecuting ? 'sync' : 'check'}
              className={cn('text-sm', isExecuting && 'animate-spin')}
            />
            <span>{isExecuting ? t('正在更名...') : t('执行更名')}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
