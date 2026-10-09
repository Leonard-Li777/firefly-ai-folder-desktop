import {
  Check,
  Edit3,
  FileX,
  Filter,
  FolderX,
  Info,
  Plus,
  Save,
  Trash2,
  X
} from 'lucide-react'
import { IIgnoreRule } from '@firefly/types/settings-types'
import React, { useEffect, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import i18nScope from '@app/languages'
import { useSettingsStore } from '../../stores/settings-store'
import { useVoerkaI18n } from '@voerkai18n/react'

/**
 * 编辑规则表单组件
 */
interface EditRuleFormProps {
  rule: IIgnoreRule
  onSave: (updates: Partial<IIgnoreRule>) => void
  onCancel: () => void
}

const EditRuleForm: React.FC<EditRuleFormProps> = ({ rule, onSave, onCancel }) => {
  const { t } = useVoerkaI18n(i18nScope)
  const [editedRule, setEditedRule] = useState({
    type: rule.type,
    value: rule.value,
    description: rule.description || '',
    isCzkawka: rule.isCzkawka ?? false
  })

  const handleSave = () => {
    onSave(editedRule)
  }

  return (
    <div className="flex-1 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Select
            value={editedRule.type}
            onValueChange={value =>
              setEditedRule({ ...editedRule, type: value as IIgnoreRule['type'] })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="file">{t('文件')}</SelectItem>
              <SelectItem value="directory">{t('目录')}</SelectItem>
              <SelectItem value="extension">{t('扩展名')}</SelectItem>
              <SelectItem value="wildcard">{t('通配符')}</SelectItem>
              <SelectItem value="regex">{t('正则表达式')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Input
            value={editedRule.value}
            onChange={e => setEditedRule({ ...editedRule, value: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Input
          placeholder={t('描述（可选）')}
          value={editedRule.description}
          onChange={e => setEditedRule({ ...editedRule, description: e.target.value })}
        />
      </div>
      <div className="flex items-center space-x-2">
        <input
          type="checkbox"
          id={`edit-rule-czkawka-${rule.id}`}
          checked={editedRule.isCzkawka}
          onChange={e => setEditedRule({ ...editedRule, isCzkawka: e.target.checked })}
          className="rounded border-gray-300 text-primary focus:ring-primary h-4 w-4"
        />
        <Label htmlFor={`edit-rule-czkawka-${rule.id}`} className="text-xs cursor-pointer select-none">
          {t('清理与查重时原生排除保护')}
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={!editedRule.value?.trim()}>
          <Save className="h-4 w-4 mr-1" />
          {t('保存')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          <X className="h-4 w-4 mr-1" />
          {t('取消')}
        </Button>
      </div>
    </div>
  )
}

/**
 * AI分析忽略规则设置组件
 */
export const AnalysisIgnoreRulesSettings: React.FC = () => {
  const ignoreRules = useSettingsStore(s => s.ignoreRules)
  const addIgnoreRule = useSettingsStore(s => s.addIgnoreRule)
  const updateIgnoreRule = useSettingsStore(s => s.updateIgnoreRule)
  const removeIgnoreRule = useSettingsStore(s => s.removeIgnoreRule)
  const loadIgnoreRules = useSettingsStore(s => s.loadIgnoreRules)
  const { t } = useVoerkaI18n(i18nScope)

  const [editingRule, setEditingRule] = useState<string | null>(null)
  const [newRule, setNewRule] = useState<Partial<IIgnoreRule>>({
    type: 'file',
    value: '',
    isSystem: false,
    isActive: true
  })
  const [showAddRule, setShowAddRule] = useState(false)
  const [ruleFilter, setRuleFilter] = useState<'all' | 'custom' | 'system'>('all')

  useEffect(() => {
    loadIgnoreRules()
  }, [])

  /**
   * 处理添加忽略规则
   */
  const handleAddRule = () => {
    if (!newRule.value?.trim()) return

    addIgnoreRule({
      type: newRule.type!,
      value: newRule.value.trim(),
      description: newRule.description,
      isCzkawka: newRule.isCzkawka,
      isSystem: false,
      isActive: true
    })

    setNewRule({
      type: 'file',
      value: '',
      isSystem: false,
      isActive: true
    })
    setShowAddRule(false)
  }

  const handleEditRule = (ruleId: string) => {
    setEditingRule(ruleId)
  }

  const handleSaveRule = (ruleId: string, updates: Partial<IIgnoreRule>) => {
    updateIgnoreRule(ruleId, updates)
    setEditingRule(null)
  }

  const handleCancelEdit = () => {
    setEditingRule(null)
  }

  const getRuleTypeIcon = (type: IIgnoreRule['type']) => {
    switch (type) {
      case 'file':
        return <FileX className="h-4 w-4" />
      case 'directory':
        return <FolderX className="h-4 w-4" />
      case 'extension':
        return <Filter className="h-4 w-4" />
      case 'regex':
        return <Filter className="h-4 w-4" />
      case 'wildcard':
        return <Filter className="h-4 w-4" />
      default:
        return <FileX className="h-4 w-4" />
    }
  }

  const getRuleTypeLabel = (type: IIgnoreRule['type']) => {
    const labels: Record<string, string> = {
      file: t('文件'),
      directory: t('目录'),
      extension: t('扩展名'),
      wildcard: t('通配符'),
      regex: t('正则表达式')
    }
    return labels[type] || type
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('AI分析忽略规则')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('配置不需要进行AI分析的文件与目录，提高分析效率并支持查重清理保护')}
        </p>
      </div>

      <Card className="p-0 overflow-hidden">
        {/* 顶部栏：统计信息与操作按钮 */}
        <div className="flex items-center justify-between gap-4 p-5 border-b border-border/60">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary mt-0.5">
              <Filter className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Label className="text-base font-semibold leading-none">{t('忽略规则列表')}</Label>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                  {t('{total} 条 · {active} 启用', {
                    total: ignoreRules.length,
                    active: ignoreRules.filter(r => r.isActive).length
                  })}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                {t('匹配规则的文件或目录将在分析时被跳过')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant={showAddRule ? 'secondary' : 'default'}
              className="h-8 gap-1.5 px-3 text-xs"
              onClick={() => setShowAddRule(!showAddRule)}
            >
              {showAddRule ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {showAddRule ? t('取消添加') : t('添加规则')}
            </Button>
          </div>
        </div>

        {/* 添加新规则表单 */}
        {showAddRule && (
          <div className="p-4 border-b border-border/60 bg-muted/20">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="new-rule-type">{t('类型')}</Label>
                  <Select
                    value={newRule.type}
                    onValueChange={value =>
                      setNewRule({ ...newRule, type: value as IIgnoreRule['type'] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="file">{t('文件')}</SelectItem>
                      <SelectItem value="directory">{t('目录')}</SelectItem>
                      <SelectItem value="extension">{t('扩展名')}</SelectItem>
                      <SelectItem value="wildcard">{t('通配符')}</SelectItem>
                      <SelectItem value="regex">{t('正则表达式')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="new-rule-value">{t('值')}</Label>
                  <Input
                    id="new-rule-value"
                    placeholder={t('输入匹配值...')}
                    value={newRule.value}
                    onChange={e => setNewRule({ ...newRule, value: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="new-rule-desc">{t('描述（可选）')}</Label>
                <Input
                  id="new-rule-desc"
                  placeholder={t('输入规则描述...')}
                  value={newRule.description || ''}
                  onChange={e => setNewRule({ ...newRule, description: e.target.value })}
                />
              </div>
              <div className="flex items-center space-x-2 pt-1">
                <input
                  type="checkbox"
                  id="new-rule-czkawka"
                  checked={newRule.isCzkawka ?? false}
                  onChange={e => setNewRule({ ...newRule, isCzkawka: e.target.checked })}
                  className="rounded border-gray-300 text-primary focus:ring-primary h-4 w-4"
                />
                <Label htmlFor="new-rule-czkawka" className="text-xs cursor-pointer select-none">
                  {t('清理与查重时原生排除保护')}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleAddRule} disabled={!newRule.value?.trim()}>
                  <Save className="h-4 w-4 mr-1" />
                  {t('保存')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowAddRule(false)}>
                  <X className="h-4 w-4 mr-1" />
                  {t('取消')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 筛选过滤栏 */}
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border/40 bg-muted/10">
          {(
            [
              { key: 'all', label: t('全部') },
              { key: 'custom', label: t('自定义') },
              { key: 'system', label: t('内置') }
            ] as const
          ).map(item => (
            <button
              key={item.key}
              type="button"
              onClick={() => setRuleFilter(item.key)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                ruleFilter === item.key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80'
              }`}
            >
              {item.label}
              <span className="ml-1 opacity-70">
                {item.key === 'all'
                  ? ignoreRules.length
                  : item.key === 'custom'
                    ? ignoreRules.filter(r => !r.isSystem).length
                    : ignoreRules.filter(r => r.isSystem).length}
              </span>
            </button>
          ))}
        </div>

        {/* 规则项列表 */}
        <div className="p-4 space-y-2">
          {(() => {
            const filtered = [...ignoreRules]
              .filter(rule => {
                if (ruleFilter === 'custom') return !rule.isSystem
                if (ruleFilter === 'system') return !!rule.isSystem
                return true
              })
              .sort((a, b) => {
                // 内置规则排在后面
                if (a.isSystem && !b.isSystem) return 1
                if (!a.isSystem && b.isSystem) return -1
                return 0
              })

            if (filtered.length === 0) {
              return (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  {ruleFilter === 'custom'
                    ? t('暂无自定义规则，点击上方「添加规则」创建')
                    : t('暂无匹配规则')}
                </div>
              )
            }

            return filtered.map(rule => (
              <div
                key={rule.id}
                className={`flex items-center gap-2 px-3 py-2.5 border rounded-lg bg-card transition-colors hover:bg-muted/20 ${
                  editingRule === rule.id ? 'border-primary/40 bg-primary/5' : ''
                }`}
              >
                {editingRule === rule.id ? (
                  <EditRuleForm
                    rule={rule}
                    onSave={updates => handleSaveRule(rule.id, updates)}
                    onCancel={handleCancelEdit}
                  />
                ) : (
                  <>
                    <div className="flex items-center gap-2 shrink-0">
                      {getRuleTypeIcon(rule.type)}
                      <span className="text-[11px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                        {getRuleTypeLabel(rule.type)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm flex items-center gap-1.5">
                        <span className="truncate" title={rule.value}>
                          {rule.value}
                        </span>
                        {rule.isCzkawka && (
                          <span className="text-[10px] shrink-0 bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded font-normal">
                            {t('排除清理')}
                          </span>
                        )}
                        {rule.isSystem && (
                          <span className="text-[10px] shrink-0 text-muted-foreground px-1.5 py-0.5 rounded border border-border">
                            {t('内置')}
                          </span>
                        )}
                      </div>
                      {rule.description && (
                        <div className="text-xs text-muted-foreground truncate" title={rule.description}>
                          {rule.description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Switch
                        checked={rule.isActive}
                        onCheckedChange={checked =>
                          updateIgnoreRule(rule.id, { isActive: checked })
                        }
                        disabled={rule.isSystem}
                      />
                      {!rule.isSystem && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => handleEditRule(rule.id)}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                            onClick={() => removeIgnoreRule(rule.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))
          })()}
        </div>
      </Card>

      {/* 底部说明 */}
      <div className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
        <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
        <p>
          {t('内置规则不可删除；通配符支持 * 和 ?，正则表达式支持更复杂的路径匹配模式。')}
        </p>
      </div>
    </div>
  )
}

export default AnalysisIgnoreRulesSettings
