import React from 'react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Checkbox } from '../ui/checkbox'
import { RadioGroup } from '../ui/radio-group'
import { useSettingsStore } from '../../stores/settings-store'
import { AppConfig } from '@yonuc/types'
import { t } from '@app/languages'

/**
 * 文件显示设置组件
 */
export const FileDisplaySettings: React.FC = () => {
  const { config, updateConfig, getConfigValue, updateConfigValue } = useSettingsStore()

  /**
   * 可选的额外显示字段
   */
  const extraFieldOptions = [
    {
      value: 'qualityScore' as const,
      label: t('质量评分'),
      description: t('显示AI评估的文件质量分数（1-5分）')
    },
    {
      value: 'description' as const,
      label: t('文件描述'),
      description: t('显示AI生成的文件内容描述')
    },
    {
      value: 'tags' as const,
      label: t('标签'),
      description: t('显示文件的分类标签')
    },
    {
      value: 'author' as const,
      label: t('作者'),
      description: t('显示文件作者信息（如果可用）')
    },
    {
      value: 'language' as const,
      label: t('语言'),
      description: t('显示文件的语言信息')
    }
  ]


  /**
   * 视图模式选项
   */
  const viewModeOptions = [
    { value: 'grid', label: t('网格视图'), description: t('以缩略图网格形式显示文件') },
    { value: 'list', label: t('列表视图'), description: t('以详细列表形式显示文件') }
  ]

  /**
   * 处理字段选择变更
   */
  const handleFieldToggle = (field: AppConfig['fileListExtraFields'][0], checked: boolean) => {
    const currentFields = getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS') || []
    
    let newFields: AppConfig['fileListExtraFields']
    if (checked) {
      // 添加字段（如果不存在）
      newFields = currentFields.includes(field) 
        ? currentFields 
        : [...currentFields, field]
    } else {
      // 移除字段
      newFields = currentFields.filter(f => f !== field)
    }
    
    updateConfigValue('FILE_LIST_EXTRA_FIELDS', newFields)
  }

  /**
   * 检查字段是否被选中
   */
  const isFieldSelected = (field: AppConfig['fileListExtraFields'][0]) => {
    const currentFields = getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')
    return currentFields?.includes(field) || false
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2 text-foreground dark:text-foreground">{t('文件显示设置')}</h3>
        <p className="text-sm text-muted-foreground dark:text-muted-foreground">
          {t('自定义文件列表中显示的额外信息字段')}
        </p>
      </div>


      {/* 默认视图模式 */}
      <Card className="p-4">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium text-foreground dark:text-foreground">{t('默认视图模式')}</Label>
            <p className="text-sm text-muted-foreground dark:text-muted-foreground mt-1">
              {t('设置打开文件目录时的默认显示模式')}
            </p>
          </div>

          <RadioGroup
            value={getConfigValue<'grid' | 'list'>('DEFAULT_VIEW') || 'grid'}
            onValueChange={(value) => updateConfigValue('DEFAULT_VIEW', value)}
            className="space-y-3"
          >
            {viewModeOptions.map((option) => (
              <div key={option.value} className="flex items-start space-x-3">
                <div className="flex items-center space-x-2">
                  <input
                    type="radio"
                    id={`view-${option.value}`}
                    name="defaultView"
                    value={option.value}
                    checked={(getConfigValue<'grid' | 'list'>('DEFAULT_VIEW') || 'grid') === option.value}
                    onChange={(e) => updateConfigValue('DEFAULT_VIEW', e.target.value)}
                    className="h-4 w-4 text-primary border-gray-300 focus:ring-primary"
                  />
                  <Label htmlFor={`view-${option.value}`} className="font-medium text-foreground dark:text-foreground">
                    {option.label}
                  </Label>
                </div>
                <p className="text-sm text-muted-foreground dark:text-muted-foreground ml-6">
                  {option.description}
                </p>
              </div>
            ))}
          </RadioGroup>
        </div>
      </Card>

      {/* 额外显示字段设置 */}
      <Card className="p-4">
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium text-foreground dark:text-foreground">{t('文件列表额外显示字段')}</Label>
            <p className="text-sm text-muted-foreground dark:text-muted-foreground mt-1">
              {t('选择在文件列表中额外显示的信息字段，这些字段将在文件名、大小、修改时间等基础信息之外显示')}
            </p>
          </div>

          <div className="space-y-4">
            {extraFieldOptions.map((option) => (
              <div key={option.value} className="flex items-start space-x-3">
                <Checkbox
                  id={`field-${option.value}`}
                  checked={isFieldSelected(option.value)}
                  className='mt-2'
                  onCheckedChange={(checked) => handleFieldToggle(option.value, checked as boolean)}
                />
                <div className="flex-1 space-y-1">
                  <Label 
                    htmlFor={`field-${option.value}`}
                    className="text-sm font-medium cursor-pointer text-foreground dark:text-foreground"
                  >
                    {option.label}
                  </Label>
                  <p className="text-sm text-muted-foreground dark:text-muted-foreground">
                    {option.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* 预览区域 */}
      <Card className="p-4 bg-muted/30">
        <div className="space-y-3">
          <Label className="text-base font-medium text-foreground dark:text-foreground">{t('预览')}</Label>
          
          <div className="space-y-2">
            <p className="text-sm text-foreground dark:text-foreground">
              {t('默认视图:')} <span className="font-medium">{viewModeOptions.find(v => v.value === getConfigValue('DEFAULT_VIEW'))?.label}</span>
            </p>
            <p className="text-sm text-muted-foreground dark:text-muted-foreground mt-2">
              {t('已选择的额外显示字段:')}
            </p>
            
            {(() => {
              const selectedFields = getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')
              return selectedFields && selectedFields.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {selectedFields.map((field) => {
                    const option = extraFieldOptions.find(opt => opt.value === field)
                    return (
                      <span 
                        key={field}
                        className="inline-flex items-center px-2 py-1 rounded-md bg-primary/10 text-primary text-xs font-medium"
                      >
                        {option?.label}
                      </span>
                    )
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  {t('未选择任何额外字段，将只显示基础文件信息')}
                </p>
              )
            })()}
          </div>

          {/* 模拟文件列表预览 - 表格样式 */}
          <div className="mt-4 border rounded-md bg-background dark:bg-background overflow-hidden">
            <div className="text-xs text-muted-foreground dark:text-muted-foreground p-2 bg-muted dark:bg-muted border-b border-border dark:border-border">{t('文件列表预览:')}: </div>
            <table className="w-full text-sm">
              <thead className="text-xs text-foreground/80 dark:text-foreground/80 bg-muted dark:bg-muted">
                <tr>
                  <th className="p-2 text-left font-medium text-foreground dark:text-foreground">{t('名称')}</th>
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('qualityScore') && (
                    <th className="p-2 text-left font-medium text-foreground dark:text-foreground">{t('质量评分')}</th>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('description') && (
                    <th className="p-2 text-left font-medium text-foreground dark:text-foreground">{t('描述')}</th>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('tags') && (
                    <th className="p-2 text-left font-medium text-foreground dark:text-foreground">{t('标签')}</th>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('author') && (
                    <th className="p-2 text-left font-medium text-foreground dark:text-foreground">{t('作者')}</th>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('language') && (
                    <th className="p-2 text-left font-medium text-foreground dark:text-foreground">{t('语言')}</th>
                  )}
                  <th className="p-2 text-left font-medium text-foreground dark:text-foreground">{t('修改日期')}</th>
                  <th className="p-2 text-left font-medium text-foreground dark:text-foreground">{t('大小')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t hover:bg-muted-foreground/10">
                  <td className="p-2 flex items-center">
                    <span className="material-icons text-red-500 mr-2 text-base">description</span>
                    <span className="font-medium">{t('示例文件.pdf')}</span>
                  </td>
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('qualityScore') && (
                    <td className="p-2 text-muted-foreground">⭐⭐⭐⭐ (4.2/5)</td>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('description') && (
                    <td className="p-2 text-muted-foreground">{t('技术文档，包含API使用说明')}</td>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('tags') && (
                    <td className="p-2">
                      <div className="flex gap-1 flex-wrap">
                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">{t('文档')}</span>
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">{t('技术')}</span>
                        <span className="text-xs bg-purple-100 text-purple-800 px-2 py-1 rounded">API</span>
                      </div>
                    </td>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('author') && (
                    <td className="p-2 text-muted-foreground">{t('张三')}</td>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('language') && (
                    <td className="p-2 text-muted-foreground">{t('中文')}</td>
                  )}
                  <td className="p-2 text-muted-foreground">2024/01/15 14:30</td>
                  <td className="p-2 text-muted-foreground">2.5 MB</td>
                </tr>
                <tr className="border-t hover:bg-muted-foreground/10">
                  <td className="p-2 flex items-center">
                    <span className="material-icons text-blue-500 mr-2 text-base">image</span>
                    <span className="font-medium">{t('设计图.png')}</span>
                  </td>
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('qualityScore') && (
                    <td className="p-2 text-muted-foreground">⭐⭐⭐⭐⭐ (4.8/5)</td>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('description') && (
                    <td className="p-2 text-muted-foreground">{t('UI界面设计图，包含主要页面布局')}</td>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('tags') && (
                    <td className="p-2">
                      <div className="flex gap-1 flex-wrap">
                        <span className="text-xs bg-pink-100 text-pink-800 px-2 py-1 rounded">{t('设计')}</span>
                        <span className="text-xs bg-indigo-100 text-indigo-800 px-2 py-1 rounded">UI</span>
                      </div>
                    </td>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('author') && (
                    <td className="p-2 text-muted-foreground">{t('李四')}</td>
                  )}
                  {getConfigValue<AppConfig['fileListExtraFields']>('FILE_LIST_EXTRA_FIELDS')?.includes('language') && (
                    <td className="p-2 text-muted-foreground">-</td>
                  )}
                  <td className="p-2 text-muted-foreground">2024/01/14 09:15</td>
                  <td className="p-2 text-muted-foreground">1.2 MB</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      {/* 提示信息 */}
      <Card className="p-4 bg-muted border-foreground">
        <div className="flex items-start gap-2">
          <div className="text-blue-600 mt-0.5">💡</div>
          <div className="text-sm text-foreground/50">
            <p className="font-medium mb-1">{t('提示')}</p>
            <ul className="space-y-1">
              <li>• {t('额外字段只有在文件经过AI分析后才会显示')}</li>
              <li>• {t('选择过多字段可能会影响文件列表的显示性能')}</li>
              <li>• {t('这些设置会立即应用到所有文件列表视图')}</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  )
}
