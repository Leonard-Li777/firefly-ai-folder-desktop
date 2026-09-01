import React, { useMemo, useCallback } from 'react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Checkbox } from '../ui/checkbox'
import { Switch } from '../ui/switch'
import { useSettingsStore } from '../../stores/settings-store'
import { AppConfig } from '@firefly/types'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import {
  LayoutGrid,
  List,
  Layers,
  Star,
  FileText,
  Tag,
  User,
  Globe,
  Calendar,
  Check,
  Sparkles,
  Info
} from 'lucide-react'

/**
 * 字段对应的图标与色彩
 */
const FIELD_META: Record<
  AppConfig['fileListExtraFields'][0],
  { icon: React.FC<{ className?: string }>; colorClass: string }
> = {
  qualityScore: { icon: Star, colorClass: 'text-amber-500 bg-amber-50 dark:bg-amber-950/60' },
  description: { icon: FileText, colorClass: 'text-blue-500 bg-blue-50 dark:bg-blue-950/60' },
  tags: { icon: Tag, colorClass: 'text-purple-500 bg-purple-50 dark:bg-purple-950/60' },
  author: { icon: User, colorClass: 'text-emerald-500 bg-emerald-50 dark:bg-emerald-950/60' },
  language: { icon: Globe, colorClass: 'text-cyan-500 bg-cyan-50 dark:bg-cyan-950/60' },
  analyzedAt: { icon: Calendar, colorClass: 'text-orange-500 bg-orange-50 dark:bg-orange-950/60' }
}

/**
 * 文件显示设置组件
 */
export const FileDisplaySettings: React.FC = () => {
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)

  /**
   * 可选的额外显示字段
   */
  const extraFieldOptions = useMemo(
    () => [
      {
        value: 'qualityScore' as const,
        label: t('质量评分'),
        description: t('显示AI评估的文件质量分数（1-10分）')
      },
      {
        value: 'description' as const,
        label: t('文件描述'),
        description: t('显示AI生成的文件内容摘要描述')
      },
      {
        value: 'tags' as const,
        label: t('标签'),
        description: t('显示文件的AI分类标签')
      },
      {
        value: 'author' as const,
        label: t('作者'),
        description: t('显示文件作者信息')
      },
      {
        value: 'language' as const,
        label: t('语言'),
        description: t('显示文件的主要语言环境')
      },
      {
        value: 'analyzedAt' as const,
        label: t('分析日期'),
        description: t('显示文件最近一次AI分析的时间')
      }
    ],
    [activeLanguage]
  )

  /**
   * 视图模式选项
   */
  const viewModeOptions = useMemo(
    () => [
      { value: 'grid', label: t('网格视图'), description: t('以卡片网格形式高效展示文件') },
      { value: 'list', label: t('列表视图'), description: t('以详细数据表展示全量元数据') },
      {
        value: 'waterfall',
        label: t('瀑布流视图'),
        description: t('错落有致展现多媒体图像与文件')
      }
    ],
    [activeLanguage]
  )

  /**
   * 处理字段选择变更
   */
  const handleFieldToggle = useCallback(
    (field: AppConfig['fileListExtraFields'][0], checked: boolean) => {
      const currentFields =
        getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS') || []

      let newFields: AppConfig['fileListExtraFields']
      if (checked) {
        newFields = currentFields.includes(field) ? currentFields : [...currentFields, field]
      } else {
        newFields = currentFields.filter(f => f !== field)
      }

      updateConfigValue('FILE_LIST_EXTRA_FIELDS', newFields)
    },
    [getConfigValue, updateConfigValue]
  )

  /**
   * 检查字段是否被选中
   */
  const isFieldSelected = useCallback(
    (field: AppConfig['fileListExtraFields'][0]) => {
      const currentFields =
        getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')
      return currentFields?.includes(field) || false
    },
    [getConfigValue]
  )

  const currentView = getConfigValue<'grid' | 'list' | 'waterfall'>('DEFAULT_VIEW') || 'grid'
  const activeFields =
    getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS') || []

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2 text-foreground">{t('文件显示设置')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('自定义文件浏览时的视图布局及额外显示的 AI 元数据字段')}
        </p>
      </div>

      {/* 默认视图模式 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium text-card-foreground">
              {t('默认视图模式')}
            </Label>
            <p className="text-sm text-muted-foreground mt-1">
              {t('设置打开文件目录时的默认显示呈现形式')}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            {viewModeOptions.map(option => {
              const isSelected = currentView === option.value

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => updateConfigValue('DEFAULT_VIEW', option.value)}
                  className={cn(
                    'relative flex flex-col p-3 rounded-xl border-2 transition-all text-left focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    isSelected
                      ? 'border-primary bg-primary/5 dark:bg-primary/10 shadow-sm ring-1 ring-primary/20'
                      : 'border-border bg-background hover:border-muted-foreground/40 hover:shadow-sm'
                  )}
                >
                  {/* 右上角 Check Badge */}
                  {isSelected && (
                    <div className="absolute top-2.5 right-2.5 z-10 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow">
                      <Check className="w-3.5 h-3.5 stroke-[3]" />
                    </div>
                  )}

                  {/* 视图微缩示意图 */}
                  <div className="w-full h-20 rounded-lg overflow-hidden border border-border/60 mb-3 bg-muted/40 p-2 flex items-center justify-center relative shadow-xs">
                    {option.value === 'grid' && (
                      <div className="grid grid-cols-2 gap-1.5 w-full h-full">
                        <div className="bg-background rounded border border-border/70 flex flex-col items-center justify-center p-1">
                          <div className="w-4 h-4 rounded bg-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center text-[9px] font-bold">
                            PDF
                          </div>
                        </div>
                        <div className="bg-background rounded border border-border/70 flex flex-col items-center justify-center p-1">
                          <div className="w-4 h-4 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-[9px] font-bold">
                            IMG
                          </div>
                        </div>
                        <div className="bg-background rounded border border-border/70 flex flex-col items-center justify-center p-1">
                          <div className="w-4 h-4 rounded bg-purple-500/20 text-purple-600 dark:text-purple-400 flex items-center justify-center text-[9px] font-bold">
                            DOC
                          </div>
                        </div>
                        <div className="bg-background rounded border border-border/70 flex flex-col items-center justify-center p-1">
                          <div className="w-4 h-4 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center text-[9px] font-bold">
                            ZIP
                          </div>
                        </div>
                      </div>
                    )}

                    {option.value === 'list' && (
                      <div className="flex flex-col gap-1.5 w-full h-full justify-center">
                        <div className="h-4 bg-background rounded border border-border/70 flex items-center px-1.5 justify-between">
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full bg-blue-500" />
                            <div className="w-10 h-1.5 bg-foreground/30 rounded" />
                          </div>
                          <div className="w-6 h-1.5 bg-muted-foreground/30 rounded" />
                        </div>
                        <div className="h-4 bg-background rounded border border-border/70 flex items-center px-1.5 justify-between">
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full bg-emerald-500" />
                            <div className="w-12 h-1.5 bg-foreground/30 rounded" />
                          </div>
                          <div className="w-6 h-1.5 bg-muted-foreground/30 rounded" />
                        </div>
                        <div className="h-4 bg-background rounded border border-border/70 flex items-center px-1.5 justify-between">
                          <div className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-full bg-purple-500" />
                            <div className="w-8 h-1.5 bg-foreground/30 rounded" />
                          </div>
                          <div className="w-6 h-1.5 bg-muted-foreground/30 rounded" />
                        </div>
                      </div>
                    )}

                    {option.value === 'waterfall' && (
                      <div className="grid grid-cols-3 gap-1.5 w-full h-full items-start">
                        <div className="flex flex-col gap-1">
                          <div className="h-10 bg-background rounded border border-border/70 bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-950 dark:to-indigo-950" />
                          <div className="h-5 bg-background rounded border border-border/70" />
                        </div>
                        <div className="flex flex-col gap-1">
                          <div className="h-6 bg-background rounded border border-border/70" />
                          <div className="h-9 bg-background rounded border border-border/70 bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-950 dark:to-pink-950" />
                        </div>
                        <div className="flex flex-col gap-1">
                          <div className="h-8 bg-background rounded border border-border/70 bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-950 dark:to-orange-950" />
                          <div className="h-6 bg-background rounded border border-border/70" />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {option.value === 'grid' && <LayoutGrid className="w-4 h-4 text-blue-500" />}
                    {option.value === 'list' && <List className="w-4 h-4 text-emerald-500" />}
                    {option.value === 'waterfall' && <Layers className="w-4 h-4 text-purple-500" />}
                    <span className="font-medium text-sm text-foreground">{option.label}</span>
                  </div>

                  <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                    {option.description}
                  </p>
                </button>
              )
            })}
          </div>
        </div>
      </Card>

      {/* 额外显示字段设置 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium text-card-foreground">
              {t('文件列表额外显示字段')}
            </Label>
            <p className="text-sm text-muted-foreground mt-1">
              {t('勾选要在文件列表及卡片中额外展示的 AI 维度数据')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {extraFieldOptions.map(option => {
              const selected = isFieldSelected(option.value)
              const meta = FIELD_META[option.value]
              const IconComponent = meta.icon

              return (
                <div
                  key={option.value}
                  onClick={() => handleFieldToggle(option.value, !selected)}
                  className={cn(
                    'relative flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all',
                    selected
                      ? 'border-primary bg-primary/5 dark:bg-primary/10 shadow-xs'
                      : 'border-border bg-background hover:border-muted-foreground/30'
                  )}
                >
                  <Checkbox
                    id={`field-${option.value}`}
                    checked={selected}
                    className="mt-0.5"
                    onCheckedChange={checked => handleFieldToggle(option.value, checked as boolean)}
                  />
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <div className={cn('p-1 rounded-md', meta.colorClass)}>
                        <IconComponent className="w-3.5 h-3.5" />
                      </div>
                      <Label
                        htmlFor={`field-${option.value}`}
                        className="text-sm font-medium cursor-pointer text-foreground"
                      >
                        {option.label}
                      </Label>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {option.description}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </Card>

      {/* 实时动态视图示例与效果预览 (固定为列表视图) */}
      <Card className="p-4 bg-card dark:bg-card border-primary/20">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <Label className="text-base font-medium text-card-foreground">
                {t('文件列表效果示例预览')}
              </Label>
            </div>
            <span className="text-xs text-muted-foreground bg-muted px-2.5 py-1 rounded-full font-medium">
              {t('列表视图效果')}
            </span>
          </div>

          {/* 列表试图效果预览区 */}
          <div className="border rounded-xl bg-background overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="bg-muted/60 text-muted-foreground border-b border-border select-none">
                <tr>
                  <th className="p-2.5 text-left font-medium whitespace-nowrap">{t('名称')}</th>
                  {activeFields.includes('qualityScore') && (
                    <th className="p-2.5 text-left font-medium whitespace-nowrap">
                      {t('质量评分')}
                    </th>
                  )}
                  {activeFields.includes('description') && (
                    <th className="p-2.5 text-left font-medium whitespace-nowrap">
                      {t('文件描述')}
                    </th>
                  )}
                  {activeFields.includes('tags') && (
                    <th className="p-2.5 text-left font-medium whitespace-nowrap">{t('标签')}</th>
                  )}
                  {activeFields.includes('author') && (
                    <th className="p-2.5 text-left font-medium whitespace-nowrap">{t('作者')}</th>
                  )}
                  {activeFields.includes('language') && (
                    <th className="p-2.5 text-left font-medium whitespace-nowrap">{t('语言')}</th>
                  )}
                  {activeFields.includes('analyzedAt') && (
                    <th className="p-2.5 text-left font-medium whitespace-nowrap">
                      {t('分析日期')}
                    </th>
                  )}
                  <th className="p-2.5 text-left font-medium whitespace-nowrap">{t('修改日期')}</th>
                  <th className="p-2.5 text-left font-medium whitespace-nowrap">{t('大小')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                <tr className="hover:bg-muted/20 transition-colors">
                  <td className="p-2.5 font-medium whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400 font-bold text-[10px] flex items-center justify-center shrink-0">
                        PDF
                      </span>
                      <span>示例文件.pdf</span>
                    </div>
                  </td>
                  {activeFields.includes('qualityScore') && (
                    <td className="p-2.5 whitespace-nowrap">
                      <div className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-semibold bg-amber-50 dark:bg-amber-950/60 px-2 py-0.5 rounded border border-amber-200/50 dark:border-amber-800/40">
                        <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-500 shrink-0" />
                        <span>4.2 分</span>
                      </div>
                    </td>
                  )}
                  {activeFields.includes('description') && (
                    <td className="p-2.5 text-muted-foreground whitespace-nowrap max-w-[200px] truncate">
                      {t('技术文档，包含API接口规范说明')}
                    </td>
                  )}
                  {activeFields.includes('tags') && (
                    <td className="p-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <span className="bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 px-1.5 py-0.5 rounded text-[10px] font-medium">
                          {t('文档')}
                        </span>
                        <span className="bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 px-1.5 py-0.5 rounded text-[10px] font-medium">
                          API
                        </span>
                      </div>
                    </td>
                  )}
                  {activeFields.includes('author') && (
                    <td className="p-2.5 text-muted-foreground whitespace-nowrap">{t('张三')}</td>
                  )}
                  {activeFields.includes('language') && (
                    <td className="p-2.5 text-muted-foreground whitespace-nowrap">{t('中文')}</td>
                  )}
                  {activeFields.includes('analyzedAt') && (
                    <td className="p-2.5 text-muted-foreground whitespace-nowrap">
                      2024/01/15 14:30
                    </td>
                  )}
                  <td className="p-2.5 text-muted-foreground whitespace-nowrap">
                    2024/01/15 14:30
                  </td>
                  <td className="p-2.5 text-muted-foreground whitespace-nowrap">2.5 MB</td>
                </tr>

                <tr className="hover:bg-muted/20 transition-colors">
                  <td className="p-2.5 font-medium whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400 font-bold text-[10px] flex items-center justify-center shrink-0">
                        PNG
                      </span>
                      <span>控制台界面原型.png</span>
                    </div>
                  </td>
                  {activeFields.includes('qualityScore') && (
                    <td className="p-2.5 whitespace-nowrap">
                      <div className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-semibold bg-amber-50 dark:bg-amber-950/60 px-2 py-0.5 rounded border border-amber-200/50 dark:border-amber-800/40">
                        <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-500 shrink-0" />
                        <span>4.8 分</span>
                      </div>
                    </td>
                  )}
                  {activeFields.includes('description') && (
                    <td className="p-2.5 text-muted-foreground whitespace-nowrap max-w-[200px] truncate">
                      {t('仪表盘UI设计图')}
                    </td>
                  )}
                  {activeFields.includes('tags') && (
                    <td className="p-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <span className="bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-300 px-1.5 py-0.5 rounded text-[10px] font-medium">
                          {t('设计')}
                        </span>
                        <span className="bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 px-1.5 py-0.5 rounded text-[10px] font-medium">
                          UI
                        </span>
                      </div>
                    </td>
                  )}
                  {activeFields.includes('author') && (
                    <td className="p-2.5 text-muted-foreground whitespace-nowrap">{t('李四')}</td>
                  )}
                  {activeFields.includes('language') && (
                    <td className="p-2.5 text-muted-foreground whitespace-nowrap">-</td>
                  )}
                  {activeFields.includes('analyzedAt') && (
                    <td className="p-2.5 text-muted-foreground whitespace-nowrap">
                      2024/01/14 09:15
                    </td>
                  )}
                  <td className="p-2.5 text-muted-foreground whitespace-nowrap">
                    2024/01/14 09:15
                  </td>
                  <td className="p-2.5 text-muted-foreground whitespace-nowrap">1.2 MB</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      {/* 主要文件名显示设置 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium text-card-foreground">
              {t('主要文件名显示')}
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              {t('选择文件列表中以哪个名称作为主要显示字段')}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              {
                value: false,
                label: t('智能文件名'),
                desc: t('以AI生成的智能文件名为主，真实文件名为辅')
              },
              {
                value: true,
                label: t('真实文件名'),
                desc: t('以真实文件名为准，智能文件名作为辅助显示')
              }
            ].map(option => {
              const isSelected =
                (getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false) === option.value
              return (
                <button
                  key={String(option.value)}
                  type="button"
                  onClick={() => updateConfigValue('SWAP_FILE_NAME_DISPLAY', option.value)}
                  className={cn(
                    'relative flex flex-col p-3 rounded-xl border-2 transition-all text-left focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    isSelected
                      ? 'border-primary bg-primary/5 dark:bg-primary/10 shadow-sm ring-1 ring-primary/20'
                      : 'border-border bg-background hover:border-muted-foreground/40 hover:shadow-sm'
                  )}
                >
                  {isSelected && (
                    <div className="absolute top-2.5 right-2.5 z-10 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow">
                      <Check className="w-3.5 h-3.5 stroke-[3]" />
                    </div>
                  )}
                  <div className="flex items-center gap-2 mb-2">
                    <div
                      className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold',
                        option.value
                          ? 'bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400'
                          : 'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400'
                      )}
                    >
                      {option.value ? 'N' : 'AI'}
                    </div>
                    <span className="font-medium text-sm text-foreground">{option.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{option.desc}</p>
                </button>
              )
            })}
          </div>

          {/* 网格/瀑布流视图显示完整文件名开关 */}
          <div className="flex items-start justify-between pt-3 mt-1 border-t border-border/50">
            <div className="space-y-1">
              <Label
                htmlFor="grid-show-full-file-name"
                className="text-sm font-medium cursor-pointer text-card-foreground"
              >
                {t('网格/瀑布流视图显示完整文件名')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('关闭后，网格/瀑布流视图中文件名超出显示宽度时将省略（真实与智能文件名一致）')}
              </p>
            </div>
            <div className="flex items-center space-x-2 pt-0.5">
              <Switch
                id="grid-show-full-file-name"
                checked={getConfigValue<boolean>('GRID_SHOW_FULL_FILE_NAME') ?? false}
                onCheckedChange={checked => updateConfigValue('GRID_SHOW_FULL_FILE_NAME', checked)}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* 丢失文件显示设置 */}
      <Card className="p-4 bg-card dark:bg-card">
        <div className="flex items-start justify-between space-x-4">
          <div className="space-y-1">
            <Label
              htmlFor="show-missing-files"
              className="text-base font-medium cursor-pointer text-card-foreground"
            >
              {t('显示丢失文件')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('在文件列表中保留在物理磁盘上已移动或删除的受损文件路径，并以红色提示标注')}
            </p>
          </div>
          <div className="flex items-center space-x-2 pt-0.5">
            <Switch
              id="show-missing-files"
              checked={getConfigValue<boolean>('SHOW_MISSING_FILES') ?? true}
              onCheckedChange={checked => updateConfigValue('SHOW_MISSING_FILES', checked)}
            />
          </div>
        </div>
      </Card>

      {/* 提示信息 */}
      <Card className="p-4 bg-muted/40 border-border">
        <div className="flex items-start gap-2.5">
          <Info className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground">{t('使用提示')}</p>
            <ul className="space-y-0.5 list-disc list-inside">
              <li>{t('额外字段只有在文件完成 AI 分析后才会显示')}</li>
              <li>{t('选择过多字段可能会对单屏展现密度产生微调')}</li>
              <li>{t('所选设置会即时同步应用至文件浏览器全量视图')}</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  )
}
